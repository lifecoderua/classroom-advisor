import { describe, expect, it as itBase } from "vitest";
import {
  buildClassifierInput,
  type ClassifierInput,
  expectsWorkJsonSchema,
  expectsWorkOutputSchema,
  expectsWorkPrompt,
} from "../../src/checks/expects-work.ts";
import { ClaudeCliProvider } from "../../src/llm/index.ts";

// Opt-in: runs the expects-work.v3 prompt through the real `claude` CLI on synthetic lesson posts
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

describe("expects-work.v3 live (claude-cli)", () => {
  it("a call invite alone asks for no work", async () => {
    expect(await classify({ title: "Технології 6-А", description: INVITE, attachments: [] })).toBe(
      "no",
    );
  }, 200_000);

  it("an invite with an exercise asks for work", async () => {
    const description = `${INVITE}\n\nД/з: вправа 5 на ст. 45, письмово.`;
    expect(await classify({ title: "Технології 6-А", description, attachments: [] })).toBe("yes");
  }, 200_000);

  it("recommended homework counts as work", async () => {
    const description = "Рекомендовано для виконання вдома: ст. 112, № 4, 5.";
    expect(await classify({ title: "Математика 14.10", description, attachments: [] })).toBe("yes");
  }, 200_000);

  it("a short instruction with an unreadable deck is never `no`", async () => {
    const out = await classify({
      title: "Математика 14.10 Розв'язок завдань",
      description: "Самостійно розв'язати приклади",
      attachments: [{ title: "Приклади.pptx", kind: "file", contentUnavailable: true }],
    });
    expect(out).not.toBe("no");
  }, 200_000);

  it("an invite with a lesson topic and reference videos asks for no work (#69)", async () => {
    const description = `${INVITE.replace("6-А Технології", "6-А Українська мова")}\n\nТема уроку: Складні речення. Розділові знаки.`;
    const out = await classify({
      title: "Українська мова 6-А",
      description,
      attachments: [
        { title: "Складні речення — пояснення", kind: "video", contentUnavailable: true },
        { title: "Розділові знаки у складному реченні", kind: "video", contentUnavailable: true },
      ],
    });
    expect(out).toBe("no");
  }, 200_000);

  it("a video with a task on it asks for work", async () => {
    const out = await classify({
      title: "Історія 6-А",
      description: "Переглянути відео та письмово відповісти на питання 1–3 у зошиті.",
      attachments: [{ title: "Київська Русь", kind: "video", contentUnavailable: true }],
    });
    expect(out).toBe("yes");
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
