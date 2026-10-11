import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  ClaudeCliProvider,
  GeminiProvider,
  LlmError,
  type LlmProvider,
  type ReviewInput,
  type ReviewOutput,
  type RunRequest,
  type RunResult,
} from "../src/llm/index.ts";

/**
 * Shared behavioral contract for real providers. Each harness scripts the model's side
 * through its injected transport (claude-cli: command runner; gemini: the SDK's fetch).
 */

type Step = { text: string } | { fail: "fatal" } | { fail: "timeout" };

interface Harness {
  name: string;
  make(steps: Step[], timeoutMs?: number): Scripted;
}

interface Scripted {
  provider: LlmProvider;
  /** Prompt text of each request sent. */
  prompts(): string[];
  /** Whether the model was given access to this image in request `i`. */
  sawImage(i: number, path: string): boolean;
}

const dir = mkdtempSync(join(tmpdir(), "ca-llm-contract-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const imagePath = join(dir, "notebook.png");
const imageBytes = Buffer.from("fake-png-bytes");
writeFileSync(imagePath, imageBytes);

const input: ReviewInput = {
  assignment: {
    title: "Fractions practice",
    instructions: "Solve exercises 1-3 and upload a photo of your notebook.",
    kind: "assignment",
    courseName: "Math 3",
  },
  materials: [],
  submission: {
    attachments: [{ title: "Notebook photo", kind: "image", imagePath }],
    turnedInAt: "2026-01-14T18:00:00Z",
  },
  signals: [],
  locale: "en",
};

const good: ReviewOutput = {
  verdict: "warn",
  addressesAssignment: true,
  missingParts: ["exercise 3"],
  issues: [{ severity: "medium", text: "Exercise 3 is missing." }],
  summaryForParent: "Two of three exercises done.",
  confidence: 0.7,
  unverifiable: [],
};

const claudeHarness: Harness = {
  name: "claude-cli",
  make(steps, timeoutMs = 5_000) {
    const reqs: RunRequest[] = [];
    const runner = async (_bin: string, req: RunRequest): Promise<RunResult> => {
      reqs.push(req);
      const step = steps.shift();
      if (!step) throw new Error("unexpected call");
      if ("text" in step) {
        const stdout = JSON.stringify({ type: "result", is_error: false, result: step.text });
        return { code: 0, stdout, stderr: "", timedOut: false };
      }
      if (step.fail === "timeout") return { code: null, stdout: "", stderr: "", timedOut: true };
      return { code: 1, stdout: "", stderr: "Error: not logged in", timedOut: false };
    };
    return {
      provider: new ClaudeCliProvider({ bin: "claude", timeoutMs, runner }),
      prompts: () => reqs.map((r) => r.stdin),
      sawImage: (i, path) => {
        const req = reqs[i];
        if (!req) return false;
        const dirs = req.args.slice(req.args.indexOf("--add-dir") + 1);
        return (
          req.stdin.includes(path) && req.args.includes("Read") && dirs.includes(dirname(path))
        );
      },
    };
  },
};

interface GeminiBody {
  contents: { parts: { text?: string; inlineData?: { mimeType: string; data: string } }[] }[];
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const geminiText = (text: string) =>
  json(200, {
    candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
  });

const geminiHarness: Harness = {
  name: "gemini",
  make(steps, timeoutMs = 5_000) {
    const bodies: GeminiBody[] = [];
    const fetchStub = async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as GeminiBody);
      const step = steps.shift();
      if (!step) throw new Error("unexpected call");
      if ("text" in step) return geminiText(step.text);
      if (step.fail === "timeout") {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        });
      }
      return json(400, { error: { code: 400, message: "API key not valid", status: "INVALID" } });
    };
    return {
      provider: new GeminiProvider({
        apiKey: "test-key",
        timeoutMs,
        fetch: fetchStub as typeof fetch,
        sleep: async () => {},
      }),
      prompts: () => bodies.map((b) => b.contents[0]?.parts[0]?.text ?? ""),
      sawImage: (i, path) => {
        const parts = bodies[i]?.contents[0]?.parts ?? [];
        const text = parts[0]?.text ?? "";
        return (
          text.includes(path) &&
          parts.some(
            (p) =>
              p.inlineData?.mimeType === "image/png" &&
              p.inlineData.data === imageBytes.toString("base64"),
          )
        );
      },
    };
  },
};

describe.each([claudeHarness, geminiHarness])("LlmProvider contract: $name", (h) => {
  it("returns validated output and puts the caller's instructions first", async () => {
    const s = h.make([{ text: JSON.stringify(good) }]);
    await expect(s.provider.review(input, { instructions: "Task." })).resolves.toEqual(good);
    expect(s.prompts()).toHaveLength(1);
    expect(s.prompts()[0]?.startsWith("Task.")).toBe(true);
    expect(s.prompts()[0]).toContain('"Fractions practice"');
  });

  it("gives the model the attachment images", async () => {
    const s = h.make([{ text: JSON.stringify(good) }]);
    await s.provider.review(input);
    expect(s.sawImage(0, imagePath)).toBe(true);
  });

  it("tolerates fenced JSON", async () => {
    const s = h.make([{ text: `\`\`\`json\n${JSON.stringify(good)}\n\`\`\`` }]);
    await expect(s.provider.review(input)).resolves.toEqual(good);
  });

  it("retries once with a corrective prompt on invalid output", async () => {
    const s = h.make([{ text: '{"verdict":"maybe"}' }, { text: JSON.stringify(good) }]);
    await expect(s.provider.review(input)).resolves.toEqual(good);
    expect(s.prompts()).toHaveLength(2);
    expect(s.prompts()[1]).toContain("## Correction");
    expect(s.prompts()[1]).toContain("verdict");
    expect(s.sawImage(1, imagePath)).toBe(true);
  });

  it("fails with LlmError after a second invalid output", async () => {
    const s = h.make([{ text: "not json" }, { text: "still not json" }]);
    await expect(s.provider.review(input)).rejects.toThrow(/invalid model output after retry/);
    expect(s.prompts()).toHaveLength(2);
  });

  it("surfaces hard failures as LlmError without a corrective retry", async () => {
    const s = h.make([{ fail: "fatal" }]);
    await expect(s.provider.review(input)).rejects.toThrow(LlmError);
    expect(s.prompts()).toHaveLength(1);
  });

  it("reports timeouts as LlmError", async () => {
    const s = h.make([{ fail: "timeout" }], 20);
    await expect(s.provider.review(input)).rejects.toThrow(/timed out after 20ms/);
    expect(s.prompts()).toHaveLength(1);
  });
});
