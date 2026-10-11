import { describe, expect, it } from "vitest";
import { isRedoRequest, redoDueNote, turnedInSince } from "../../src/checks/redo.ts";
import { teacherCommentAlert } from "../../src/sync/comments.ts";

const H = 60 * 60 * 1000;
const T0 = new Date("2026-10-01T08:00:00Z");
const at = (h: number) => new Date(T0.getTime() + h * H);

describe("isRedoRequest", () => {
  it.each([
    "Переробити завдання 3",
    "переробіть, будь ласка",
    "Доробити до кінця",
    "Виправ помилки",
    "Прикріпи фото роботи",
    "Додай фото",
    "Не вистачає другої сторінки",
    "ПЕРЕДЕЛАЙ",
    "Доделай упражнение",
    "Исправьте ошибки",
    "Прикрепи фото",
    "Добавь второе фото",
    "Please redo exercise 2",
    "Fix the spelling",
    "attach the photo",
    "Resubmit with page 2",
    "Page 2 is missing",
  ])("matches %s", (text) => {
    expect(isRedoRequest(text)).toBe(true);
  });

  it.each([
    "Молодець!",
    "Добре, зараховано",
    "Виправлено, дякую",
    "Исправлено",
    "Good job",
    "Отлично",
    "prefix",
  ])("ignores %s", (text) => {
    expect(isRedoRequest(text)).toBe(false);
  });
});

describe("redo follow-up", () => {
  it("counts a later turn-in as addressing the request", () => {
    expect(turnedInSince(at(1), { state: "turned_in", turnedInAt: at(2) })).toBe(true);
    expect(turnedInSince(at(1), { state: "turned_in", turnedInAt: at(0) })).toBe(false);
    expect(turnedInSince(at(1), { state: "reclaimed", turnedInAt: at(2) })).toBe(false);
    expect(turnedInSince(at(1), { state: "turned_in", turnedInAt: null })).toBe(false);
    expect(turnedInSince(at(1), null)).toBe(false);
  });

  it("notes past-due and due-within-a-day work", () => {
    expect(redoDueNote(at(-1), T0)).toContain("past due");
    expect(redoDueNote(at(5), T0)).toContain("due within a day");
    expect(redoDueNote(at(30), T0)).toBeUndefined();
    expect(redoDueNote(null, T0)).toBeUndefined();
  });

  it("teacher comment alerts: panic for a redo request, with the due note", () => {
    const target = {
      id: 1,
      baseline: false,
      title: "Вправа",
      courseName: "Мова",
      dueAt: at(-2),
      submission: { state: "returned", turnedInAt: at(-3) },
    };
    const redo = teacherCommentAlert(target, { text: "Переробити", postedAt: at(-1) }, T0);
    expect(redo.level).toBe("panic");
    expect(redo.message).toMatch(
      /^Teacher comment on "Вправа" \(Мова\): Переробити Not turned in again since .+past due\.$/,
    );

    const turnedIn = { ...target, submission: { state: "turned_in", turnedInAt: at(-0.5) } };
    const done = teacherCommentAlert(turnedIn, { text: "Переробити", postedAt: at(-1) }, T0);
    expect(done).toEqual({
      level: "panic",
      message: 'Teacher comment on "Вправа" (Мова): Переробити',
    });

    expect(teacherCommentAlert(target, { text: "Молодець", postedAt: at(-1) }, T0).level).toBe(
      "alert",
    );
  });
});
