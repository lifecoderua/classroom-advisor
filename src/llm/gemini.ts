import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import {
  ApiError,
  type GenerateContentConfig,
  type GenerateContentResponse,
  GoogleGenAI,
  type Part,
} from "@google/genai";
import { DEFAULT_GEMINI_MODEL } from "../config/index.ts";
import {
  buildCorrectivePrompt,
  buildPrompt,
  extractJson,
  formatZodIssues,
  imagePaths,
} from "./prompt.ts";
import {
  LlmError,
  type LlmProvider,
  type ReviewInput,
  type ReviewOptions,
  type ReviewOutput,
  reviewOutputJsonSchema,
  reviewOutputSchema,
} from "./types.ts";

export { DEFAULT_GEMINI_MODEL };

/** Image types the Gemini API accepts inline. */
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
};

/** HTTP statuses worth retrying with backoff: timeouts, rate limits, server errors. */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export interface BackoffOptions {
  /** Retries after the first attempt (so `maxRetries + 1` requests at most). */
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  maxRetries: 4,
  baseDelayMs: 2_000,
  maxDelayMs: 60_000,
};

export interface GeminiOptions {
  apiKey: string;
  model?: string | undefined;
  timeoutMs: number;
  backoff?: Partial<BackoffOptions> | undefined;
  /** HTTP layer for the SDK; tests stub it. Defaults to global `fetch`. */
  fetch?: typeof fetch | undefined;
  /** Delay between retries; tests stub it. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Jitter source in [0, 1); tests stub it. */
  random?: (() => number) | undefined;
}

/**
 * `ReviewOutput` as a Gemini `responseJsonSchema`. The API supports a JSON Schema subset;
 * `$schema` is not part of it, everything else zod emits for this schema is.
 */
export const geminiResponseSchema: Record<string, unknown> = (() => {
  const { $schema: _, ...rest } = reviewOutputJsonSchema as Record<string, unknown>;
  return rest;
})();

/** Full-jitter exponential backoff, at least the server's hint when it gave one. */
export function backoffDelay(
  attempt: number,
  opts: BackoffOptions,
  random: () => number,
  serverHintMs?: number,
): number {
  const exp = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** attempt);
  const jittered = Math.round(exp / 2 + random() * (exp / 2));
  return Math.min(opts.maxDelayMs, Math.max(jittered, serverHintMs ?? 0));
}

/** `RetryInfo.retryDelay` (e.g. `"17s"`) from a Gemini error body, in ms. */
export function retryDelayHint(message: string): number | undefined {
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(message);
  return m?.[1] ? Math.ceil(Number(m[1]) * 1000) : undefined;
}

class InvalidOutput extends Error {}
class Retryable extends Error {
  constructor(
    message: string,
    readonly hintMs?: number,
  ) {
    super(message);
  }
}

const trim = (s: string, n = 1_000) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Turns a Gemini response into a validated `ReviewOutput`. */
export function parseGeminiResponse(res: GenerateContentResponse): ReviewOutput {
  const blocked = res.promptFeedback?.blockReason;
  if (blocked) throw new LlmError(`Gemini blocked the prompt (${blocked})`);
  const text = res.text;
  if (!text) {
    const reason = res.candidates?.[0]?.finishReason ?? "no candidates";
    throw new InvalidOutput(`empty response (finishReason ${reason})`);
  }
  let payload: unknown;
  try {
    payload = extractJson(text);
  } catch (err) {
    throw new InvalidOutput((err as Error).message);
  }
  const parsed = reviewOutputSchema.safeParse(payload);
  if (!parsed.success) throw new InvalidOutput(formatZodIssues(parsed.error));
  return parsed.data;
}

async function imageParts(paths: string[]): Promise<Part[]> {
  return Promise.all(
    paths.map(async (p) => {
      const mimeType = IMAGE_MIME[extname(p).toLowerCase()];
      if (!mimeType) throw new LlmError(`unsupported image type for Gemini: ${p}`);
      let data: Buffer;
      try {
        data = await readFile(p);
      } catch (err) {
        throw new LlmError(`cannot read image ${p}: ${(err as Error).message}`);
      }
      return { inlineData: { mimeType, data: data.toString("base64") } };
    }),
  );
}

export class GeminiProvider implements LlmProvider {
  readonly name = "gemini";
  readonly model: string;
  private readonly client: GoogleGenAI;
  private readonly backoff: BackoffOptions;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(private readonly opts: GeminiOptions) {
    if (!opts.apiKey) throw new LlmError("GEMINI_API_KEY is not set");
    this.model = opts.model ?? DEFAULT_GEMINI_MODEL;
    this.backoff = { ...DEFAULT_BACKOFF, ...opts.backoff };
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = opts.random ?? Math.random;
    this.client = new GoogleGenAI({
      apiKey: opts.apiKey,
      // SDK retries stay off (no retryOptions): backoff is handled here.
      ...(opts.fetch ? { httpOptions: { fetch: opts.fetch } } : {}),
    });
  }

  async review(input: ReviewInput, options: ReviewOptions = {}): Promise<ReviewOutput> {
    const timeoutMs = options.timeoutMs ?? this.opts.timeoutMs;
    const prompt = buildPrompt(input, options.instructions, "inline");
    const images = await imageParts(imagePaths(input));
    try {
      return await this.call(prompt, images, timeoutMs);
    } catch (err) {
      if (!(err instanceof InvalidOutput)) throw err;
      try {
        return await this.call(buildCorrectivePrompt(prompt, err.message), images, timeoutMs);
      } catch (retryErr) {
        if (retryErr instanceof InvalidOutput) {
          throw new LlmError(`invalid model output after retry: ${retryErr.message}`);
        }
        throw retryErr;
      }
    }
  }

  /** One logical call: transient HTTP failures are retried with backoff. */
  private async call(prompt: string, images: Part[], timeoutMs: number): Promise<ReviewOutput> {
    for (let attempt = 0; ; attempt++) {
      try {
        return parseGeminiResponse(await this.request(prompt, images, timeoutMs));
      } catch (err) {
        if (!(err instanceof Retryable)) throw err;
        if (attempt >= this.backoff.maxRetries) {
          throw new LlmError(
            `Gemini request failed after ${attempt + 1} attempts: ${trim(err.message)}`,
          );
        }
        await this.sleep(backoffDelay(attempt, this.backoff, this.random, err.hintMs));
      }
    }
  }

  private async request(
    prompt: string,
    images: Part[],
    timeoutMs: number,
  ): Promise<GenerateContentResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const config: GenerateContentConfig = {
      responseMimeType: "application/json",
      responseJsonSchema: geminiResponseSchema,
      abortSignal: controller.signal,
    };
    try {
      return await this.client.models.generateContent({
        model: this.model,
        contents: [{ role: "user", parts: [{ text: prompt }, ...images] }],
        config,
      });
    } catch (err) {
      if (controller.signal.aborted) throw new LlmError(`Gemini timed out after ${timeoutMs}ms`);
      if (err instanceof ApiError) {
        if (RETRYABLE_STATUS.has(err.status)) {
          throw new Retryable(`HTTP ${err.status}: ${err.message}`, retryDelayHint(err.message));
        }
        throw new LlmError(`Gemini API error (HTTP ${err.status}): ${trim(err.message)}`);
      }
      // Network-level failure (DNS, reset): transient.
      if (err instanceof TypeError) throw new Retryable(err.message);
      throw new LlmError(`Gemini request failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
