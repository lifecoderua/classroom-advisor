// Manual re-check (`/recheck`, #54): re-fetch an assignment's details and files ignoring caches
// (in the next `run` cycle, through its own browser session), then review the latest turned-in
// version again as a new CheckResult. Older alerts of the submission are superseded as in #52.
// Read-only against Classroom: it only reads.

import type { LlmProvider } from "../llm/types.ts";
import { type AlertContent, alertContent, type Db, type Verdict } from "../store/index.ts";
import { MUTE_SUPERSEDED, muteAlerts } from "./auto-ack.ts";
import type { ReadText } from "./evaluate-heuristics.ts";
import { llmSource, type ReviewSubmissionOptions, reviewSubmission } from "./quality.ts";

const DONE: ReadonlySet<string> = new Set(["turned_in", "returned"]);

/** `https://classroom.google.com/c/<course>/a/<item>/details` → Classroom ids, else null. */
export function parseClassroomLink(text: string): { courseId: string; itemId: string } | null {
  const m =
    /classroom\.google\.com\/(?:u\/\d+\/)?c\/([A-Za-z0-9_-]+)\/(?:a|m|sa)\/([A-Za-z0-9_-]+)/.exec(
      text,
    );
  if (!m?.[1] || !m[2]) return null;
  const decode = (b64: string) => {
    const s = Buffer.from(b64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return /^\d+$/.test(s) ? s : undefined;
  };
  const courseId = decode(m[1]);
  const itemId = decode(m[2]);
  return courseId && itemId ? { courseId, itemId } : null;
}

export interface RecheckTarget {
  assignmentId: number;
  title: string;
  course: string;
  /** The submission is turned in (or returned), so there is something to check. */
  turnedIn: boolean;
}

/**
 * Resolves `/recheck <id | Classroom link>` against the DB (watched accounts only): an assignment
 * id as shown in digest lines, or a Classroom details link. Null when not found.
 */
export async function findRecheckTarget(db: Db, ref: string): Promise<RecheckTarget | null> {
  const select = {
    id: true,
    title: true,
    course: { select: { name: true } },
    submission: { select: { state: true } },
  } as const;
  let row: {
    id: number;
    title: string;
    course: { name: string };
    submission: { state: string } | null;
  } | null = null;
  if (/^\d+$/.test(ref.trim())) {
    row = await db.assignment.findFirst({
      where: { id: Number(ref.trim()), account: { watched: true } },
      select,
    });
  } else {
    const link = parseClassroomLink(ref);
    if (!link) return null;
    row = await db.assignment.findFirst({
      where: {
        classroomId: link.itemId,
        course: { classroomId: link.courseId },
        account: { watched: true },
      },
      select,
    });
  }
  if (!row) return null;
  return {
    assignmentId: row.id,
    title: row.title,
    course: row.course.name,
    turnedIn: !!row.submission && DONE.has(row.submission.state),
  };
}

export interface RecheckResult {
  assignmentId: number;
  title: string;
  course: string;
  /** `reviewed`; `not_turned_in` (nothing to check); `failed` (the LLM failed; retried later). */
  status: "reviewed" | "not_turned_in" | "failed" | "not_found";
  verdict?: Verdict;
  /** The alert the recheck raised, if any (warn/panic or check by hand). */
  content?: AlertContent;
  /**
   * The LLM review's summary. An `ok` verdict raises at most a check-by-hand alert, which lists
   * only the parts the review couldn't verify: without this the parts it did check are lost.
   */
  summary?: string;
}

/** `summaryForParent` of the newest `source` CheckResult of a version, if any. */
async function reviewSummary(
  db: Db,
  submissionVersionId: number,
  source: string,
): Promise<string | undefined> {
  const r = await db.checkResult.findFirst({
    where: { submissionVersionId, source },
    orderBy: { id: "desc" },
    select: { findings: true },
  });
  if (!r) return undefined;
  try {
    const f = JSON.parse(r.findings) as { output?: { summaryForParent?: unknown } };
    const s = f.output?.summaryForParent;
    return typeof s === "string" && s.trim() ? s.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reviews the latest turned-in version of each assignment again, after the cycle's sync
 * re-fetched it. A version that got its first review in this cycle (`since`) isn't reviewed a
 * second time: that review is the answer. Before a forced review, every open quality alert of
 * the submission is superseded once the new review is stored, so only its alert remains.
 */
export async function recheckAssignments(
  db: Db,
  assignmentIds: readonly number[],
  provider: LlmProvider,
  readText: ReadText,
  now: Date,
  since: Date,
  opts: ReviewSubmissionOptions = {},
): Promise<RecheckResult[]> {
  const out: RecheckResult[] = [];
  for (const assignmentId of [...new Set(assignmentIds)]) {
    const a = await db.assignment.findUnique({
      where: { id: assignmentId },
      select: {
        title: true,
        course: { select: { name: true } },
        submission: {
          select: {
            state: true,
            versions: {
              select: {
                id: true,
                checkResults: {
                  where: { source: llmSource(provider) },
                  orderBy: { id: "asc" },
                  select: { id: true, verdict: true, createdAt: true },
                },
              },
              orderBy: [{ seenAt: "desc" }, { id: "desc" }],
            },
          },
        },
      },
    });
    if (!a) {
      out.push({ assignmentId, title: "", course: "", status: "not_found" });
      continue;
    }
    const base = { assignmentId, title: a.title, course: a.course.name };
    const latest = a.submission?.versions[0];
    if (!a.submission || !latest || !DONE.has(a.submission.state)) {
      out.push({ ...base, status: "not_turned_in" });
      continue;
    }
    const fresh = latest.checkResults.find((r) => r.createdAt.getTime() >= since.getTime());
    const versionIds = a.submission.versions.map((v) => v.id);
    const alertsOf = (ids: readonly number[]) => ({
      mutedAt: null,
      OR: ids.map((id) => ({
        OR: [{ key: `quality:${id}` }, { key: { startsWith: `quality:${id}:` } }],
      })),
    });
    if (fresh) {
      // Reviewed in this very cycle (new files): report that review.
      const alert = await db.alert.findFirst({
        where: alertsOf([latest.id]),
        orderBy: { id: "desc" },
        select: { code: true, params: true },
      });
      const summary = await reviewSummary(db, latest.id, llmSource(provider));
      out.push({
        ...base,
        status: "reviewed",
        verdict: fresh.verdict as Verdict,
        ...(alert ? { content: alertContent(alert) } : {}),
        ...(summary ? { summary } : {}),
      });
      continue;
    }
    const old = await db.alert.findMany({ where: alertsOf(versionIds), select: { id: true } });
    const res = await reviewSubmission(db, latest.id, provider, readText, now, {
      ...opts,
      force: true,
    });
    // The new result replaces the old alerts (only once there is one: a failed LLM call keeps them).
    if (res.status === "reviewed" && old.length) {
      await muteAlerts(
        db,
        old.map((x) => x.id),
        MUTE_SUPERSEDED,
        now,
      );
    }
    const summary =
      res.status === "reviewed"
        ? await reviewSummary(db, latest.id, llmSource(provider))
        : undefined;
    out.push({
      ...base,
      status: res.status === "reviewed" ? "reviewed" : "failed",
      ...(res.verdict ? { verdict: res.verdict } : {}),
      ...(res.content ? { content: res.content } : {}),
      ...(summary ? { summary } : {}),
    });
  }
  return out;
}
