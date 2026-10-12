// Turned-in quality: heuristics → LLM second pass → merged verdict → CheckResult + Alert (#20).

import { readFileSync } from "node:fs";
import { type OfficeSummary, officeLabelledText, officeStructure } from "../collector/office.ts";
import { DEFAULT_LANG, type Lang } from "../i18n/index.ts";
import type { LlmProvider, ReviewInput, ReviewOutput } from "../llm/types.ts";
import {
  type AlertContent,
  type AlertItem,
  addCheckResult,
  type CheckSource,
  type Db,
  type RedoDue,
  raiseAlert,
  type UncheckedItem,
  uncheckedAlertKey,
  type Verdict,
} from "../store/index.ts";
import {
  type ImagePathOf,
  loadTurnedInInput,
  type ReadOffice,
  type ReadText,
} from "./evaluate-heuristics.ts";
import { type TurnedInInput, type TurnedInResult, turnedInSignals } from "./heuristics.ts";
import { isRedoRequest, redoDue } from "./redo.ts";

/** Versioned domain prompt; the id is stored with every LLM CheckResult. */
export const REVIEW_PROMPT_VERSION = "review.v4";

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

/**
 * Builds the LLM input from the heuristics snapshot and signals. Pure. `lang` is the digest
 * language: the model writes its parent-facing text in it (`locale`).
 */
