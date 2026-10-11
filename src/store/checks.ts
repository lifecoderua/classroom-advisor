import type { Db } from "./db.ts";
import type { Alert, CheckResult } from "./generated/client.ts";
import type { AlertLevel, CheckSource, Verdict } from "./types.ts";

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

export interface AlertInput {
  /** Dedupe key, e.g. `quality:<submissionVersionId>`. */
  key: string;
  level: AlertLevel;
  message: string;
}

/** Creates the alert unless one with the same key exists; an existing alert is left untouched. */
export function raiseAlert(
  db: Db,
  input: AlertInput,
  now: Date = new Date(),
): Promise<{ alert: Alert; created: boolean }> {
  return db.$transaction(async (tx) => {
    const existing = await tx.alert.findUnique({ where: { key: input.key } });
    if (existing) return { alert: existing, created: false };
    const alert = await tx.alert.create({ data: { ...input, createdAt: now } });
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
