import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildClaudeArgs,
  buildPrompt,
  ClaudeCliProvider,
  createProvider,
  extractJson,
  FakeProvider,
  type GeminiProvider,
  LlmError,
  type ReviewInput,
  type ReviewOutput,
  type RunRequest,
  type RunResult,
  reviewInputSchema,
  reviewOutputJsonSchema,
} from "../src/llm/index.ts";

const input: ReviewInput = {
  assignment: {
    title: "Fractions practice",
    instructions: "Solve exercises 1-3 and upload a photo of your notebook.",
    kind: "assignment",
    courseName: "Math 3",
    dueAt: "2026-01-15T09:00:00Z",
  },
  materials: [{ title: "Worksheet", kind: "doc", text: "1) 1/2+1/4 2) 2/3-1/3 3) 3/4*2" }],
  submission: {
    attachments: [{ title: "Notebook photo", kind: "image", imagePath: "/data/files/a/photo.jpg" }],
    turnedInAt: "2026-01-14T18:00:00Z",
  },
  signals: [{ code: "fewer_attachments_than_expected", confidence: 0.4 }],
  locale: "en",
};

const good: ReviewOutput = {
  verdict: "warn",
  addressesAssignment: true,
  missingParts: ["exercise 3"],
  issues: [{ severity: "medium", text: "Exercise 3 is missing." }],
  summaryForParent: "Two of three exercises done.",
  confidence: 0.7,
};

const envelope = (fields: Record<string, unknown>) =>
  JSON.stringify({ type: "result", subtype: "success", is_error: false, ...fields });

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: "", timedOut: false });

function stubRunner(results: RunResult[]) {
  const calls: { bin: string; req: RunRequest }[] = [];
  const runner = async (bin: string, req: RunRequest) => {
    calls.push({ bin, req });
    const next = results.shift();
    if (!next) throw new Error("unexpected call");
    return next;
  };
  return { runner, calls };
}

const provider = (results: RunResult[], model?: string) => {
  const stub = stubRunner(results);
  return {
    ...stub,
    p: new ClaudeCliProvider({ bin: "claude-x", model, timeoutMs: 1234, runner: stub.runner }),
  };
};

describe("schemas", () => {
  it("accepts the synthetic input", () => {
    expect(reviewInputSchema.parse(input)).toEqual(input);
  });
  it("emits a draft-07 JSON Schema (claude --json-schema rejects 2020-12)", () => {
    expect(reviewOutputJsonSchema.$schema).toBe("http://json-schema.org/draft-07/schema#");
  });
});

describe("extractJson", () => {
  it("parses bare, fenced and prose-wrapped JSON", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Here you go:\n{"a":{"b":2}}\nThanks')).toEqual({ a: { b: 2 } });
  });
  it("throws when there is no object", () => {
    expect(() => extractJson("nope")).toThrow(SyntaxError);
  });
});

describe("buildPrompt", () => {
  it("wraps instructions, input, image paths and output schema", () => {
    const prompt = buildPrompt(input, "Custom task.");
    expect(prompt.startsWith("Custom task.")).toBe(true);
    expect(prompt).toContain('"Fractions practice"');
    expect(prompt).toContain("- /data/files/a/photo.jpg");
    expect(prompt).toContain('"summaryForParent"');
  });
  it("omits the images section without images", () => {
    const noImg = { ...input, submission: { ...input.submission, attachments: [] } };
    expect(buildPrompt(noImg)).not.toContain("## Images");
  });
});

describe("buildClaudeArgs", () => {
  it("disables tools without images", () => {
    const args = buildClaudeArgs({ imageDirs: [] });
    expect(args.slice(0, 3)).toEqual(["-p", "--output-format", "json"]);
    expect(args).toContain("--json-schema");
    expect(args.slice(-2)).toEqual(["--tools", ""]);
    expect(args).not.toContain("--model");
  });
  it("enables only Read scoped to image dirs, and passes the model", () => {
    const args = buildClaudeArgs({ model: "sonnet", imageDirs: ["/d1", "/d2"] });
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
    expect(args.slice(-7)).toEqual([
      "--tools",
      "Read",
      "--allowedTools",
      "Read",
      "--add-dir",
      "/d1",
      "/d2",
    ]);
  });
});

