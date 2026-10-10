/**
 * Classroom enums shared by the To-do (#5) and detail (#6) parsers.
 * Codes are documented in docs/CLASSROOM-INTERNALS.md. Unknown codes map to "unknown"
 * instead of throwing, so a new Classroom state doesn't stop the sync.
 */

export const ITEM_KINDS = ["assignment", "question", "quiz", "material", "unknown"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export const SUBMISSION_STATES = ["turned_in", "returned", "new", "reclaimed", "unknown"] as const;
export type SubmissionState = (typeof SUBMISSION_STATES)[number];

/** To-do buckets (`Zj93ge [20]`, `pONvgf` filter `[14]`). */
export const BUCKETS = [
  "assigned",
  "missing",
  "turned_in",
  "done_late",
  "returned",
  "graded",
  "graded_late",
  "excused",
  "unknown",
] as const;
export type Bucket = (typeof BUCKETS)[number];

/** Stream item type `item[0]`. Quizzes aren't a separate type (see internals). */
const KIND_BY_TYPE: Readonly<Record<number, ItemKind>> = {
  2: "assignment",
  5: "question",
  7: "material",
};

/** Submission state `Zj93ge [5]`. */
const STATE_BY_CODE: Readonly<Record<number, SubmissionState>> = {
  2: "turned_in",
  3: "returned",
  4: "new",
  5: "reclaimed",
};

/** To-do bucket `Zj93ge [20]`. 5, 6 and 9 were never seen. */
const BUCKET_BY_CODE: Readonly<Record<number, Bucket>> = {
  1: "assigned",
  2: "missing",
  3: "turned_in",
  4: "done_late",
  7: "returned",
  8: "graded",
  10: "graded_late",
  11: "excused",
};

type Code = number | null | undefined;

export const itemKindOf = (type: Code): ItemKind =>
  type == null ? "unknown" : (KIND_BY_TYPE[type] ?? "unknown");
export const submissionStateOf = (code: Code): SubmissionState =>
  code == null ? "unknown" : (STATE_BY_CODE[code] ?? "unknown");
export const bucketOf = (code: Code): Bucket =>
  code == null ? "unknown" : (BUCKET_BY_CODE[code] ?? "unknown");
