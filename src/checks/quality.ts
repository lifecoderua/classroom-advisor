// Turned-in quality: heuristics → LLM second pass → merged verdict → CheckResult + Alert (#20).

import { readFileSync } from "node:fs";
import { type OfficeSummary, officeLabelledText, officeStructure } from "../collector/office.ts";
import type { LlmProvider, ReviewInput, ReviewOutput } from "../llm/types.ts";
import {
  addCheckResult,
  type CheckSource,
  type Db,
  raiseAlert,
  type Verdict,
} from "../store/index.ts";
import {
  type ImagePathOf,
  loadTurnedInInput,
  type ReadOffice,
  type ReadText,
} from "./evaluate-heuristics.ts";
import { type TurnedInInput, type TurnedInResult, turnedInSignals } from "./heuristics.ts";
import { isRedoRequest, redoDueNote } from "./redo.ts";

/** Versioned domain prompt; the id is stored with every LLM CheckResult. */
export const REVIEW_PROMPT_VERSION = "review.v2";

let promptCache: string | undefined;

export function reviewPrompt(): string {
  promptCache ??= readFileSync(
    new URL(`./prompts/${REVIEW_PROMPT_VERSION}.md`, import.meta.url),
    "utf8",
  );
  return promptCache;
}

// ---------------------------------------------------------------------------------------------
// Input

export interface TextBudget {
  /** Max characters of all texts together (instructions, materials, student work). */
  total: number;
  /** Cap for the instructions alone. */
  instructions: number;
  /** Share of what's left after the instructions that goes to the student's work first. */
  studentShare: number;
  /** Max characters of all private comments together (on top of `total`). */
  comments: number;
}

export const DEFAULT_BUDGET: TextBudget = {
  total: 24_000,
  instructions: 4_000,
  studentShare: 0.6,
  comments: 4_000,
};

/** Cap for one attachment's structure summary (about 60 slides), outside the text budget. */
export const STRUCTURE_MAX = 4_000;

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = `\n…[truncated, ${text.length - max} more characters]`;
  return text.slice(0, Math.max(0, max - marker.length)).trimEnd() + marker;
}

/** Water-filling: short texts keep their length, the rest share what's left evenly. */
export function allocate(lengths: readonly number[], budget: number): number[] {
  const order = lengths.map((len, i) => ({ len, i })).sort((a, b) => a.len - b.len);
  const out = new Array<number>(lengths.length).fill(0);
  let left = Math.max(0, budget);
  order.forEach(({ len, i }, k) => {
    const cap = Math.floor(left / (order.length - k));
    out[i] = Math.min(len, cap);
    left -= out[i] ?? 0;
  });
  return out;
}

const CYRILLIC = /\p{Script=Cyrillic}/u;
const LATIN = /\p{Script=Latin}/u;

/** Language hint for the feedback: `uk` for Cyrillic text, `en` for Latin, else none. */
export function detectLocale(text: string): string | undefined {
  const letters = text.match(/\p{L}/gu) ?? [];
  const cyr = letters.filter((c) => CYRILLIC.test(c)).length;
  const lat = letters.filter((c) => LATIN.test(c)).length;
  if (cyr === 0 && lat === 0) return undefined;
  return cyr >= lat ? "uk" : "en";
}

