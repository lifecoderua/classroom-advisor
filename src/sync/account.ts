// Sync of one watched account (#19): To-do listing → pick items whose details to fetch →
// details → store (versioned) → domain events → attachment contents. Classroom is reached
// only through an injected `Transport` (read-only rpcids) and `HttpGet`, so this runs
// against fakes in tests.

import { type AssignmentDetail, parseAssignmentDetail } from "../collector/classroom/detail.ts";
import { ParseDriftError } from "../collector/classroom/parse-util.ts";
import {
  type ClassroomSession,
  createRpcClient,
  materialsArgs,
  SUBMISSIONS_BATCH,
  type SubmissionKey,
  submissionsArgs,
  type Transport,
} from "../collector/classroom/rpc.ts";
import { type AssignmentSummary, listTodo, type StreamItem } from "../collector/classroom/todo.ts";
import {
  attachmentKind,
  fetchAttachmentContents,
  type HttpGet,
  isStaleSlidesText,
  SessionExpiredError,
} from "../collector/files.ts";
import {
  type Account,
  type Db,
  type EventType,
  finishSyncRun,
  raiseAlert,
  recordEvent,
  type SyncRunStatus,
  startSyncRun,
  syncAttachments,
  upsertAssignment,
  upsertCourse,
  upsertSubmission,
} from "../store/index.ts";
import {
  applyComments,
  type CommentStats,
  type CommentTarget,
  emptyCommentStats,
  fetchPrivateComments,
} from "./comments.ts";
import {
  type AssignmentPayload,
  assignmentPayload,
  attachmentInputs,
  diffAssignment,
  hashOf,
  parsePayload,
  type SubmissionPayload,
  statusOf,
  studentAttachments,
  submissionPayload,
  summaryHash,
} from "./normalize.ts";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Open items due within this window get their details on every sync. */
export const DUE_SOON_REFRESH_MS = 48 * HOUR_MS;
/** At most this many items per sync are re-fetched for the slow full refresh. */
export const MAX_FULL_REFRESH_PER_SYNC = 20;

const OPEN_BUCKETS: ReadonlySet<string> = new Set(["assigned", "missing", "unknown"]);
const DONE_STATES: ReadonlySet<string> = new Set(["turned_in", "returned"]);

export type PickReason = "new" | "changed" | "due_soon" | "refresh";

export interface SyncAccountSource {
  transport: Transport;
  session: ClassroomSession;
  /** File fetcher (same session); without it, attachment contents are not fetched. */
  httpGet?: HttpGet;
}

export interface SyncAccountOptions {
  now: Date;
  dataDir: string;
  /** Re-fetch every item's details at least this often. */
  fullRefreshDays: number;
  /** Pause between RPC calls. */
  delayMs?: number;
  log?: (line: string) => void;
  /** Label used in log lines and alerts (no titles or ids). */
  label?: string;
  /**
   * Assignment ids (DB) to re-check (`/recheck`, #54): their details are re-fetched and their
   * submission files downloaded again, ignoring the file cache.
   */
  force?: readonly number[];
}

export interface SyncStats {
  baseline: boolean;
  items: number;
  courses: number;
  picked: Record<PickReason, number>;
  details: number;
  detailErrors: number;
  assignments: { new: number; updated: number; unchanged: number };
  submissionVersions: number;
  events: Partial<Record<EventType, number>>;
  files: { fetched: number; cached: number; metadataOnly: number; failed: number };
  comments: CommentStats;
}

export interface SyncAccountResult {
  status: SyncRunStatus;
  stats: SyncStats;
  error?: string;
}

export function emptyStats(baseline: boolean): SyncStats {
  return {
    baseline,
    items: 0,
    courses: 0,
    picked: { new: 0, changed: 0, due_soon: 0, refresh: 0 },
    details: 0,
    detailErrors: 0,
    assignments: { new: 0, updated: 0, unchanged: 0 },
    submissionVersions: 0,
    events: {},
    files: { fetched: 0, cached: 0, metadataOnly: 0, failed: 0 },
    comments: emptyCommentStats(),
  };
}

