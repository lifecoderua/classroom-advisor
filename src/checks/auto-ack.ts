// Auto-ack (#51): once work is resolved (turned in with attachments and checked ok, or returned /
// graded by the teacher), the alerts that were about the old state are muted with reason `auto`,
// so they leave the digest, `/status` and the backlog by themselves (D19).

import type { Db } from "../store/index.ts";

export const MUTE_AUTO = "auto";

const DONE: ReadonlySet<string> = new Set(["turned_in", "returned"]);

interface Resolved {
  /** When the evidence appeared: the ok review, or now for returned/graded work. */
  resolvedAt: Date;
  turnedInAt: Date | null;
  latestVersionId: number;
}

/**
 * Assignments of watched accounts whose work is resolved: turned in (the `missing` bucket wins),
 * and either returned/graded by the teacher, or with attachments and an `ok` latest LLM review of
 * the latest version.
 */
export async function resolvedAssignments(db: Db, now: Date): Promise<Map<number, Resolved>> {
  const subs = await db.submission.findMany({
    where: {
      state: { in: [...DONE] },
      assignment: { account: { watched: true }, status: { not: "missing" } },
    },
    select: {
      assignmentId: true,
      state: true,
      grade: true,
      turnedInAt: true,
      versions: {
        orderBy: [{ seenAt: "desc" }, { id: "desc" }],
        take: 1,
        select: {
          id: true,
          payload: true,
          checkResults: {
            where: { source: { startsWith: "llm:" } },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: 1,
            select: { verdict: true, createdAt: true },
          },
        },
      },
    },
  });
  const out = new Map<number, Resolved>();
  for (const s of subs) {
    const v = s.versions[0];
    if (!v) continue;
    const base = { turnedInAt: s.turnedInAt, latestVersionId: v.id };
    if (s.state === "returned" || (s.grade !== null && s.grade.trim() !== "")) {
      out.set(s.assignmentId, { ...base, resolvedAt: now });
      continue;
    }
    const check = v.checkResults[0];
    if (check?.verdict === "ok" && attachmentCount(v.payload) > 0) {
      out.set(s.assignmentId, { ...base, resolvedAt: check.createdAt });
    }
  }
  return out;
}

