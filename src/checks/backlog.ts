// Open debts ("хвости", #48): what a kid still owes, derived from the current state at digest
// time (D17). Repeated in every digest until resolved, acked (its alert muted) or older than the
// forget window.

import { detailsUrl } from "../collector/classroom/todo.ts";
import { type Db, isUncheckedAlertKey } from "../store/index.ts";
import { isRedoRequest, turnedInSince } from "./redo.ts";

const DAY_MS = 86_400_000;
const DONE: ReadonlySet<string> = new Set(["turned_in", "returned"]);

/**
 * `redo`: a teacher asked to redo/fix/attach and the work wasn't turned in again since;
 * `missing`: past due (or marked missing) and not turned in; `unchecked`: a "check by hand" item
 * of the latest turned-in version.
 */
export type DebtKind = "redo" | "missing" | "unchecked";

export interface Debt {
  kind: DebtKind;
  accountId: number;
  assignmentId: number;
  title: string;
  courseName: string;
  /** When the debt appeared; its age and the forget window count from here. */
  since: Date;
  /** Assignment details page with `authuser=<email>`. */
  url: string;
  /** The alert behind the debt: `/ack <id>` mutes it and drops the debt. Null when none yet. */
  alertId: number | null;
}

export interface BacklogOptions {
  now?: Date;
  /** Debts older than this many days are forgotten (`backlogForgetDays`). */
  forgetDays: number;
  /** Only these accounts (default: every watched account). */
  accountIds?: readonly number[];
}

/** One line per assignment: a redo request beats "missing", which beats "check by hand". */
const PRIORITY: Record<DebtKind, number> = { redo: 0, missing: 1, unchecked: 2 };

/**
 * Computes the open debts from the store (pure read):
 * - `redo`: the latest fresh (non-baseline) teacher comment of an assignment asks to redo, fix
 *   or attach something and the work wasn't turned in after it; since = the comment; ack =
 *   `comment:<id>`.
 * - `missing`: not turned in, and marked missing or past due (materials and excused work
 *   excluded); since = the due date, else when it was flagged (`deadline:<id>:missing`), and for a
 *   baseline item without a due date its posting date, so old baseline items stay out; ack =
 *   `deadline:<id>:missing`.
 * - `unchecked`: an unmuted `quality:<id>…:unchecked` alert of the latest version of a submission
 *   that is still turned in; since = the alert.
 * A debt whose alert is muted, or older than `forgetDays`, is left out. Oldest first.
 */
