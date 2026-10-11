import { describe, expect, it } from "vitest";
import {
  backoffDelay,
  DEFAULT_BACKOFF,
  DEFAULT_GEMINI_MODEL,
  GeminiProvider,
  geminiResponseSchema,
  LlmError,
  type ReviewInput,
  type ReviewOutput,
  retryDelayHint,
} from "../src/llm/index.ts";

const input: ReviewInput = {
  assignment: {
    title: "Essay",
    instructions: "Write 3 lines.",
    kind: "assignment",
    courseName: "L",
  },
  materials: [],
  submission: { attachments: [{ title: "a.txt", kind: "doc", text: "one" }], turnedInAt: "x" },
  signals: [],
};

const good: ReviewOutput = {
  verdict: "ok",
  addressesAssignment: true,
  missingParts: [],
  issues: [],
  summaryForParent: "Fine.",
  confidence: 0.8,
  unverifiable: [],
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ok = (text: string) =>
  json(200, { candidates: [{ content: { role: "model", parts: [{ text }] } }] });
const err = (status: number, extra: unknown[] = []) =>
  json(status, { error: { code: status, message: "boom", status: "X", details: extra } });

function setup(responses: (() => Response)[], opts: { maxRetries?: number; model?: string } = {}) {
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const delays: number[] = [];
  const fetchStub = async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error("unexpected call");
    return next();
  };
  const provider = new GeminiProvider({
    apiKey: "test-key",
    model: opts.model,
    timeoutMs: 5_000,
    fetch: fetchStub as typeof fetch,
    backoff: { maxRetries: opts.maxRetries ?? 3, baseDelayMs: 100, maxDelayMs: 10_000 },
    sleep: async (ms) => {
      delays.push(ms);
    },
    random: () => 0.5,
  });
  return { provider, requests, delays };
}

describe("GeminiProvider request", () => {
  it("posts generateContent with a JSON schema, defaulting to the free-tier Flash model", async () => {
    const { provider, requests } = setup([() => ok(JSON.stringify(good))]);
    await expect(provider.review(input)).resolves.toEqual(good);
    const { url, init } = requests[0] ?? expect.unreachable();
    expect(url).toContain(`models/${DEFAULT_GEMINI_MODEL}:generateContent`);
    expect(url).not.toContain("test-key");
    const body = JSON.parse(String(init?.body));
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseJsonSchema).toEqual(geminiResponseSchema);
    expect(body.contents[0].parts).toHaveLength(1); // no images
  });

  it("uses the configured model", async () => {
    const { provider, requests } = setup([() => ok(JSON.stringify(good))], { model: "gemini-y" });
    await provider.review(input);
    expect(requests[0]?.url).toContain("models/gemini-y:generateContent");
  });

  it("drops $schema from the response schema", () => {
    expect(geminiResponseSchema).not.toHaveProperty("$schema");
    expect(geminiResponseSchema.type).toBe("object");
  });

  it("requires an API key", () => {
    expect(() => new GeminiProvider({ apiKey: "", timeoutMs: 1 })).toThrow(/GEMINI_API_KEY/);
  });

  it("rejects image types Gemini does not take inline", async () => {
    const { provider, requests } = setup([]);
    const withGif = {
      ...input,
      submission: {
        ...input.submission,
        attachments: [{ title: "x", kind: "image", imagePath: "/nope/x.gif" }],
      },
    };
    await expect(provider.review(withGif)).rejects.toThrow(/unsupported image type/);
    expect(requests).toHaveLength(0);
  });

  it("reports a blocked prompt without retrying", async () => {
    const { provider, requests } = setup([
      () => json(200, { promptFeedback: { blockReason: "SAFETY" } }),
    ]);
    await expect(provider.review(input)).rejects.toThrow(/blocked the prompt \(SAFETY\)/);
    expect(requests).toHaveLength(1);
  });
});

describe("GeminiProvider backoff", () => {
  it("retries 429 and 5xx with backoff, honoring the server's retryDelay", async () => {
    const retryInfo = { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "3s" };
    const { provider, requests, delays } = setup([
      () => err(429, [retryInfo]),
      () => err(503),
      () => ok(JSON.stringify(good)),
    ]);
    await expect(provider.review(input)).resolves.toEqual(good);
    expect(requests).toHaveLength(3);
    expect(delays).toEqual([3_000, 150]); // hint wins; then 100*2^1 with jitter 0.5 → 150
  });

  it("gives up after maxRetries", async () => {
    const { provider, requests } = setup([() => err(500), () => err(500), () => err(500)], {
      maxRetries: 2,
    });
    await expect(provider.review(input)).rejects.toThrow(/failed after 3 attempts: HTTP 500/);
    expect(requests).toHaveLength(3);
  });

  it("does not retry other 4xx", async () => {
    const { provider, requests } = setup([() => err(403)]);
    await expect(provider.review(input)).rejects.toThrow(LlmError);
    await expect(setup([() => err(403)]).provider.review(input)).rejects.toThrow(/HTTP 403/);
    expect(requests).toHaveLength(1);
  });

  it("retries network errors", async () => {
    const { provider, requests } = setup([
      () => {
        throw new TypeError("fetch failed");
      },
      () => ok(JSON.stringify(good)),
    ]);
    await expect(provider.review(input)).resolves.toEqual(good);
    expect(requests).toHaveLength(2);
  });
});

describe("backoffDelay", () => {
  const opts = { ...DEFAULT_BACKOFF, baseDelayMs: 1_000, maxDelayMs: 8_000 };
  it("grows exponentially with full jitter in [exp/2, exp], capped", () => {
    expect(backoffDelay(0, opts, () => 0)).toBe(500);
    expect(backoffDelay(0, opts, () => 0.999)).toBeCloseTo(1_000, -1);
    expect(backoffDelay(2, opts, () => 0)).toBe(2_000);
    expect(backoffDelay(10, opts, () => 0.999)).toBeLessThanOrEqual(8_000);
  });
  it("respects but caps the server hint", () => {
    expect(backoffDelay(0, opts, () => 0, 5_000)).toBe(5_000);
    expect(backoffDelay(0, opts, () => 0, 99_000)).toBe(8_000);
  });
  it("parses retryDelay from an error body", () => {
    expect(retryDelayHint('{"retryDelay": "17s"}')).toBe(17_000);
    expect(retryDelayHint('{"retryDelay":"0.5s"}')).toBe(500);
    expect(retryDelayHint("nothing")).toBeUndefined();
  });
});
