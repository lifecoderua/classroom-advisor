import type { Db } from "./db.ts";
import type { Event, SyncRun } from "./generated/client.ts";
import type { EventType, SyncRunStatus } from "./types.ts";

export interface EventInput {
  /** Idempotency key, e.g. `submission.turned_in:<submissionVersionId>`. */
  key: string;
  type: EventType;
  accountId: number;
  assignmentId?: number | null;
  /** Stored as JSON. */
  payload?: unknown;
}

/** Records a domain event unless one with the same key exists. */
export async function recordEvent(
  db: Db,
  input: EventInput,
  now: Date = new Date(),
): Promise<{ event: Event; created: boolean }> {
  const existing = await db.event.findUnique({ where: { key: input.key } });
  if (existing) return { event: existing, created: false };
  const event = await db.event.create({
    data: {
      key: input.key,
      type: input.type,
      accountId: input.accountId,
      assignmentId: input.assignmentId ?? null,
      payload: JSON.stringify(input.payload ?? {}),
      createdAt: now,
    },
  });
  return { event, created: true };
}

export function listEvents(
  db: Db,
  filter: { accountId?: number; since?: Date } = {},
): Promise<Event[]> {
  return db.event.findMany({
    where: {
      ...(filter.accountId !== undefined ? { accountId: filter.accountId } : {}),
      ...(filter.since ? { createdAt: { gte: filter.since } } : {}),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

export function startSyncRun(
  db: Db,
  input: { accountId: number; baseline: boolean },
  now: Date = new Date(),
): Promise<SyncRun> {
  return db.syncRun.create({
    data: {
      accountId: input.accountId,
      baseline: input.baseline,
      startedAt: now,
      status: "running",
    },
  });
}

export function finishSyncRun(
  db: Db,
  id: number,
  result: { status: SyncRunStatus; stats: unknown; error?: string | null },
  now: Date = new Date(),
): Promise<SyncRun> {
  return db.syncRun.update({
    where: { id },
    data: {
      status: result.status,
      stats: JSON.stringify(result.stats),
      error: result.error ?? null,
      finishedAt: now,
    },
  });
}
