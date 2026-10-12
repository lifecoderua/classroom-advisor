import type { Db } from "./db.ts";
import type { Alert, CheckResult } from "./generated/client.ts";
import type { AlertContent, AlertLevel, CheckSource, Verdict } from "./types.ts";

export interface CheckResultInput {
  submissionVersionId: number;
  source: CheckSource;
  verdict: Verdict;
  /** Signals or LLM output, stored as JSON. */
  findings: unknown;
  /** LLM results: the highest `Comment.id` of the assignment the review saw. */
  throughCommentId?: number | null;
}

export function addCheckResult(
  db: Db,
  input: CheckResultInput,
  now: Date = new Date(),
): Promise<CheckResult> {
  return db.checkResult.create({
    data: {
      submissionVersionId: input.submissionVersionId,
      source: input.source,
      verdict: input.verdict,
      findings: JSON.stringify(input.findings),
      throughCommentId: input.throughCommentId ?? null,
      createdAt: now,
    },
  });
}

export function listCheckResults(db: Db, submissionVersionId: number): Promise<CheckResult[]> {
  return db.checkResult.findMany({
    where: { submissionVersionId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

/**
 * A new alert: dedupe key, level and what it says, as a code + params, or `message` as a
 * shorthand for untranslated free text (`code: "text"`).
 */
export type AlertInput = {
  /** Dedupe key, e.g. `quality:<submissionVersionId>`. */
  key: string;
  level: AlertLevel;
} & (AlertContent | { message: string });

/** The stored code + params of an alert row. Unparseable params fall back to empty text. */
export function alertContent(row: Pick<Alert, "code" | "params">): AlertContent {
  let params: unknown;
  try {
    params = JSON.parse(row.params);
  } catch {
    params = undefined;
  }
  if (typeof params !== "object" || params === null) return { code: "text", params: { text: "" } };
  return { code: row.code, params } as AlertContent;
}

/** Creates the alert unless one with the same key exists; an existing alert is left untouched. */
export function raiseAlert(
  db: Db,
  input: AlertInput,
  now: Date = new Date(),
): Promise<{ alert: Alert; created: boolean }> {
  const content: AlertContent =
    "message" in input ? { code: "text", params: { text: input.message } } : input;
  return db.$transaction(async (tx) => {
    const existing = await tx.alert.findUnique({ where: { key: input.key } });
    if (existing) return { alert: existing, created: false };
    const alert = await tx.alert.create({
      data: {
        key: input.key,
        level: input.level,
        code: content.code,
        params: JSON.stringify(content.params),
        createdAt: now,
      },
    });
    return { alert, created: true };
  });
}

export function listUnsentAlerts(db: Db): Promise<Alert[]> {
  return db.alert.findMany({
    where: { sentAt: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

export async function markAlertsSent(
  db: Db,
  ids: readonly number[],
  now: Date = new Date(),
): Promise<void> {
  await db.alert.updateMany({
    where: { id: { in: [...ids] }, sentAt: null },
    data: { sentAt: now },
  });
}

/**
 * Mutes an alert (Telegram `/ack`): sets `mutedAt` and, when unsent, `sentAt` too, so it never
 * goes out in a digest. Returns the alert, or null when the id doesn't exist.
 */
export async function muteAlert(db: Db, id: number, now: Date = new Date()): Promise<Alert | null> {
  const alert = await db.alert.findUnique({ where: { id } });
  if (!alert) return null;
  return db.alert.update({
    where: { id },
    data: { mutedAt: alert.mutedAt ?? now, sentAt: alert.sentAt ?? now },
  });
}

/**
 * Dedupe key of the low-noise "check by hand" alert (level `info`) of a submission version.
 * A re-review on a teacher comment uses `quality:<id>:c<commentId>:unchecked`.
 */
export function uncheckedAlertKey(submissionVersionId: number): string {
  return `quality:${submissionVersionId}:unchecked`;
}

export function isUncheckedAlertKey(key: string): boolean {
  return /^quality:\d+(?::c\d+)?:unchecked$/.test(key);
}
