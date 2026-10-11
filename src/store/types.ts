// Value sets stored as plain strings in SQLite. Statuses/states stay open (`string & {}`)
// until the collector pins down what Classroom actually returns.

export const ASSIGNMENT_KINDS = ["assignment", "question", "material", "quiz", "unknown"] as const;
export type AssignmentKind = (typeof ASSIGNMENT_KINDS)[number];

export type AssignmentStatus = "assigned" | "turned_in" | "missing" | "returned" | (string & {});

export type SubmissionState =
  | "new"
  | "created"
  | "turned_in"
  | "returned"
  | "reclaimed"
  | (string & {});

export const ATTACHMENT_OWNERS = ["material", "submission"] as const;
export type AttachmentOwner = (typeof ATTACHMENT_OWNERS)[number];

export const VERDICTS = ["ok", "warn", "panic"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** `heuristic` or `llm:<provider>`. */
export type CheckSource = "heuristic" | `llm:${string}`;

export const ALERT_LEVELS = ["info", "alert", "panic"] as const;
export type AlertLevel = (typeof ALERT_LEVELS)[number];

/** Result of an upsert that tracks content versions. */
export type Change = "new" | "updated" | "unchanged";

export const EVENT_TYPES = [
  "assignment.new",
  "assignment.updated",
  "assignment.missing",
  "submission.turned_in",
  "submission.unsubmitted",
  "submission.returned",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export type SyncRunStatus = "running" | "ok" | "session_expired" | "session_missing" | "error";