const dayOf = (d: Date) => d.toISOString().slice(0, 10);

interface Known {
  id: number;
  summaryHash: string | null;
  detailFetchedAt: Date | null;
}

/**
 * Decides which listed items get their details fetched: new ones, ones whose summary
 * changed, open ones due within 48h, and (capped, stalest first) ones not fetched for
 * `fullRefreshDays`.
 */
export function pickItems(
  summaries: readonly AssignmentSummary[],
  known: ReadonlyMap<string, Known>,
  now: Date,
  fullRefreshDays: number,
): Map<string, PickReason> {
  const t = now.getTime();
  const out = new Map<string, PickReason>();
  const stale: { id: string; at: number }[] = [];
  for (const s of summaries) {
    const k = known.get(s.id);
    if (!k) out.set(s.id, "new");
    else if (k.summaryHash !== summaryHash(s)) out.set(s.id, "changed");
    else if (
      OPEN_BUCKETS.has(s.bucket) &&
      s.dueAt &&
      s.dueAt.getTime() > t &&
      s.dueAt.getTime() - t <= DUE_SOON_REFRESH_MS
    )
      out.set(s.id, "due_soon");
    else {
      const at = k.detailFetchedAt?.getTime() ?? 0;
      if (t - at >= fullRefreshDays * DAY_MS) stale.push({ id: s.id, at });
    }
  }
  stale.sort((a, b) => a.at - b.at);
  for (const s of stale.slice(0, MAX_FULL_REFRESH_PER_SYNC)) out.set(s.id, "refresh");
  return out;
}

/**
 * Fetches the details of `items`: submissions (list + attachments masks, batched) and
 * materials (`t51ITc`, one call per item with material refs). An item whose details fail
 * maps to its error; a session error propagates.
 */
export async function fetchDetails(
  transport: Transport,
  session: ClassroomSession,
  items: readonly StreamItem[],
  options: { delayMs?: number } = {},
): Promise<Map<string, AssignmentDetail | Error>> {
  const client = createRpcClient(transport, session, options);
  const keys: SubmissionKey[] = items
    .filter((i) => i.kind !== "material")
    .map((i) => ({ studentId: session.userId, itemId: i.id, courseId: i.courseId }));
  const subPayloads: unknown[] = [];
  for (let i = 0; i < keys.length; i += SUBMISSIONS_BATCH) {
    const batch = keys.slice(i, i + SUBMISSIONS_BATCH);
    subPayloads.push(await client.call("Zj93ge", submissionsArgs(batch)));
    subPayloads.push(await client.call("Zj93ge", submissionsArgs(batch, { attachments: true })));
  }
  const out = new Map<string, AssignmentDetail | Error>();
  for (const it of items) {
    try {
      const materials =
        it.item.materialIds.length > 0
          ? await client.call("t51ITc", materialsArgs(it.id, it.courseId))
          : undefined;
      out.set(
        it.id,
        parseAssignmentDetail({
          item: it.item,
          ...(materials === undefined ? {} : { materials }),
          ...(it.kind === "material" ? {} : { submissions: subPayloads }),
          studentId: session.userId,
        }),
      );
    } catch (err) {
      if (err instanceof SessionExpiredError) throw err;
      out.set(it.id, err as Error);
    }
  }
  return out;
}

interface ApplyContext {
  db: Db;
  account: Account;
  courseId: number;
  baseline: boolean;
  now: Date;
  stats: SyncStats;
}

async function emit(
  ctx: ApplyContext,
  type: EventType,
  key: string,
  assignmentId: number,
  payload: unknown,
): Promise<void> {
  const res = await recordEvent(
    ctx.db,
    { key: `${type}:${key}`, type, accountId: ctx.account.id, assignmentId, payload },
    ctx.now,
  );
  if (res.created) ctx.stats.events[type] = (ctx.stats.events[type] ?? 0) + 1;
}

/**
 * Stores one item's details: assignment (+version on change), materials, submission
 * (+version on change), student files; then emits events (none during the baseline).
 * Returns the assignment id and whether its submission is turned in.
 */
