import { describe, expect, it as itBase } from "vitest";
import {
  buildClassifierInput,
  type ClassifierInput,
  expectsWorkJsonSchema,
  expectsWorkOutputSchema,
  expectsWorkPrompt,
} from "../../src/checks/expects-work.ts";
import { ClaudeCliProvider } from "../../src/llm/index.ts";

// Opt-in: runs the expects-work.v1 prompt through the real `claude` CLI on synthetic lesson posts
// (costs tokens). `CA_LLM_IT=1 pnpm test expects-work.integration`.
const enabled = process.env.CA_LLM_IT === "1";
const it = enabled ? itBase : itBase.skip;
const provider = new ClaudeCliProvider({
  bin: process.env.CA_CLAUDE_BIN || "claude",
  model: process.env.CA_CLAUDE_MODEL || "haiku",
  timeoutMs: 180_000,
});

async function classify(input: ClassifierInput) {
  const out = await provider.generate({
    instructions: expectsWorkPrompt(),
    input: buildClassifierInput(input),
    schema: expectsWorkOutputSchema,
    jsonSchema: expectsWorkJsonSchema,
  });
  if (process.env.CA_LLM_IT_VERBOSE) console.log(JSON.stringify(out));
  return out.expectsWork;
}

const INVITE = [
  "Вчитель Х запрошує вас на заплановану конференцію Zoom.",
  "Тема: 6-А Технології",
  "Час: 12 жовт. 2026 10:35 AM Київ",
  "Підключитися до конференції Zoom",
  "https://us02web.zoom.us/j/81123456789?pwd=abc123",
  "Ідентифікатор конференції: 811 2345 6789",
  "Код доступу: k3Lm9",
].join("\n");

describe("expects-work.v1 live (claude-cli)", () => {
  it("a call invite alone asks for no work", async () => {
    expect(await classify({ title: "Технології 6-А", description: INVITE, attachments: [] })).toBe(
      "no",
    );
  }, 200_000);

  it("an invite with an exercise asks for work", async () => {
    const description = `${INVITE}\n\nД/з: вправа 5 на ст. 45, письмово.`;
    expect(await classify({ title: "Технології 6-А", description, attachments: [] })).toBe("yes");
  }, 200_000);

  it("a task in an attachment asks for work", async () => {
    const out = await classify({
      title: "Технології 6-А",
      description: INVITE,
      attachments: [
        { title: "Завдання", kind: "doc", text: "Намалюй ескіз виробу та підпиши його частини." },
      ],
    });
    expect(out).toBe("yes");
  }, 200_000);
});
