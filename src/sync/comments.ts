// Private comments (#39): `sLc6hf` for the listed submissions (batched), stored deduped by
// comment id, `comment.new` events, and an alert for every fresh teacher comment.

import {
  commentsHaveMore,
  type ParsedComment,
  parsePrivateComments,
} from "../collector/classroom/detail.ts";
import { ParseDriftError } from "../collector/classroom/parse-util.ts";
import {
  type ClassroomSession,
  COMMENTS_BATCH,
  createRpcClient,
  privateCommentsArgs,
  type SubmissionKey,
  type Transport,
} from "../collector/classroom/rpc.ts";
import { SessionExpiredError } from "../collector/files.ts";
import { type Account, type Db, raiseAlert, recordEvent, upsertComment } from "../store/index.ts";

export interface FetchCommentsResult {
  comments: ParsedComment[];
  /** Batches that failed (RPC error or drift); their comments are retried next sync. */
  errors: number;
  drift?: ParseDriftError;
}

/**
 * Fetches the private comments of `keys`, {@link COMMENTS_BATCH} submissions per call. A batch
 * whose response says there are more comments than one page is split in half and re-fetched.
 * A session error propagates; other failures are counted.
 */
export async function fetchPrivateComments(
  transport: Transport,
  session: ClassroomSession,
  keys: readonly SubmissionKey[],
  options: { delayMs?: number; log?: (line: string) => void } = {},
): Promise<FetchCommentsResult> {
  const client = createRpcClient(
    transport,
    session,
    options.delayMs === undefined ? {} : { delayMs: options.delayMs },
  );
  const out: FetchCommentsResult = { comments: [], errors: 0 };
  const queue: SubmissionKey[][] = [];
  for (let i = 0; i < keys.length; i += COMMENTS_BATCH)
    queue.push(keys.slice(i, i + COMMENTS_BATCH));
  while (queue.length > 0) {
    const batch = queue.shift() as SubmissionKey[];
    try {
      const payload = await client.call("sLc6hf", privateCommentsArgs(batch));
      if (commentsHaveMore(payload) && batch.length > 1) {
        const half = Math.ceil(batch.length / 2);
        queue.unshift(batch.slice(0, half), batch.slice(half));
        continue;
      }
      if (commentsHaveMore(payload)) options.log?.("comments: one submission has more than a page");
      out.comments.push(...parsePrivateComments(payload));
    } catch (err) {
      if (err instanceof SessionExpiredError) throw err;
      out.errors++;
      if (err instanceof ParseDriftError) out.drift ??= err;
    }
  }
  return out;
}

/** What `applyComments` needs to know about a stored assignment. */
export interface CommentTarget {
  id: number;
  baseline: boolean;
  title: string;
  courseName: string;
}

export interface CommentStats {
  fetched: number;
  new: number;
  teacherAlerts: number;
  /** Comments of items not stored (yet), e.g. whose details failed; retried next sync. */
  skipped: number;
  errors: number;
}

export const emptyCommentStats = (): CommentStats => ({
  fetched: 0,
  new: 0,
  teacherAlerts: 0,
  skipped: 0,
  errors: 0,
});

/** Max characters of a comment quoted in an alert. */
export const COMMENT_ALERT_CHARS = 600;

export function teacherCommentMessage(target: CommentTarget, text: string): string {
  const label = target.courseName
    ? `"${target.title}" (${target.courseName})`
    : `"${target.title}"`;
  const body = text.trim().replace(/\s+/g, " ");
  const quoted =
    body.length > COMMENT_ALERT_CHARS ? `${body.slice(0, COMMENT_ALERT_CHARS - 1)}…` : body;
  return `Teacher comment on ${label}: ${quoted || "(empty)"}`;
}

/**
 * A comment is fresh (event, and an alert when a teacher wrote it) unless it is stored by the
 * baseline sync, or it sits on a baseline item and was posted before the account's baseline.
 */
export function isFreshComment(
  comment: Pick<ParsedComment, "at">,
  target: Pick<CommentTarget, "baseline">,
  account: Pick<Account, "baselineAt">,
  baselineSync: boolean,
): boolean {
  if (baselineSync) return false;
  if (!target.baseline) return true;
  return account.baselineAt !== null && comment.at.getTime() > account.baselineAt.getTime();
}

export interface ApplyCommentsContext {
  db: Db;
  account: Account;
  /** This sync is the account's baseline. */
  baseline: boolean;
  /** The watched student; comments of other submissions are ignored. */
  studentId: string;
  now: Date;
}

/**
 * Stores comments (deduped), emits `comment.new:<commentId>` for fresh ones and raises
 * `comment:<commentId>` (level `alert`) for fresh teacher comments. Idempotent.
 */
export async function applyComments(
  ctx: ApplyCommentsContext,
  comments: readonly ParsedComment[],
  targets: ReadonlyMap<string, CommentTarget>,
  stats: CommentStats,
): Promise<number> {
  const { db, account, now } = ctx;
  let events = 0;
  for (const c of comments) {
    if (c.studentId && c.studentId !== ctx.studentId) continue;
    const target = c.itemId ? targets.get(c.itemId) : undefined;
    if (!target) {
      stats.skipped++;
      continue;
    }
    stats.fetched++;
    const fresh = isFreshComment(c, target, account, ctx.baseline);
    const { comment, created } = await upsertComment(
      db,
      {
        assignmentId: target.id,
        classroomId: c.id,
        authorRole: c.authorRole,
        authorId: c.authorId ?? null,
        text: c.text,
        postedAt: c.at,
        baseline: !fresh,
      },
      now,
    );
    if (!created || comment.baseline) continue;
    stats.new++;
    const ev = await recordEvent(
      db,
      {
        key: `comment.new:${comment.id}`,
        type: "comment.new",
        accountId: account.id,
        assignmentId: target.id,
        payload: { authorRole: comment.authorRole, postedAt: comment.postedAt.toISOString() },
      },
      now,
    );
    if (ev.created) events++;
    if (comment.authorRole === "teacher") {
      const { created: alerted } = await raiseAlert(
        db,
        {
          key: `comment:${comment.id}`,
          level: "alert",
          message: teacherCommentMessage(target, comment.text),
        },
        now,
      );
      if (alerted) stats.teacherAlerts++;
    }
  }
  return events;
}
