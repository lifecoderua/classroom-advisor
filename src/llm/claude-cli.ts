import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

export interface RunRequest {
  args: string[];
  stdin: string;
  cwd: string;
  timeoutMs: number;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Runs a command; injectable so tests can stub the CLI. */
export type Runner = (bin: string, req: RunRequest) => Promise<RunResult>;

export const spawnRunner: Runner = (bin, { args, stdin, cwd, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      stdout += d;
    });
    child.stderr.setEncoding("utf8").on("data", (d: string) => {
      stderr += d;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new LlmError(`failed to start '${bin}': ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.stdin.on("error", () => {
      // EPIPE if the process exits early; the close handler reports it.
    });
    child.stdin.end(stdin);
  });

export interface ClaudeCliOptions {
  bin: string;
  model?: string | undefined;
  timeoutMs: number;
  runner?: Runner | undefined;
}

/** The `claude -p` argv for one call. Images enable only the Read tool, scoped to their dirs. */
export function buildClaudeArgs(opts: {
  model?: string | undefined;
  imageDirs: string[];
}): string[] {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(reviewOutputJsonSchema),
    "--no-session-persistence",
    "--strict-mcp-config",
  ];
  if (opts.model) args.push("--model", opts.model);
  if (opts.imageDirs.length > 0) {
    args.push("--tools", "Read", "--allowedTools", "Read", "--add-dir", ...opts.imageDirs);
  } else {
    args.push("--tools", "");
  }
  return args;
}

class InvalidOutput extends Error {}

const tail = (s: string, n = 2_000) => (s.length > n ? `…${s.slice(-n)}` : s).trim();

/** Turns the CLI's JSON envelope into a validated `ReviewOutput`. */
export function parseEnvelope(stdout: string): ReviewOutput {
  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    throw new LlmError(`claude CLI returned non-JSON output: ${tail(stdout, 500)}`);
  }
  if (envelope.is_error === true) {
    throw new LlmError(
      `claude CLI reported an error (${String(envelope.subtype ?? "unknown")}): ${String(envelope.result ?? "")}`,
    );
  }
  let payload: unknown = envelope.structured_output;
  if (payload === undefined || payload === null) {
    if (typeof envelope.result !== "string") throw new InvalidOutput("empty result");
    try {
      payload = extractJson(envelope.result);
    } catch (err) {
      throw new InvalidOutput((err as Error).message);
    }
  }
  const parsed = reviewOutputSchema.safeParse(payload);
  if (!parsed.success) throw new InvalidOutput(formatZodIssues(parsed.error));
  return parsed.data;
}

export class ClaudeCliProvider implements LlmProvider {
  readonly name = "claude-cli";
  private readonly runner: Runner;

  constructor(private readonly opts: ClaudeCliOptions) {
    this.runner = opts.runner ?? spawnRunner;
  }

  async review(input: ReviewInput, options: ReviewOptions = {}): Promise<ReviewOutput> {
    const timeoutMs = options.timeoutMs ?? this.opts.timeoutMs;
    const images = imagePaths(input);
    const args = buildClaudeArgs({
      model: this.opts.model,
      imageDirs: [...new Set(images.map((p) => dirname(p)))],
    });
    const prompt = buildPrompt(input, options.instructions);

    // Empty scratch cwd: no project CLAUDE.md, nothing readable beyond --add-dir.
    const cwd = mkdtempSync(join(tmpdir(), "ca-llm-"));
    try {
      try {
        return await this.call(args, prompt, cwd, timeoutMs);
      } catch (err) {
        if (!(err instanceof InvalidOutput)) throw err;
        try {
          return await this.call(args, buildCorrectivePrompt(prompt, err.message), cwd, timeoutMs);
        } catch (retryErr) {
          if (retryErr instanceof InvalidOutput) {
            throw new LlmError(`invalid model output after retry: ${retryErr.message}`);
          }
          throw retryErr;
        }
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }

  private async call(
    args: string[],
    stdin: string,
    cwd: string,
    timeoutMs: number,
  ): Promise<ReviewOutput> {
    const res = await this.runner(this.opts.bin, { args, stdin, cwd, timeoutMs });
    if (res.timedOut) {
      throw new LlmError(
        `claude CLI timed out after ${timeoutMs}ms${res.stderr ? `: ${tail(res.stderr)}` : ""}`,
      );
    }
    if (res.code !== 0) {
      let detail = tail(res.stderr);
      try {
        const env = JSON.parse(res.stdout) as { result?: unknown };
        if (typeof env.result === "string") detail = `${env.result}\n${detail}`.trim();
      } catch {
        if (!detail) detail = tail(res.stdout, 500);
      }
      throw new LlmError(`claude CLI exited with code ${res.code}: ${detail || "(no output)"}`);
    }
    return parseEnvelope(res.stdout);
  }
}
