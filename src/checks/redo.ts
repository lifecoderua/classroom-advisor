// Teacher comments that ask for changes ("переробити", "прикрепи фото", "redo") (#44). Pure.

/**
 * Word starts (stems) of a request to redo, fix, finish, attach or resubmit, in Ukrainian,
 * Russian and English. Matched case-insensitively at the start of a word, so inflections match
 * ("переробіть", "прикрепите", "fixing"). `виправлен…` / `исправлен…` ("corrected") don't count.
 */
export const REDO_STEMS: readonly string[] = [
  // Ukrainian
  "перероб",
  "дороб",
  "виправ(?!лен)",
  "прикріп",
  "додай",
  "додати",
  "переписа",
  "перепиш",
  "перезда",
  "завантаж",
  "надішл",
  "не вистачає",
  // Russian
  "передел",
  "додела",
  "исправ(?!лен)",
  "прикреп",
  "добав",
  "пересда",
  "загруз",
  "пришли",
  "не хватает",
  // English
  "redo",
  "re-do",
  "fix",
  "attach",
  "resubmit",
  "re-submit",
  "rewrite",
  "upload",
  "try again",
  "missing",
];

const REDO = new RegExp(`(?<![\\p{L}\\p{N}])(?:${REDO_STEMS.join("|")})`, "iu");

/** Whether a (teacher) comment asks the student to redo, fix or attach something. */
export function isRedoRequest(text: string): boolean {
  return REDO.test(text);
}

const DONE: ReadonlySet<string> = new Set(["turned_in", "returned"]);

/**
 * A request posted at `postedAt` is still open unless the work was turned in after it
 * (an unknown turn-in time counts as not turned in again).
 */
export function turnedInSince(
  postedAt: Date,
  submission: { state: string; turnedInAt: Date | null } | null | undefined,
): boolean {
  return (
    !!submission &&
    DONE.has(submission.state) &&
    !!submission.turnedInAt &&
    submission.turnedInAt.getTime() > postedAt.getTime()
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * For an open redo request: a note when the work is past due or due within a day, else
 * `undefined` (no due date, or due later).
 */
export function redoDueNote(dueAt: Date | null | undefined, now: Date): string | undefined {
  if (!dueAt) return undefined;
  const left = dueAt.getTime() - now.getTime();
  if (left <= 0) return "Not turned in again since the teacher's request, and it is past due.";
  if (left < DAY_MS) {
    return "Not turned in again since the teacher's request, and it is due within a day.";
  }
  return undefined;
}