describe("ClaudeCliProvider", () => {
  it("uses structured_output from the envelope", async () => {
    const { p, calls } = provider([ok(envelope({ result: "", structured_output: good }))], "opus");
    await expect(p.review(input, { instructions: "Task." })).resolves.toEqual(good);
    expect(calls).toHaveLength(1);
    const { bin, req } = calls[0] ?? expect.unreachable();
    expect(bin).toBe("claude-x");
    expect(req.timeoutMs).toBe(1234);
    expect(req.stdin.startsWith("Task.")).toBe(true);
    expect(req.args).toContain("opus");
    expect(req.args.slice(-2)).toEqual(["--add-dir", "/data/files/a"]);
    expect(existsSync(req.cwd)).toBe(false); // scratch cwd cleaned up
  });

  it("falls back to fenced JSON in result", async () => {
    const { p } = provider([
      ok(envelope({ result: `\`\`\`json\n${JSON.stringify(good)}\n\`\`\`` })),
    ]);
    await expect(p.review(input)).resolves.toEqual(good);
  });

  it("retries once with a corrective prompt on invalid output", async () => {
    const { p, calls } = provider([
      ok(envelope({ result: '{"verdict":"maybe"}' })),
      ok(envelope({ result: JSON.stringify(good) })),
    ]);
    await expect(p.review(input, { timeoutMs: 99 })).resolves.toEqual(good);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.req.stdin).toContain("## Correction");
    expect(calls[1]?.req.stdin).toContain("verdict");
    expect(calls[1]?.req.timeoutMs).toBe(99);
  });

  it("fails after a second invalid output", async () => {
    const { p, calls } = provider([
      ok(envelope({ result: "not json" })),
      ok(envelope({ result: "still not json" })),
    ]);
    await expect(p.review(input)).rejects.toThrow(/invalid model output after retry/);
    expect(calls).toHaveLength(2);
  });

  it("surfaces stderr on non-zero exit without retrying", async () => {
    const { p, calls } = provider([
      { code: 1, stdout: "", stderr: "Error: not logged in", timedOut: false },
    ]);
    await expect(p.review(input)).rejects.toThrow(/code 1: Error: not logged in/);
    expect(calls).toHaveLength(1);
  });

  it("reports timeouts", async () => {
    const { p } = provider([{ code: null, stdout: "", stderr: "", timedOut: true }]);
    await expect(p.review(input)).rejects.toThrow(/timed out after 1234ms/);
  });

  it("reports is_error envelopes", async () => {
    const { p } = provider([
      ok(envelope({ is_error: true, subtype: "error_max_turns", result: "boom" })),
    ]);
    await expect(p.review(input)).rejects.toThrow(LlmError);
  });

  it("rejects non-JSON stdout", async () => {
    const { p } = provider([ok("garbage")]);
    await expect(p.review(input)).rejects.toThrow(/non-JSON output/);
  });
});

describe("FakeProvider", () => {
  it("returns the default, a fixed output, or a computed one, and records calls", async () => {
    const def = new FakeProvider();
    expect((await def.review(input)).verdict).toBe("ok");
    expect(def.calls).toHaveLength(1);

    const fixed = new FakeProvider({ respond: good });
    await expect(fixed.review(input)).resolves.toEqual(good);

    const fn = new FakeProvider({
      respond: (i) => ({ ...good, verdict: i.signals.length ? "panic" : "ok" }),
    });
    expect((await fn.review(input)).verdict).toBe("panic");

    const failing = new FakeProvider({ respond: () => new Error("nope") });
    await expect(failing.review(input)).rejects.toThrow("nope");
  });
});

describe("createProvider", () => {
  const base = { claudeBin: "claude", geminiModel: "gemini-x", llmTimeoutMs: 1000 } as const;
  it("selects providers from config", () => {
    expect(createProvider({ ...base, llmProvider: "claude-cli" }).name).toBe("claude-cli");
    expect(createProvider({ ...base, llmProvider: "fake" }).name).toBe("fake");
    const gemini = createProvider({ ...base, llmProvider: "gemini", geminiApiKey: "k" });
    expect(gemini.name).toBe("gemini");
    expect((gemini as GeminiProvider).model).toBe("gemini-x");
  });
  it("requires GEMINI_API_KEY for gemini", () => {
    expect(() => createProvider({ ...base, llmProvider: "gemini" })).toThrow(/GEMINI_API_KEY/);
  });
});
