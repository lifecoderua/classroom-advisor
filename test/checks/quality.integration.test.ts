import { describe, expect, it as itBase } from "vitest";
import type { TurnedInInput } from "../../src/checks/heuristics.ts";
import { turnedInSignals } from "../../src/checks/heuristics.ts";
import { buildReviewInput, reviewPrompt } from "../../src/checks/quality.ts";
import { ClaudeCliProvider } from "../../src/llm/index.ts";

// Opt-in: runs the review.v5 prompt through the real `claude` CLI on synthetic Ukrainian
// homework (costs tokens). `CA_LLM_IT=1 pnpm test quality.integration`.
const enabled = process.env.CA_LLM_IT === "1";
const it = enabled ? itBase : itBase.skip;
const provider = new ClaudeCliProvider({
  bin: process.env.CA_CLAUDE_BIN || "claude",
  model: process.env.CA_CLAUDE_MODEL || "haiku",
  timeoutMs: 180_000,
});
const T = new Date("2026-10-01T15:00:00Z");
const CYRILLIC = /\p{Script=Cyrillic}/u;

async function review(snapshot: TurnedInInput) {
  const out = await provider.review(buildReviewInput(snapshot, turnedInSignals(snapshot)), {
    instructions: reviewPrompt(),
  });
  if (process.env.CA_LLM_IT_VERBOSE) console.log(JSON.stringify(out, null, 2));
  return out;
}

const math = (work: string): TurnedInInput => ({
  assignment: {
    kind: "assignment",
    title: "Математика. Додавання і віднімання",
    instructions:
      "Розв'яжи приклади у документі та прикріпи його.\n1) 7 + 5\n2) 13 - 6\n3) 8 + 9\n4) 15 - 7",
    materials: [],
    courseName: "Математика 2-Б",
  },
  submission: {
    state: "turned_in",
    turnedInAt: T,
    attachments: [{ kind: "doc", title: "Відповіді", text: work }],
  },
});

describe("review.v5 live (claude-cli)", () => {
  it("flags missing and wrong tasks, in Ukrainian", async () => {
    const out = await review(math("1) 7 + 5 = 12\n2) 13 - 6 = 8"));
    expect(out.verdict).not.toBe("ok");
    expect(out.missingParts.join(" ")).toMatch(/3|4/);
    expect(out.summaryForParent).toMatch(CYRILLIC);
  }, 200_000);

  it("treats recommended homework as required: partial work is not ok", async () => {
    const snapshot = math("1) 7 + 5 = 12");
    snapshot.assignment.instructions = `Рекомендовано для виконання вдома.\n${snapshot.assignment.instructions}`;
    const out = await review(snapshot);
    expect(out.verdict).not.toBe("ok");
  }, 200_000);

  it("accepts complete, correct work", async () => {
    const out = await review(math("1) 7 + 5 = 12\n2) 13 - 6 = 7\n3) 8 + 9 = 17\n4) 15 - 7 = 8"));
    expect(out.verdict).toBe("ok");
    expect(out.addressesAssignment).toBe(true);
  }, 200_000);

  it("does not panic on an online test with no attachments", async () => {
    const out = await review({
      assignment: {
        kind: "assignment",
        title: "Тест: Звуки і букви",
        instructions:
          "Пройди онлайн-тест на Naurok за посиланням. Скриншот результату за бажанням.",
        materials: [{ kind: "link", title: "naurok.com.ua/test/..." }],
        courseName: "Українська мова 2-Б",
      },
      submission: { state: "turned_in", turnedInAt: T, attachments: [] },
    });
    expect(out.verdict).not.toBe("panic");
    // The score lives on the platform: "check by hand", not a warn.
    expect(out.unverifiable.length).toBeGreaterThan(0);
  }, 200_000);

  it("reviews the readable part without warning about an unreadable attachment", async () => {
    const snapshot = math("1) 7 + 5 = 12\n2) 13 - 6 = 7\n3) 8 + 9 = 17\n4) 15 - 7 = 8");
    const out = await review({
      ...snapshot,
      submission: {
        ...snapshot.submission,
        attachments: [
          ...snapshot.submission.attachments,
          { kind: "file", title: "запис.m4a", unreadable: "audio recording: needs listening" },
        ],
      },
    });
    expect(out.verdict).toBe("ok");
  }, 200_000);

  it("flags work) that doesn't match the assignment", async () => {
    const out = await review({
      assignment: {
        kind: "assignment",
        title: "Читання. Казка «Колосок»",
        instructions:
          "Прочитай казку «Колосок» і письмово дай відповіді: 1) Хто знайшов колосок? 2) Чому мишенята не отримали пиріжків?",
        materials: [],
        courseName: "Літературне читання",
      },
      submission: {
        state: "turned_in",
        turnedInAt: T,
        attachments: [{ kind: "doc", title: "Документ без назви", text: "аааа ываыва 123 ок" }],
      },
    });
    expect(out.verdict).toBe("panic");
  }, 200_000);
});