export async function loadBacklog(db: Db, opts: BacklogOptions): Promise<Debt[]> {
  const now = opts.now ?? new Date();
  const cutoff = now.getTime() - opts.forgetDays * DAY_MS;
  const accountWhere = opts.accountIds
    ? { accountId: { in: [...opts.accountIds] } }
    : { account: { watched: true } };
  const assignmentSelect = {
    id: true,
    accountId: true,
    classroomId: true,
    kind: true,
    title: true,
    status: true,
    account: { select: { email: true, watched: true } },
    course: { select: { name: true, classroomId: true } },
  } as const;
  type Row = {
    id: number;
    accountId: number;
    classroomId: string;
    kind: string;
    title: string;
    account: { email: string };
    course: { name: string; classroomId: string };
  };
  const debt = (kind: DebtKind, a: Row, since: Date, alertId: number | null): Debt => ({
    kind,
    accountId: a.accountId,
    assignmentId: a.id,
    title: a.title,
    courseName: a.course.name,
    since,
    url: detailsUrl(
      a.course.classroomId,
      a.classroomId,
      a.kind === "material" ? "material" : "assignment",
      a.account.email,
    ),
    alertId,
  });
  const out: Debt[] = [];

  // Redo requests.
  const teacherComments = await db.comment.findMany({
    where: {
      authorRole: "teacher",
      baseline: false,
      assignment: { ...accountWhere, kind: { not: "material" }, status: { not: "excused" } },
    },
    select: { id: true, assignmentId: true, text: true, postedAt: true },
    orderBy: [{ postedAt: "asc" }, { id: "asc" }],
  });
  const latest = new Map<number, (typeof teacherComments)[number]>();
  for (const c of teacherComments) latest.set(c.assignmentId, c);
  const redo = [...latest.values()].filter(
    (c) => c.postedAt.getTime() >= cutoff && isRedoRequest(c.text),
  );
  if (redo.length) {
    const [assignments, alerts] = await Promise.all([
      db.assignment.findMany({
        where: { id: { in: redo.map((c) => c.assignmentId) } },
        select: { ...assignmentSelect, submission: { select: { state: true, turnedInAt: true } } },
      }),
      db.alert.findMany({
        where: { key: { in: redo.map((c) => `comment:${c.id}`) } },
        select: { id: true, key: true, mutedAt: true },
      }),
    ]);
    const byId = new Map(assignments.map((a) => [a.id, a]));
    const alertOf = new Map(alerts.map((a) => [a.key, a]));
    for (const c of redo) {
      const a = byId.get(c.assignmentId);
      const alert = alertOf.get(`comment:${c.id}`);
      if (!a || alert?.mutedAt || turnedInSince(c.postedAt, a.submission)) continue;
      out.push(debt("redo", a, c.postedAt, alert?.id ?? null));
    }
  }

  // Missing / overdue work.
  const open = await db.assignment.findMany({
    where: {
      ...accountWhere,
      kind: { not: "material" },
      status: { notIn: ["turned_in", "returned", "excused"] },
      OR: [{ status: "missing" }, { dueAt: { lte: now } }],
    },
    select: {
      ...assignmentSelect,
      dueAt: true,
      postedAt: true,
      firstSeenAt: true,
      baseline: true,
      submission: { select: { state: true } },
    },
  });
  const missing = open.filter(
    (a) => a.status === "missing" || !a.submission || !DONE.has(a.submission.state),
  );
  if (missing.length) {
    const alerts = await db.alert.findMany({
      where: { key: { in: missing.map((a) => `deadline:${a.id}:missing`) } },
      select: { id: true, key: true, createdAt: true, mutedAt: true },
    });
    const alertOf = new Map(alerts.map((a) => [a.key, a]));
    for (const a of missing) {
      const alert = alertOf.get(`deadline:${a.id}:missing`);
      if (alert?.mutedAt) continue;
      const since =
        a.dueAt ??
        (a.baseline ? (a.postedAt ?? a.firstSeenAt) : (alert?.createdAt ?? a.firstSeenAt));
      if (since.getTime() < cutoff) continue;
      out.push(debt("missing", a, since, alert?.id ?? null));
    }
  }

  // "Check by hand" items.
  const unchecked = (
    await db.alert.findMany({
      where: {
        key: { startsWith: "quality:", endsWith: ":unchecked" },
        mutedAt: null,
        createdAt: { gte: new Date(cutoff) },
      },
      select: { id: true, key: true, createdAt: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    })
  ).filter((a) => isUncheckedAlertKey(a.key));
  if (unchecked.length) {
    const versionId = (key: string) => Number(key.split(":")[1]);
    const versions = await db.submissionVersion.findMany({
      where: { id: { in: unchecked.map((a) => versionId(a.key)) } },
      select: {
        id: true,
        submission: {
          select: {
            state: true,
            versions: {
              orderBy: [{ seenAt: "desc" }, { id: "desc" }],
              take: 1,
              select: { id: true },
            },
            assignment: { select: assignmentSelect },
          },
        },
      },
    });
    const byVersion = new Map(versions.map((v) => [v.id, v.submission]));
    for (const alert of unchecked) {
      const id = versionId(alert.key);
      const s = byVersion.get(id);
      if (!s || s.versions[0]?.id !== id || !DONE.has(s.state)) continue;
      const a = s.assignment;
      if (opts.accountIds ? !opts.accountIds.includes(a.accountId) : !a.account.watched) continue;
      out.push(debt("unchecked", a, alert.createdAt, alert.id));
    }
  }

  // One debt per assignment (the newest "check by hand" alert of a version wins over older ones).
  const best = new Map<number, Debt>();
  for (const d of out) {
    const prev = best.get(d.assignmentId);
    if (
      !prev ||
      PRIORITY[d.kind] < PRIORITY[prev.kind] ||
      (d.kind === prev.kind && d.since >= prev.since)
    ) {
      best.set(d.assignmentId, d);
    }
  }
  return [...best.values()].sort(
    (a, b) => a.since.getTime() - b.since.getTime() || a.assignmentId - b.assignmentId,
  );
}

/** Age of a debt in whole days (0 = less than a day). */
export function debtAgeDays(debt: Pick<Debt, "since">, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - debt.since.getTime()) / DAY_MS));
}