function attachmentCount(payload: string): number {
  try {
    const p = JSON.parse(payload) as { attachments?: unknown[] };
    return Array.isArray(p.attachments) ? p.attachments.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Mutes (reason `auto`) the open alerts of resolved assignments that describe the old state:
 * deadline alerts (`untouched_24h`, `due_soon`, `missing`, `no_due_date`), teacher comments posted
 * before the latest turn-in (a redo request that was redone and reviewed ok), and quality alerts
 * of older versions. Never an alert created after the resolution, nor anything about the latest
 * version. `sentAt` is set too, so a muted alert never goes out. Returns the muted ids.
 */
export async function autoAck(db: Db, now: Date = new Date()): Promise<number[]> {
  const resolved = await resolvedAssignments(db, now);
  if (resolved.size === 0) return [];
  const open = await db.alert.findMany({
    where: {
      mutedAt: null,
      OR: [
        { key: { startsWith: "deadline:" } },
        { key: { startsWith: "comment:" } },
        { key: { startsWith: "quality:" } },
      ],
    },
    select: { id: true, key: true, createdAt: true },
  });
  const idOf = (key: string) => Number(key.split(":")[1]);
  const commentIds = open.filter((a) => a.key.startsWith("comment:")).map((a) => idOf(a.key));
  const versionIds = open.filter((a) => a.key.startsWith("quality:")).map((a) => idOf(a.key));
  const [comments, versions] = await Promise.all([
    db.comment.findMany({
      where: { id: { in: commentIds } },
      select: { id: true, assignmentId: true, postedAt: true },
    }),
    db.submissionVersion.findMany({
      where: { id: { in: versionIds } },
      select: { id: true, submission: { select: { assignmentId: true } } },
    }),
  ]);
  const commentOf = new Map(comments.map((c) => [c.id, c]));
  const versionOf = new Map(versions.map((v) => [v.id, v.submission.assignmentId]));

  const mute: number[] = [];
  for (const a of open) {
    const id = idOf(a.key);
    let r: Resolved | undefined;
    let ok = false;
    if (a.key.startsWith("deadline:")) {
      r = resolved.get(id);
      ok = r !== undefined;
    } else if (a.key.startsWith("comment:")) {
      const c = commentOf.get(id);
      r = c && resolved.get(c.assignmentId);
      ok = !!(c && r?.turnedInAt && c.postedAt.getTime() < r.turnedInAt.getTime());
    } else {
      const assignmentId = versionOf.get(id);
      r = assignmentId === undefined ? undefined : resolved.get(assignmentId);
      ok = r !== undefined && id !== r.latestVersionId;
    }
    if (ok && r && a.createdAt.getTime() <= r.resolvedAt.getTime()) mute.push(a.id);
  }
  if (mute.length) await muteAlerts(db, mute, MUTE_AUTO, now);
  return mute;
}

export const MUTE_SUPERSEDED = "superseded";

/** What makes a turn-in "new": its turn-in time and its attachments (not a grade or a return). */
function turnInKey(payload: string): string {
  try {
    const p = JSON.parse(payload) as { turnedInAt?: unknown; attachments?: unknown };
    return JSON.stringify([p.turnedInAt ?? null, p.attachments ?? []]);
  } catch {
    return payload;
  }
}

/**
 * Retires the alerts of replaced turn-ins (#52): an open `quality:<versionId>…` alert (warn,
 * panic, check by hand, failed review) whose version is no longer the latest one of its
 * submission, and the latest version was turned in again or has different attachments, is muted
 * with reason `superseded`. Only the latest turn-in's alerts stay. A newer version that only
 * changed the grade or the state (returned) doesn't supersede anything. Returns the muted ids.
 */
export async function supersedeAlerts(db: Db, now: Date = new Date()): Promise<number[]> {
  const open = await db.alert.findMany({
    where: { mutedAt: null, key: { startsWith: "quality:" } },
    select: { id: true, key: true },
  });
  if (open.length === 0) return [];
  const versionId = (key: string) => Number(key.split(":")[1]);
  const versions = await db.submissionVersion.findMany({
    where: { id: { in: [...new Set(open.map((a) => versionId(a.key)))] } },
    select: {
      id: true,
      payload: true,
      submission: {
        select: {
          versions: {
            orderBy: [{ seenAt: "desc" }, { id: "desc" }],
            take: 1,
            select: { id: true, payload: true },
          },
        },
      },
    },
  });
  const stale = new Set(
    versions.flatMap((v) => {
      const latest = v.submission.versions[0];
      if (!latest || latest.id === v.id) return [];
      return turnInKey(latest.payload) === turnInKey(v.payload) ? [] : [v.id];
    }),
  );
  const mute = open.filter((a) => stale.has(versionId(a.key))).map((a) => a.id);
  if (mute.length) await muteAlerts(db, mute, MUTE_SUPERSEDED, now);
  return mute;
}

/** Mutes alerts with a reason (and marks unsent ones sent, so they never go out). */
export async function muteAlerts(
  db: Db,
  ids: readonly number[],
  reason: string,
  now: Date,
): Promise<void> {
  await db.alert.updateMany({
    where: { id: { in: [...ids] }, mutedAt: null, sentAt: null },
    data: { mutedAt: now, muteReason: reason, sentAt: now },
  });
  await db.alert.updateMany({
    where: { id: { in: [...ids] }, mutedAt: null },
    data: { mutedAt: now, muteReason: reason },
  });
}

/**
 * Reminders (`untouched_24h`, `no_due_date`) of a post that asks for no work (#61): muted
 * silently, so they aren't counted as "closed automatically" either.
 */
export const MUTE_NO_WORK = "no_work_expected";

/**
 * Alerts muted automatically since `since`: any non-manual reason except `no_work_expected`
 * (lesson posts without homework stay silent, #61).
 */
export function countAutoClosed(db: Db, since: Date): Promise<number> {
  return db.alert.count({
    where: {
      muteReason: { not: null },
      NOT: { muteReason: MUTE_NO_WORK },
      mutedAt: { gte: since },
    },
  });
}