export async function applyDetail(
  ctx: ApplyContext,
  summary: AssignmentSummary,
  detail: AssignmentDetail,
): Promise<{ assignmentId: number; turnedIn: boolean }> {
  const { db, account, now, stats, baseline } = ctx;
  const payload = assignmentPayload(detail);
  const prior = await db.assignment.findUnique({
    where: { accountId_classroomId: { accountId: account.id, classroomId: detail.id } },
    select: {
      versions: { orderBy: [{ seenAt: "desc" }, { id: "desc" }], take: 1 },
      submission: {
        select: { versions: { orderBy: [{ seenAt: "desc" }, { id: "desc" }], take: 1 } },
      },
    },
  });

  const res = await upsertAssignment(
    db,
    {
      accountId: account.id,
      courseId: ctx.courseId,
      classroomId: detail.id,
      kind: detail.kind,
      title: detail.title,
      dueAt: detail.dueAt,
      postedAt: detail.createdAt ?? summary.createdAt,
      status: statusOf(summary.bucket, detail.submission?.state ?? summary.submissionState),
      hash: hashOf(payload),
      payload,
      summaryHash: summaryHash(summary),
      detailFetchedAt: now,
      baseline,
    },
    now,
  );
  const assignmentId = res.assignment.id;
  stats.assignments[res.change]++;
  await syncAttachments(
    db,
    { owner: "material", assignmentId },
    attachmentInputs(detail.materials),
    now,
  );
  if (!baseline && res.change === "new") {
    await emit(ctx, "assignment.new", String(assignmentId), assignmentId, {
      kind: payload.kind,
      dueAt: payload.dueAt,
    });
  }
  if (!baseline && res.change === "updated" && res.version) {
    const prev = parsePayload<AssignmentPayload>(prior?.versions[0]?.payload);
    const changes = diffAssignment(prev, payload);
    if (Object.keys(changes).length > 0) {
      await emit(ctx, "assignment.updated", String(res.version.id), assignmentId, { changes });
    }
  }

  const sub = detail.submission;
  if (!sub) return { assignmentId, turnedIn: false };
  const sp = submissionPayload(sub);
  const sres = await upsertSubmission(
    db,
    {
      assignmentId,
      state: sub.state,
      turnedInAt: sub.turnedInAt ?? null,
      grade: sub.grade === undefined ? null : String(sub.grade),
      hash: hashOf(sp),
      payload: sp,
      baseline,
    },
    now,
  );
  await syncAttachments(
    db,
    { owner: "submission", assignmentId, submissionId: sres.submission.id },
    attachmentInputs(studentAttachments(sub)),
    now,
  );
  if (sres.version) {
    stats.submissionVersions++;
    if (!baseline) {
      const prev = parsePayload<SubmissionPayload>(prior?.submission?.versions[0]?.payload);
      const vid = String(sres.version.id);
      const info = { state: sp.state, bucket: sp.bucket, from: prev?.state ?? null };
      if (sp.state === "turned_in" && prev?.state !== "turned_in")
        await emit(ctx, "submission.turned_in", vid, assignmentId, { ...info, late: sp.late });
      if (sp.state === "returned" && prev?.state !== "returned")
        await emit(ctx, "submission.returned", vid, assignmentId, { ...info, grade: sp.grade });
      if (sp.state === "reclaimed" && prev?.state && DONE_STATES.has(prev.state))
        await emit(ctx, "submission.unsubmitted", vid, assignmentId, info);
      if (sp.bucket === "missing" && prev?.bucket !== "missing")
        await emit(ctx, "assignment.missing", vid, assignmentId, { dueAt: payload.dueAt });
    }
  }
  return { assignmentId, turnedIn: DONE_STATES.has(sub.state) };
}

/**
 * Syncs one watched account. Never throws for Classroom-side problems: a session error stops
 * this account (reported as `session_expired` with an alert; never logs in), other errors are
 * reported as `error`. Every run is written to `SyncRun`.
 */