/** Builds the LLM input from the heuristics snapshot and signals. Pure. */
export function buildReviewInput(
  snapshot: TurnedInInput,
  heuristics: TurnedInResult,
  budget: TextBudget = DEFAULT_BUDGET,
): ReviewInput {
  const { assignment: a, submission: s } = snapshot;
  const instructions = truncate(a.instructions, budget.instructions);
  const rest = Math.max(0, budget.total - instructions.length);

  // Office files and Slides: text with slide headers, plus a separate (untruncated) structure.
  const llmText = (x: { text?: string | null | undefined; office?: OfficeSummary | undefined }) =>
    x.office && x.text != null ? officeLabelledText(x.office) : x.text;
  const studentTexts = s.attachments.map(llmText);
  const studentCaps = allocate(
    studentTexts.map((t) => t?.length ?? 0),
    Math.floor(rest * budget.studentShare),
  );
  const studentUsed = studentCaps.reduce((n, c) => n + c, 0);
  const materialTexts = a.materials.map(llmText);
  const materialCaps = allocate(
    materialTexts.map((t) => t?.length ?? 0),
    rest - studentUsed,
  );

  const withText = <T extends object>(
    item: T,
    text: string | null | undefined,
    cap: number,
    office: OfficeSummary | undefined,
  ) => ({
    ...item,
    ...(text == null ? {} : { text: truncate(text, cap) }),
    ...(office ? { structure: truncate(officeStructure(office), STRUCTURE_MAX) } : {}),
  });

  const comments = snapshot.comments ?? [];
  const commentCaps = allocate(
    comments.map((c) => c.text.length),
    budget.comments,
  );

  const locale = detectLocale(`${a.title}\n${a.instructions}`);
  return {
    assignment: {
      title: a.title,
      instructions,
      kind: a.kind,
      courseName: a.courseName ?? "",
      ...(a.dueAt ? { dueAt: a.dueAt.toISOString() } : {}),
    },
    materials: a.materials.map((m, i) =>
      withText({ title: m.title, kind: m.kind }, materialTexts[i], materialCaps[i] ?? 0, m.office),
    ),
    submission: {
      attachments: s.attachments.map((x, i) =>
        withText(
          { title: x.title, kind: x.kind, ...(x.imagePath ? { imagePath: x.imagePath } : {}) },
          studentTexts[i],
          studentCaps[i] ?? 0,
          x.office,
        ),
      ),
      turnedInAt: s.turnedInAt ? s.turnedInAt.toISOString() : "unknown",
    },
    signals: heuristics.signals,
    ...(comments.length
      ? {
          comments: comments.map((c, i) => ({
            author: c.authorRole,
            postedAt: c.postedAt.toISOString(),
            text: truncate(c.text, commentCaps[i] ?? 0),
          })),
        }
      : {}),
    ...(locale ? { locale } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Verdicts

const RANK: Record<Verdict, number> = { ok: 0, warn: 1, panic: 2 };
const worst = (a: Verdict, b: Verdict): Verdict => (RANK[a] >= RANK[b] ? a : b);

/** Signals that point at a problem (kind hints only describe the assignment). */
const PROBLEM_SIGNALS: ReadonlySet<string> = new Set([
  "no_attachments",
  "fewer_attachments_than_expected",
  "template_unchanged",
  "empty_or_tiny_doc",
  "fetch_failed",
]);
/** A heuristics-only result warns from this confidence up. */
export const HEURISTIC_WARN_CONFIDENCE = 0.6;
/** Below this LLM confidence a `panic` is downgraded to `warn`. */
export const LOW_CONFIDENCE = 0.5;

/** Verdict from the heuristics alone (stored as the `heuristic` CheckResult; LLM fallback). */
export function heuristicVerdict(h: TurnedInResult): Verdict {
  if (h.directVerdict) return h.directVerdict.level === "panic" ? "panic" : "warn";
  const problem = h.signals.some(
    (s) => PROBLEM_SIGNALS.has(s.code) && s.confidence >= HEURISTIC_WARN_CONFIDENCE,
  );
  return problem ? "warn" : "ok";
}

export type LlmOutcome = { ok: true; output: ReviewOutput } | { ok: false; error: string };

export interface MergedVerdict {
  verdict: Verdict;
  /** `llm`: LLM verdict (possibly adjusted); `heuristic-fallback`: the provider failed. */
  basis: "llm" | "heuristic-fallback";
  /** Human-readable adjustments applied by the merge. */
  notes: string[];
}

/**
 * Combines heuristics and the LLM: a direct heuristic panic always wins, a low-confidence LLM
 * panic becomes a warn, and a provider failure falls back to the heuristics-only verdict.
 */
export function mergeVerdict(heuristic: TurnedInResult, llm: LlmOutcome): MergedVerdict {
  const direct = heuristic.directVerdict;
  if (!llm.ok) {
    return {
      verdict: heuristicVerdict(heuristic),
      basis: "heuristic-fallback",
      notes: [`LLM review failed: ${llm.error}`],
    };
  }
  const notes: string[] = [];
  let verdict: Verdict = llm.output.verdict;
  if (verdict === "panic" && llm.output.confidence < LOW_CONFIDENCE) {
    verdict = "warn";
    notes.push(`low LLM confidence (${llm.output.confidence}): panic → warn`);
  }
  if (direct) {
    const forced: Verdict = direct.level === "panic" ? "panic" : "warn";
    if (RANK[forced] > RANK[verdict]) notes.push(`heuristics: ${direct.reason}`);
    verdict = worst(verdict, forced);
  }
  return { verdict, basis: "llm", notes };
}

type SnapshotComment = NonNullable<TurnedInInput["comments"]>[number];

/**
 * The latest teacher comment of the snapshot when it asks to redo, fix or attach something and
 * the work wasn't turned in after it; else `undefined` (a later teacher comment supersedes it).
 */
export function openRedoRequest(snapshot: TurnedInInput): SnapshotComment | undefined {
  const last = (snapshot.comments ?? []).filter((c) => c.authorRole === "teacher").at(-1);
  if (!last || !isRedoRequest(last.text)) return undefined;
  const turnedInAt = snapshot.submission.turnedInAt;
  if (turnedInAt && turnedInAt.getTime() > last.postedAt.getTime()) return undefined;
  return last;
}

/** Max characters of the teacher's request quoted in a quality alert. */
const REQUEST_QUOTE_CHARS = 200;

/**
 * An open redo request the LLM judged `ok` still needs a look: raises the verdict to `warn`.
 * Pure; returns `merged` unchanged otherwise.
 */
export function applyRedoFloor(
  merged: MergedVerdict,
  redo: SnapshotComment | undefined,
): MergedVerdict {
  if (!redo || merged.basis !== "llm" || merged.verdict !== "ok") return merged;
  const text = redo.text.trim().replace(/\s+/g, " ");
  const quoted =
    text.length > REQUEST_QUOTE_CHARS ? `${text.slice(0, REQUEST_QUOTE_CHARS - 1)}…` : text;
  return {
    ...merged,
    verdict: "warn",
    notes: [...merged.notes, `teacher's request not addressed yet: "${quoted}"`],
  };
}

/** Alert text for the parent. `extra` sentences are appended (e.g. an overdue redo request). */
export function qualityMessage(
  snapshot: TurnedInInput,
  heuristic: TurnedInResult,
  llm: LlmOutcome,
  merged: MergedVerdict,
  extra: readonly string[] = [],
): string {
  const tail = extra.map((e) => ` ${e}`).join("");
  return `${qualityHeadline(snapshot, heuristic, llm, merged)}${tail}`;
}

function qualityHeadline(
  snapshot: TurnedInInput,
  heuristic: TurnedInResult,
  llm: LlmOutcome,
  merged: MergedVerdict,
): string {
  const a = snapshot.assignment;
  const label = a.courseName ? `"${a.title}" (${a.courseName})` : `"${a.title}"`;
  const head = merged.verdict === "panic" ? "Check now" : "Take a look";
  if (llm.ok) {
    const missing = llm.output.missingParts.length
      ? ` Missing: ${llm.output.missingParts.join("; ")}.`
      : "";
    const forced =
      heuristic.directVerdict && llm.output.verdict !== "panic" && merged.verdict === "panic"
        ? ` (${heuristic.directVerdict.reason})`
        : "";
    return `${head}: ${label}: ${llm.output.summaryForParent.trim()}${missing}${forced}`;
  }
  const why =
    heuristic.directVerdict?.reason ??
    heuristic.signals
      .filter((s) => PROBLEM_SIGNALS.has(s.code) && s.confidence >= HEURISTIC_WARN_CONFIDENCE)
      .map((s) => s.detail ?? s.code)
      .join("; ");
  return `${head}: ${label}: ${why} [heuristics only, LLM review unavailable]`;
}

// ---------------------------------------------------------------------------------------------
// Adapter

export const llmSource = (provider: LlmProvider): CheckSource => `llm:${provider.name}`;

const DONE: ReadonlySet<string> = new Set(["turned_in", "returned"]);

export type ReviewStatus =
  | "reviewed"
  /**
   * The provider failed: nothing stored for the LLM (retried on the next run). Alerts only on a
   * direct heuristic panic, plus `quality:<id>:llm-failed` after repeated failures.
   */
  | "fallback"
  /** Already has an LLM CheckResult from this provider and no newer teacher comment. */
  | "already_reviewed"
  /** Not turned in, or a material post. */
  | "not_applicable"
  | "not_found";

export interface ReviewSubmissionResult {
  status: ReviewStatus;
  verdict?: Verdict;
  message?: string;
  alertCreated?: boolean;
  /** Provider failures so far for this version (on `fallback`). */
  llmFailures?: number;
  /** Whether the `quality:<id>:llm-failed` alert was created by this call. */
  failureAlertCreated?: boolean;
  /** A re-review: the id of the new teacher comment that triggered it. */
  triggerCommentId?: number;
}

/** After this many provider failures for a version, `quality:<id>:llm-failed` is raised. */
export const LLM_FAILURE_ALERT_AFTER = 3;

/** The `heuristic` CheckResult findings, plus a per-source LLM failure counter. */
type StoredHeuristicFindings = TurnedInResult & { llmFailures?: Record<string, number> };

export interface ReviewSubmissionOptions {
  /** Resolves local image paths of student attachments (see `cachedImagePath`). */
  imagePathOf?: ImagePathOf;
  /** Reads Office/Slides structure summaries (see `cachedOfficeReader`). */
  readOffice?: ReadOffice;
  budget?: TextBudget;
}

/** Comments of the assignment that `submissionVersionId` belongs to. */
const commentsOfVersion = (submissionVersionId: number) => ({
  assignment: { submission: { versions: { some: { id: submissionVersionId } } } },
});

/**
 * Reviews one submission version: heuristics, then the LLM, then the merge. Stores a `heuristic`
 * CheckResult (once) and an `llm:<provider>` one, and raises `quality:<id>` for warn/panic.
 * On provider failure no LLM result is stored, so the next run retries.
 *
 * A version that already has this provider's result is reviewed again only for a fresh teacher
 * comment newer than what that review saw (`throughCommentId`): one re-review per new comment
 * (or batch of comments). It alerts as `quality:<id>:c<commentId>`, and only when the verdict got
 * worse than the previous one; the comment's own `comment:<id>` alert covers the rest.
 */
export async function reviewSubmission(
  db: Db,
  submissionVersionId: number,
  provider: LlmProvider,
  readText: ReadText,
  now: Date = new Date(),
  opts: ReviewSubmissionOptions = {},
): Promise<ReviewSubmissionResult> {
  const source = llmSource(provider);
  const existing = await db.checkResult.findMany({
    where: { submissionVersionId, source: { in: ["heuristic", source] } },
    select: { id: true, source: true, findings: true, verdict: true, throughCommentId: true },
    orderBy: { id: "asc" },
  });
  const prior = existing.filter((r) => r.source === source);
  let trigger: { id: number } | null = null;
  if (prior.length > 0) {
    const seen = Math.max(0, ...prior.map((r) => r.throughCommentId ?? 0));
    trigger = await db.comment.findFirst({
      where: {
        ...commentsOfVersion(submissionVersionId),
        authorRole: "teacher",
        baseline: false,
        id: { gt: seen },
      },
      orderBy: { id: "desc" },
      select: { id: true },
    });
    if (!trigger) return { status: "already_reviewed" };
  }
  const previous = prior.at(-1)?.verdict as Verdict | undefined;
  const throughCommentId =
    (
      await db.comment.aggregate({
        where: commentsOfVersion(submissionVersionId),
        _max: { id: true },
      })
    )._max.id ?? null;
  const suffix = trigger ? `:c${trigger.id}` : "";
  const reReview = trigger ? { triggerCommentId: trigger.id } : {};

  const snapshot = await loadTurnedInInput(db, submissionVersionId, readText, {
    imagePathOf: opts.imagePathOf,
    readOffice: opts.readOffice,
  });
  if (!snapshot) return { status: "not_found" };
  if (!DONE.has(snapshot.submission.state) || snapshot.assignment.kind === "material") {
    return { status: "not_applicable" };
  }

  const heuristic = turnedInSignals(snapshot);
  const stored =
    existing.find((r) => r.source === "heuristic") ??
    (await addCheckResult(
      db,
      {
        submissionVersionId,
        source: "heuristic",
        verdict: heuristicVerdict(heuristic),
        findings: heuristic,
      },
      now,
    ));

  const input = buildReviewInput(snapshot, heuristic, opts.budget);
  let llm: LlmOutcome;
  try {
    llm = { ok: true, output: await provider.review(input, { instructions: reviewPrompt() }) };
  } catch (err) {
    llm = { ok: false, error: (err as Error).message };
  }
  const redo = openRedoRequest(snapshot);
  const merged = applyRedoFloor(mergeVerdict(heuristic, llm), redo);
  const dueNote = redo ? redoDueNote(snapshot.assignment.dueAt, now) : undefined;
  const qualityAlert = async () => {
    const message = qualityMessage(snapshot, heuristic, llm, merged, dueNote ? [dueNote] : []);
    const { created } = await raiseAlert(
      db,
      {
        key: `quality:${submissionVersionId}${suffix}`,
        level: merged.verdict === "panic" ? "panic" : "alert",
        message,
      },
      now,
    );
    return { message, created };
  };

  if (!llm.ok) {
    // Nothing is stored for the LLM, so the next run retries. Count the failure on the
    // heuristic result (per re-review trigger); only a direct heuristic panic alerts right away,
    // and only on the first review (a re-review doesn't change the heuristics).
    const findings = JSON.parse(stored.findings) as StoredHeuristicFindings;
    const counter = `${source}${suffix}`;
    const failures = (findings.llmFailures?.[counter] ?? 0) + 1;
    findings.llmFailures = { ...findings.llmFailures, [counter]: failures };
    await db.checkResult.update({
      where: { id: stored.id },
      data: { findings: JSON.stringify(findings) },
    });
    const result: ReviewSubmissionResult = {
      status: "fallback",
      llmFailures: failures,
      ...reReview,
    };
    if (!trigger && heuristic.directVerdict?.level === "panic") {
      const { message, created } = await qualityAlert();
      Object.assign(result, { verdict: "panic", message, alertCreated: created });
    }
    if (failures >= LLM_FAILURE_ALERT_AFTER) {
      const a = snapshot.assignment;
      const label = a.courseName ? `"${a.title}" (${a.courseName})` : `"${a.title}"`;
      const { created } = await raiseAlert(
        db,
        {
          key: `quality:${submissionVersionId}${suffix}:llm-failed`,
          level: "alert",
          message: `Automatic review couldn't run: ${label} failed ${failures} times (${provider.name}: ${llm.error}). Check the work by hand.`,
        },
        now,
      );
      result.failureAlertCreated = created;
    }
    return result;
  }

  await addCheckResult(
    db,
    {
      submissionVersionId,
      source,
      verdict: merged.verdict,
      findings: {
        promptVersion: REVIEW_PROMPT_VERSION,
        output: llm.output,
        merge: merged,
        ...(trigger ? { trigger: { commentId: trigger.id } } : {}),
      },
      throughCommentId,
    },
    now,
  );
  // A re-review alerts only when the verdict got worse; an unchanged one would repeat itself.
  const worse = !previous || RANK[merged.verdict] > RANK[previous];
  if (merged.verdict === "ok" || !worse) {
    return { status: "reviewed", verdict: merged.verdict, alertCreated: false, ...reReview };
  }
  const { message, created } = await qualityAlert();
  return {
    status: "reviewed",
    verdict: merged.verdict,
    message,
    alertCreated: created,
    ...reReview,
  };
}

/**
 * Latest turned-in, non-baseline versions of watched accounts' submissions that need a review
 * from `source`: no result from it yet, or a fresh teacher comment newer than every result's
 * `throughCommentId` (a re-review, #44). Older versions are superseded and skipped.
 */
export async function pendingQualityVersions(db: Db, source: CheckSource): Promise<number[]> {
  const subs = await db.submission.findMany({
    where: {
      state: { in: [...DONE] },
      assignment: { kind: { not: "material" }, account: { watched: true } },
    },
    select: {
      versions: {
        orderBy: [{ seenAt: "desc" }, { id: "desc" }],
        take: 1,
        select: {
          id: true,
          state: true,
          baseline: true,
          checkResults: { where: { source }, select: { throughCommentId: true } },
        },
      },
      assignment: {
        select: {
          comments: {
            where: { authorRole: "teacher", baseline: false },
            orderBy: { id: "desc" },
            take: 1,
            select: { id: true },
          },
        },
      },
    },
    orderBy: { id: "asc" },
  });
  return subs.flatMap((s) => {
    const v = s.versions[0];
    if (!v || !DONE.has(v.state) || v.baseline) return [];
    if (v.checkResults.length === 0) return [v.id];
    const seen = Math.max(0, ...v.checkResults.map((r) => r.throughCommentId ?? 0));
    const latestTeacher = s.assignment.comments[0]?.id ?? 0;
    return latestTeacher > seen ? [v.id] : [];
  });
}