export function buildReviewInput(
  snapshot: TurnedInInput,
  heuristics: TurnedInResult,
  budget: TextBudget = DEFAULT_BUDGET,
  lang: Lang = DEFAULT_LANG,
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

  return {
    assignment: {
      title: a.title,
      instructions,
      kind: a.kind,
      courseName: a.courseName ?? "",
      ...(a.dueAt ? { dueAt: a.dueAt.toISOString() } : {}),
    },
    materials: a.materials.map((m, i) =>
      withText(
        { title: m.title, kind: m.kind, ...(m.unreadable ? { unreadable: m.unreadable } : {}) },
        materialTexts[i],
        materialCaps[i] ?? 0,
        m.office,
      ),
    ),
    submission: {
      attachments: s.attachments.map((x, i) =>
        withText(
          {
            title: x.title,
            kind: x.kind,
            ...(x.imagePath ? { imagePath: x.imagePath } : {}),
            ...(x.unreadable ? { unreadable: x.unreadable } : {}),
          },
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
    locale: lang,
  };
}

// ---------------------------------------------------------------------------------------------
// Verdicts

const RANK: Record<Verdict, number> = { unchecked: 0, ok: 0, warn: 1, panic: 2 };
const worst = (a: Verdict, b: Verdict): Verdict => (RANK[a] >= RANK[b] ? a : b);

/** Signals that point at a problem (kind hints only describe the assignment). */
const PROBLEM_SIGNALS: ReadonlySet<string> = new Set([
  "no_attachments",
  "fewer_attachments_than_expected",
  "template_unchanged",
  "empty_or_tiny_doc",
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
  /**
   * `llm`: LLM verdict (possibly adjusted); `heuristic-fallback`: the provider failed;
   * `unreadable`: no attachment could be read, so the LLM wasn't asked (see `unreadableVerdict`).
   */
  basis: "llm" | "heuristic-fallback" | "unreadable";
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

/** Student attachments the review can't read, as "check by hand" items. */
export function unreadableItems(snapshot: TurnedInInput): UncheckedItem[] {
  return snapshot.submission.attachments.flatMap((x) =>
    x.unreadable
      ? [
          {
            what: `"${x.title}"`,
            why: x.unreadable,
            ...(x.unreadableCause ? { cause: x.unreadableCause } : {}),
          },
        ]
      : [],
  );
}

/** Something is attached, but none of it can be read: the LLM has nothing to review. */
export function nothingReadable(snapshot: TurnedInInput): boolean {
  const atts = snapshot.submission.attachments;
  return atts.length > 0 && atts.every((x) => x.unreadable);
}

/**
 * Verdict when nothing is readable: the heuristics' warn/panic if they have one (e.g. fewer files
 * than templates), else `unchecked`. The LLM isn't asked: with no content it could only repeat
 * the instructions, and "is an upload expected" only matters when nothing is attached.
 */
export function unreadableVerdict(heuristic: TurnedInResult): MergedVerdict {
  const h = heuristicVerdict(heuristic);
  return {
    verdict: h === "ok" ? "unchecked" : h,
    basis: "unreadable",
    notes: ["no attachment could be read: LLM review skipped"],
  };
}

const itemOf = (a: TurnedInInput["assignment"]): AlertItem => ({
  title: a.title,
  course: a.courseName ?? "",
});

/** Content of the low-noise "check by hand" alert. */
export function uncheckedContent(
  snapshot: TurnedInInput,
  items: readonly UncheckedItem[],
): AlertContent {
  return {
    code: "quality.unchecked",
    params: { ...itemOf(snapshot.assignment), items: [...items] },
  };
}

/**
 * Content of a warn/panic quality alert: the LLM summary and missing parts, or (without an LLM
 * verdict) the heuristic signals that flagged it; plus the unchecked parts and an open redo
 * request's due note.
 */
export function qualityContent(
  snapshot: TurnedInInput,
  heuristic: TurnedInResult,
  llm: LlmOutcome,
  merged: MergedVerdict,
  extra: { unchecked?: readonly UncheckedItem[]; redoDue?: RedoDue | undefined } = {},
): AlertContent {
  const params: Extract<AlertContent, { code: "quality.review" }>["params"] = {
    ...itemOf(snapshot.assignment),
    verdict: merged.verdict === "panic" ? "panic" : "warn",
  };
  if (llm.ok) {
    params.summary = llm.output.summaryForParent.trim();
    if (llm.output.missingParts.length) params.missing = [...llm.output.missingParts];
    if (heuristic.directVerdict && llm.output.verdict !== "panic" && merged.verdict === "panic") {
      params.template = true;
    }
  } else {
    if (heuristic.directVerdict) params.template = true;
    params.heuristic = {
      basis: merged.basis === "unreadable" ? "unreadable" : "fallback",
      signals: [
        ...new Set(
          heuristic.signals
            .filter((s) => PROBLEM_SIGNALS.has(s.code) && s.confidence >= HEURISTIC_WARN_CONFIDENCE)
            .map((s) => s.code),
        ),
      ],
    };
  }
  if (extra.unchecked?.length) params.unchecked = [...extra.unchecked];
  if (extra.redoDue) params.redoDue = extra.redoDue;
  return { code: "quality.review", params };
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
  /** What the raised alert says (when one was raised). */
  content?: AlertContent;
  alertCreated?: boolean;
  /** Provider failures so far for this version (on `fallback`). */
  llmFailures?: number;
  /** Whether the `quality:<id>:llm-failed` alert was created by this call. */
  failureAlertCreated?: boolean;
  /** A re-review: the id of the new teacher comment that triggered it. */
  triggerCommentId?: number;
  /** Whether the "check by hand" (`…:unchecked`) alert was created by this call. */
  uncheckedAlertCreated?: boolean;
  /** Nothing was readable for a temporary reason: the version is retried on a later run. */
  retryPending?: boolean;
}

/**
 * An `unchecked` result whose causes are all temporary (see `isTemporaryUnreadable`) is retried
 * on later runs this many times, then kept.
 */
export const UNCHECKED_RETRIES = 3;

/** Findings of an `llm:<provider>` CheckResult, as far as the checks read them back. */
interface StoredLlmFindings {
  unchecked?: UncheckedItem[];
  /** An `unchecked` result that will be retried (temporary causes, retries left). */
  retryable?: boolean;
}

const parseFindings = (json: string): StoredLlmFindings => {
  try {
    return JSON.parse(json) as StoredLlmFindings;
  } catch {
    return {};
  }
};

const sameItems = (a: readonly UncheckedItem[], b: readonly UncheckedItem[]) =>
  JSON.stringify(a) === JSON.stringify(b);

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
  /** Digest language: the LLM writes summary, issues and unverifiable parts in it. */
  lang?: Lang;
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
  const last = prior.at(-1);
  // An `unchecked` result with temporary causes is retried as a first review (no trigger).
  const retry = last !== undefined && parseFindings(last.findings).retryable === true;
  let trigger: { id: number } | null = null;
  if (prior.length > 0 && !retry) {
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
  const previous = last?.verdict as Verdict | undefined;
  const previousUnchecked = last ? (parseFindings(last.findings).unchecked ?? []) : [];
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

  const unreadable = unreadableItems(snapshot);
  // Check-by-hand alert; a re-review raises its own only when the unchecked parts changed.
  const uncheckedAlert = async (items: readonly UncheckedItem[]) => {
    if (trigger && sameItems(items, previousUnchecked)) return { created: false };
    const key = trigger
      ? `quality:${submissionVersionId}${suffix}:unchecked`
      : uncheckedAlertKey(submissionVersionId);
    const content = uncheckedContent(snapshot, items);
    const { created } = await raiseAlert(db, { key, level: "info", ...content }, now);
    return { content, created };
  };

  if (nothingReadable(snapshot)) {
    // No LLM call. Stored under the provider's source so the version isn't picked up again,
    // unless every cause is temporary and retries are left (`retryable`).
    const merged = unreadableVerdict(heuristic);
    const attempts = prior.filter((r) => r.verdict === "unchecked").length + 1;
    const versionRow = await db.submissionVersion.findUnique({
      where: { id: submissionVersionId },
      select: { baseline: true },
    });
    const retryable =
      merged.verdict === "unchecked" &&
      !trigger &&
      !versionRow?.baseline &&
      attempts <= UNCHECKED_RETRIES &&
      snapshot.submission.attachments.every((x) => x.unreadableTemporary);
    await addCheckResult(
      db,
      {
        submissionVersionId,
        source,
        verdict: merged.verdict,
        findings: {
          promptVersion: REVIEW_PROMPT_VERSION,
          merge: merged,
          unchecked: unreadable,
          ...(retryable ? { retryable: true } : {}),
          ...(trigger ? { trigger: { commentId: trigger.id } } : {}),
        },
        throughCommentId,
      },
      now,
    );
    const base = { status: "reviewed" as const, verdict: merged.verdict, ...reReview };
    if (retryable) return { ...base, retryPending: true };
    if (merged.verdict === "unchecked") {
      const { content, created } = await uncheckedAlert(unreadable);
      return { ...base, ...(content ? { content } : {}), uncheckedAlertCreated: created };
    }
    if (previous && RANK[merged.verdict] <= RANK[previous]) return { ...base, alertCreated: false };
    const llmSkipped: LlmOutcome = { ok: false, error: "nothing readable" };
    const content = qualityContent(snapshot, heuristic, llmSkipped, merged, {
      unchecked: unreadable,
    });
    const { created } = await raiseAlert(
      db,
      {
        key: `quality:${submissionVersionId}${suffix}`,
        level: merged.verdict === "panic" ? "panic" : "alert",
        ...content,
      },
      now,
    );
    return { ...base, content, alertCreated: created };
  }

  const input = buildReviewInput(snapshot, heuristic, opts.budget, opts.lang);
  let llm: LlmOutcome;
  try {
    llm = { ok: true, output: await provider.review(input, { instructions: reviewPrompt() }) };
  } catch (err) {
    llm = { ok: false, error: (err as Error).message };
  }
  const redo = openRedoRequest(snapshot);
  const merged = applyRedoFloor(mergeVerdict(heuristic, llm), redo);
  const due = redo ? redoDue(snapshot.assignment.dueAt, now) : undefined;
  const unchecked = llm.ok ? [...unreadable, ...llm.output.unverifiable] : unreadable;
  const qualityAlert = async () => {
    const content = qualityContent(snapshot, heuristic, llm, merged, {
      unchecked,
      redoDue: due,
    });
    const { created } = await raiseAlert(
      db,
      {
        key: `quality:${submissionVersionId}${suffix}`,
        level: merged.verdict === "panic" ? "panic" : "alert",
        ...content,
      },
      now,
    );
    return { content, created };
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
      const { content, created } = await qualityAlert();
      Object.assign(result, { verdict: "panic", content, alertCreated: created });
    }
    if (failures >= LLM_FAILURE_ALERT_AFTER) {
      const { created } = await raiseAlert(
        db,
        {
          key: `quality:${submissionVersionId}${suffix}:llm-failed`,
          level: "alert",
          code: "quality.llm_failed",
          params: {
            ...itemOf(snapshot.assignment),
            failures,
            provider: provider.name,
            error: llm.error,
          },
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
        ...(unchecked.length ? { unchecked } : {}),
      },
      throughCommentId,
    },
    now,
  );
  // A re-review alerts only when the verdict got worse; an unchanged one would repeat itself.
  const worse = !previous || RANK[merged.verdict] > RANK[previous];
  if (merged.verdict === "ok" || !worse) {
    const result: ReviewSubmissionResult = {
      status: "reviewed",
      verdict: merged.verdict,
      alertCreated: false,
      ...reReview,
    };
    // Unchecked parts of an ok review go to "check by hand"; a warn/panic that isn't worse
    // already had its alert.
    if (merged.verdict === "ok" && unchecked.length) {
      const { content, created } = await uncheckedAlert(unchecked);
      Object.assign(result, { ...(content ? { content } : {}), uncheckedAlertCreated: created });
    }
    return result;
  }
  const { content, created } = await qualityAlert();
  return {
    status: "reviewed",
    verdict: merged.verdict,
    content,
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
          checkResults: {
            where: { source },
            orderBy: { id: "asc" },
            select: { throughCommentId: true, findings: true },
          },
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
    const last = v.checkResults.at(-1);
    if (last && parseFindings(last.findings).retryable === true) return [v.id];
    const seen = Math.max(0, ...v.checkResults.map((r) => r.throughCommentId ?? 0));
    const latestTeacher = s.assignment.comments[0]?.id ?? 0;
    return latestTeacher > seen ? [v.id] : [];
  });
}
