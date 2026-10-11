// Deadline rules: pure functions over a plain snapshot and `now`. All math is on epoch
// milliseconds (UTC), so local timezones and DST never matter.

import type { AlertLevel } from "../store/types.ts";

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

/** Kinds where no submission is expected. */
const NO_SUBMISSION_KINDS: ReadonlySet<string> = new Set(["material"]);
const DONE: ReadonlySet<string> = new Set(["turned_in", "returned"]);

export interface DeadlineInput {
  assignment: {
    id: number;
    kind: string;
    title: string;
    courseName: string;
    dueAt?: Date | null;
    postedAt?: Date | null;
    /** Fallback for `postedAt`: when the collector first saw the assignment. */
    firstSeenAt: Date;
    status: string;
    /**
     * Stored by the account's baseline sync (it existed before we started watching): only the
     * panics (`missing`, `due_soon`) apply to it.
     */
    baseline?: boolean;
  };
  submission?: {
    state: string;
    turnedInAt?: Date | null;
    studentWorkSignals: {
      attachmentCount: number;
      lastStudentEditAt?: Date | null;
    };
  } | null;
}

export type DeadlineCode = "untouched_24h" | "due_soon" | "missing" | "no_due_date";

export interface AlertDraft {
  key: string;
  level: AlertLevel;
  code: DeadlineCode;
  message: string;
}

/**
 * Turned in when the submission says so; without a submission row, falls back to the
 * assignment status. A reclaimed (unsubmitted) submission counts as not turned in. The
 * `missing` bucket wins: a teacher can return work that was never turned in.
 */
export function isTurnedIn(input: DeadlineInput): boolean {
  if (input.assignment.status === "missing") return false;
  if (input.submission) return DONE.has(input.submission.state);
  return DONE.has(input.assignment.status);
}

/** ISO-8601 week of `date` in UTC, e.g. `2026-W41`. */
export function isoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7; // Mon=1..Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // Thursday of this week decides the year
  const year = d.getUTCFullYear();
  const week = Math.ceil(((d.getTime() - Date.UTC(year, 0, 1)) / DAY_MS + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

function hoursLabel(ms: number): string {
  const h = Math.max(1, Math.round(ms / HOUR_MS));
  return h === 1 ? "1 hour" : `${h} hours`;
}

export interface DeadlineOptions {
  /**
   * `untouched_24h` and `no_due_date` apply only to items posted within this window
   * (default: no limit). Panics ignore it.
   */
  lookbackMs?: number;
}

/** Evaluates the deadline rules for one assignment. Returns drafts, most severe first. */
export function deadlineAlerts(
  input: DeadlineInput,
  now: Date,
  options: DeadlineOptions = {},
): AlertDraft[] {
  const a = input.assignment;
  if (NO_SUBMISSION_KINDS.has(a.kind) || a.status === "excused" || isTurnedIn(input)) return [];

  const t = now.getTime();
  const posted = (a.postedAt ?? a.firstSeenAt).getTime();
  const due = a.dueAt?.getTime();
  // Reminders only for recent, post-baseline items; old lesson posts would flood the digest.
  const remind = !a.baseline && t - posted <= (options.lookbackMs ?? Number.POSITIVE_INFINITY);
  const label = `"${a.title}" (${a.courseName})`;
  const key = (code: DeadlineCode, suffix?: string) =>
    `deadline:${a.id}:${code}${suffix ? `:${suffix}` : ""}`;
  const out: AlertDraft[] = [];

  if (a.status === "missing" || (due !== undefined && due <= t)) {
    out.push({
      key: key("missing"),
      level: "panic",
      code: "missing",
      message: `Missing: ${label} is past due and not turned in.`,
    });
  } else if (due !== undefined && due - t < DAY_MS) {
    out.push({
      key: key("due_soon"),
      level: "panic",
      code: "due_soon",
      message: `Due in ${hoursLabel(due - t)}: ${label} is not turned in yet.`,
    });
  }

  // A panic already covers it; don't stack a lesser alert for the same assignment.
  const signals = input.submission?.studentWorkSignals;
  const lastEdit = signals?.lastStudentEditAt?.getTime();
  const noWork =
    (signals?.attachmentCount ?? 0) === 0 && (lastEdit === undefined || lastEdit <= posted);
  if (remind && out.length === 0 && t - posted > DAY_MS && noWork) {
    out.push({
      key: key("untouched_24h"),
      level: "alert",
      code: "untouched_24h",
      message: `Not started: ${label} was posted over a day ago and has no work yet.`,
    });
  }

  if (remind && due === undefined && t - posted > 7 * DAY_MS) {
    out.push({
      key: key("no_due_date", isoWeek(now)),
      level: "info",
      code: "no_due_date",
      message: `Reminder: ${label} has no due date and is not turned in.`,
    });
  }

  return out;
}

export function evaluateDeadlineRules(
  inputs: readonly DeadlineInput[],
  now: Date,
  options: DeadlineOptions = {},
): AlertDraft[] {
  return inputs.flatMap((input) => deadlineAlerts(input, now, options));
}