export async function syncAccount(
  db: Db,
  account: Account,
  source: SyncAccountSource,
  options: SyncAccountOptions,
): Promise<SyncAccountResult> {
  const { now } = options;
  const log = options.log ?? (() => undefined);
  const label = options.label ?? `account ${account.id}`;
  const baseline = account.baselineAt === null;
  const stats = emptyStats(baseline);
  const run = await startSyncRun(db, { accountId: account.id, baseline }, now);
  const delay = options.delayMs === undefined ? {} : { delayMs: options.delayMs };

  try {
    const listing = await listTodo(source.transport, source.session, delay);
    stats.items = listing.summaries.length;
    stats.courses = listing.courses.filter((c) => c.active).length;

    const courseIds = new Map<string, number>();
    for (const c of listing.courses) {
      const row = await upsertCourse(
        db,
        { accountId: account.id, classroomId: c.id, name: c.name },
        now,
      );
      courseIds.set(c.id, row.id);
    }

    const knownRows = await db.assignment.findMany({
      where: { accountId: account.id },
      select: { id: true, classroomId: true, summaryHash: true, detailFetchedAt: true },
    });
    const known = new Map(knownRows.map((r) => [r.classroomId, r]));
    const picks = pickItems(listing.summaries, known, now, options.fullRefreshDays);
    // `/recheck`: re-fetch these items' details too.
    const forced = new Set(options.force ?? []);
    const listed = new Set(listing.summaries.map((s) => s.id));
    for (const r of knownRows) {
      if (forced.has(r.id) && listed.has(r.classroomId) && !picks.has(r.classroomId)) {
        picks.set(r.classroomId, "refresh");
      }
    }
    for (const reason of picks.values()) stats.picked[reason]++;

    const untouched = listing.summaries.filter((s) => !picks.has(s.id)).map((s) => s.id);
    await db.assignment.updateMany({
      where: { accountId: account.id, classroomId: { in: untouched } },
      data: { lastSeenAt: now },
    });

    const toFetch = listing.items.filter((i) => picks.has(i.id));
    const details = await fetchDetails(source.transport, source.session, toFetch, delay);
    const summaries = new Map(listing.summaries.map((s) => [s.id, s]));
    const ctxBase = { db, account, baseline, now, stats };
    const turnedIn: number[] = [];
    let drift: ParseDriftError | undefined;
    for (const [id, detail] of details) {
      const summary = summaries.get(id);
      if (!summary) continue;
      if (detail instanceof Error) {
        stats.detailErrors++;
        if (detail instanceof ParseDriftError) drift ??= detail;
        log(`${label}: details failed for one item (${detail.name})`);
        continue;
      }
      stats.details++;
      const courseId = courseIds.get(summary.courseId);
      if (courseId === undefined) continue;
      const r = await applyDetail({ ...ctxBase, courseId }, summary, detail);
      if (r.turnedIn) turnedIn.push(r.assignmentId);
    }
    if (drift) await driftAlert(db, account, drift, label, now);

    // Private comments of every listed submission (batched, so a few calls per account): a
    // new comment does not always change the submission's update time, so the picked items
    // alone would miss some.
    const commentKeys: SubmissionKey[] = listing.summaries
      .filter((s) => s.kind !== "material" && s.submissionState !== null)
      .map((s) => ({ studentId: source.session.userId, itemId: s.id, courseId: s.courseId }));
    if (commentKeys.length > 0) {
      const fetched = await fetchPrivateComments(source.transport, source.session, commentKeys, {
        ...delay,
        log,
      });
      stats.comments.errors += fetched.errors;
      if (fetched.drift) await driftAlert(db, account, fetched.drift, label, now);
      const rows = await db.assignment.findMany({
        where: { accountId: account.id, classroomId: { in: commentKeys.map((k) => k.itemId) } },
        select: {
          id: true,
          classroomId: true,
          baseline: true,
          title: true,
          dueAt: true,
          course: { select: { name: true } },
          submission: { select: { state: true, turnedInAt: true } },
        },
      });
      const targets = new Map<string, CommentTarget>(
        rows.map((r) => [
          r.classroomId,
          {
            id: r.id,
            baseline: r.baseline,
            title: r.title,
            courseName: r.course.name,
            dueAt: r.dueAt,
            submission: r.submission,
          },
        ]),
      );
      const created = await applyComments(
        { db, account, baseline, studentId: source.session.userId, now },
        fetched.comments,
        targets,
        stats.comments,
      );
      if (created > 0) stats.events["comment.new"] = (stats.events["comment.new"] ?? 0) + created;
    }

    // Contents of turned-in work and of its materials (template comparison). Baseline items
    // are never reviewed, so their files are not downloaded.
    if (source.httpGet && !baseline && turnedIn.length > 0) {
      const candidates = await db.attachment.findMany({
        // `.bin` = an untyped file cached before Office detection: re-examined locally (no
        // refetch). `.txt` Slides without a structure summary came from the old text export:
        // refetched once as pptx.
        where: {
          assignmentId: { in: turnedIn },
          OR: [
            { contentPath: null },
            { contentPath: { endsWith: ".bin" }, modifiedAt: { not: null } },
            { contentPath: { endsWith: ".txt" } },
            { assignmentId: { in: [...forced] } },
          ],
        },
        orderBy: { id: "asc" },
      });
      const rows: typeof candidates = [];
      for (const row of candidates) {
        const path = row.contentPath;
        const stale =
          forced.has(row.assignmentId) ||
          !path?.endsWith(".txt") ||
          (attachmentKind(row) === "slides" && (await isStaleSlidesText(options.dataDir, path)));
        if (stale) rows.push(row);
      }
      const fetchOptions = {
        get: source.httpGet,
        dataDir: options.dataDir,
        authuser: source.session.authuser,
      };
      const outcomes = [
        ...(await fetchAttachmentContents(
          db,
          rows.filter((r) => !forced.has(r.assignmentId)),
          fetchOptions,
          now,
        )),
        // `/recheck`: download again even when a cached copy exists.
        ...(await fetchAttachmentContents(
          db,
          rows.filter((r) => forced.has(r.assignmentId)),
          { ...fetchOptions, force: true },
          now,
        )),
      ];
      for (const { result } of outcomes) {
        if (!result.ok) stats.files.failed++;
        else if ("metadataOnly" in result) stats.files.metadataOnly++;
        else if (result.cached) stats.files.cached++;
        else stats.files.fetched++;
      }
    }

    if (baseline) {
      await db.account.update({ where: { id: account.id }, data: { baselineAt: now } });
    }
    await finishSyncRun(db, run.id, { status: "ok", stats }, now);
    return { status: "ok", stats };
  } catch (err) {
    const e = err as Error;
    let status: SyncRunStatus = "error";
    if (e instanceof SessionExpiredError) {
      status = "session_expired";
      await sessionAlert(db, account, label, now);
    } else if (e instanceof ParseDriftError) {
      await driftAlert(db, account, e, label, now);
    }
    const error = `${e.name}: ${e.message}`;
    log(`${label}: sync stopped (${status}): ${e.name}`);
    await finishSyncRun(db, run.id, { status, stats, error }, now);
    return { status, stats, error };
  }
}

/** Alert for a lost login; one per account per day. */
export async function sessionAlert(
  db: Db,
  account: Account,
  label: string,
  now: Date,
  status: "session_expired" | "session_missing" = "session_expired",
): Promise<void> {
  await raiseAlert(
    db,
    {
      key: `sync:${account.id}:${status}:${dayOf(now)}`,
      level: "alert",
      code: "sync.session",
      params: { account: label, state: status === "session_expired" ? "expired" : "missing" },
    },
    now,
  );
}

async function driftAlert(
  db: Db,
  account: Account,
  err: ParseDriftError,
  label: string,
  now: Date,
): Promise<void> {
  const { rpcid } = err;
  await raiseAlert(
    db,
    {
      key: `sync:${account.id}:drift:${rpcid}:${dayOf(now)}`,
      level: "alert",
      code: "sync.drift",
      params: { account: label, rpcid, error: err.message },
    },
    now,
  );
}
