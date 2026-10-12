// Expects-work classification (#61): does a post (an `AssignmentVersion`) ask the student to do
// anything, or is it only a lesson-schedule entry / call invite? Classified lazily (only when a
// reminder would fire), once per content version, with a skeleton cache so a weekly invite that
// only changes its time, topic number, meeting id and passcode costs one LLM call in total.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { LlmProvider } from "../llm/types.ts";
import type { Attachment, Db } from "../store/index.ts";
import { EXPECTS_WORK, type ExpectsWork } from "./deadlines.ts";
import type { ReadText } from "./evaluate-heuristics.ts";
import { kindFromMime } from "./heuristics.ts";
import { allocate, truncate } from "./quality.ts";

/** Versioned domain prompt (`src/checks/prompts/<id>.md`). */
export const EXPECTS_WORK_PROMPT_VERSION = "expects-work.v1";

let promptCache: string | undefined;

export function expectsWorkPrompt(): string {
  promptCache ??= readFileSync(
    new URL(`./prompts/${EXPECTS_WORK_PROMPT_VERSION}.md`, import.meta.url),
    "utf8",
  );
  return promptCache;
}

export const expectsWorkOutputSchema = z.strictObject({
  expectsWork: z.enum(EXPECTS_WORK),
  reason: z.string(),
});
export type ExpectsWorkOutput = z.infer<typeof expectsWorkOutputSchema>;
export const expectsWorkJsonSchema = z.toJSONSchema(expectsWorkOutputSchema, {
  target: "draft-07",
}) as Record<string, unknown>;

/** Source of a verdict reused from an earlier version with the same skeleton hash. */
export const SKELETON_SOURCE = "skeleton";

/** Text budget of the classifier input: cheap, the start of a post decides. */
export const EXPECTS_WORK_BUDGET = { description: 3_000, attachments: 3_000 } as const;
const REASON_MAX = 300;

// ---------------------------------------------------------------------------------------------
// Skeleton

const NOT_WORD_BEFORE = "(?<![\\p{L}\\p{N}_])";
const NOT_WORD_AFTER = "(?![\\p{L}\\p{N}_])";

/** Month and weekday names (en, uk, ru; full, genitive and short forms) → `<date>`. */
const DATE_WORDS = [
  // en
  "jan(?:uary)?",
  "feb(?:ruary)?",
  "mar(?:ch)?",
  "apr(?:il)?",
  "may",
  "june?",
  "july?",
  "aug(?:ust)?",
  "sept?(?:ember)?",
  "oct(?:ober)?",
  "nov(?:ember)?",
  "dec(?:ember)?",
  "mon(?:day)?",
  "tue(?:s|sday)?",
  "wed(?:nesday)?",
  "thu(?:rs|rsday)?",
  "fri(?:day)?",
  "sat(?:urday)?",
  "sun(?:day)?",
  // uk
  "січ(?:ень|ня|\\.)",
  "лют(?:ий|ого|\\.)",
  "берез(?:ень|ня)",
  "бер\\.",
  "квіт(?:ень|ня|\\.)",
  "трав(?:ень|ня|\\.)",
  "черв(?:ень|ня|\\.)",
  "лип(?:ень|ня|\\.)",
  "серп(?:ень|ня|\\.)",
  "верес(?:ень|ня)",
  "вер\\.",
  "жовт(?:ень|ня|\\.)",
  "листопад(?:а)?",
  "лист\\.",
  "груд(?:ень|ня|\\.)",
  "понеділ(?:ок|ка)",
  "вівтор(?:ок|ка)",
  "серед(?:а|у)",
  "четвер(?:га)?",
  "п[’'ʼ]?ятниц(?:я|ю)",
  "субот(?:а|у)",
  "неділ(?:я|ю)",
  // ru
  "январ(?:ь|я)",
  "янв\\.",
  "феврал(?:ь|я)",
  "фев\\.",
  "март(?:а)?",
  "апрел(?:ь|я)",
  "апр\\.",
  "ма(?:й|я)",
  "июн(?:ь|я|\\.)",
  "июл(?:ь|я|\\.)",
  "август(?:а)?",
  "авг\\.",
  "сентябр(?:ь|я)",
  "сент?\\.",
  "октябр(?:ь|я)",
  "окт\\.",
  "ноябр(?:ь|я)",
  "нояб?\\.",
  "декабр(?:ь|я)",
  "дек\\.",
  "понедельник(?:а)?",
  "вторник(?:а)?",
  "сред(?:а|у)",
  "четверг(?:а)?",
  "пятниц(?:а|у)",
  "суббот(?:а|у)",
  "воскресень(?:е|я)",
];

const URL_RE = /(?:https?:\/\/|www\.)[^\s<>"')\]]+/giu;
const TIME_RE = new RegExp(
  `${NOT_WORD_BEFORE}\\d{1,2}[:.]\\d{2}(?:\\s*[ap]\\.?\\s?m\\.?${NOT_WORD_AFTER})?`,
  "giu",
);
const DATE_RE = new RegExp(`${NOT_WORD_BEFORE}(?:${DATE_WORDS.join("|")})${NOT_WORD_AFTER}`, "giu");
/** A word that contains a digit (`6a`, `ab3xy9`, `2026`) → `<n>`. */
const NUMBERISH_RE = /[\p{L}\p{N}_]*\p{N}[\p{L}\p{N}_]*/gu;

/** `https://us02web.zoom.us/j/123?pwd=x` → `<url:usNweb.zoom.us>`: the host stays, ids go. */
function urlToken(url: string): string {
  const withScheme = /^https?:\/\//i.test(url) ? url : `http://${url}`;
  let host = "";
  try {
    host = new URL(withScheme).hostname;
  } catch {
    // keep `<url>`
  }
  return host ? `<url:${host.replace(/\d+/g, "N")}>` : "<url>";
}

/**
 * Normalizes a title or description for the skeleton hash: lowercase; URLs → `<url:host>`
 * (the host stays, so a call invite and a worksheet link don't collide); clock times → `<time>`;
 * month and weekday names → `<date>`; every word containing a digit (dates, meeting ids,
 * passcodes, class names like `6a`) → `<n>`; whitespace collapsed.
 */
export function normalizeSkeleton(text: string): string {
  return text
    .toLowerCase()
    .replace(URL_RE, urlToken)
    .replace(TIME_RE, "<time>")
    .replace(DATE_RE, "<date>")
    .replace(NUMBERISH_RE, "<n>")
    .replace(/\s+/gu, " ")
    .trim();
}

export interface SkeletonInput {
  title: string;
  description: string;
  /** Per attachment: its content hash, or an identity (Drive id / url) when there is no content. */
  attachments: readonly string[];
}

/** Hash of the normalized title + description and the sorted attachment keys. */
export function skeletonHash(input: SkeletonInput): string {
  const key = JSON.stringify([
    "skeleton.v1",
    normalizeSkeleton(input.title),
    normalizeSkeleton(input.description),
    [...input.attachments].sort(),
  ]);
  return createHash("sha256").update(key).digest("hex");
}

// ---------------------------------------------------------------------------------------------
// Loading a version

interface PayloadMaterial {
  title?: unknown;
  url?: unknown;
  driveFileId?: unknown;
  mime?: unknown;
}

export interface ClassifierAttachment {
  title: string;
  kind: string;
  text?: string;
}

export interface ClassifierInput {
  title: string;
  description: string;
  attachments: ClassifierAttachment[];
}

export interface VersionSnapshot {
  versionId: number;
  accountId: number;
  input: ClassifierInput;
  skeleton: SkeletonInput;
  expectsWork: ExpectsWork | null;
  skeletonHash: string | null;
}

const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * Loads one assignment version as classifier input: title and description from its payload,
 * materials from its payload joined with the stored `Attachment` rows (by url) for the content
 * hash and the cached text.
 */
export async function loadVersionSnapshot(
  db: Db,
  versionId: number,
  readText?: ReadText,
): Promise<VersionSnapshot | null> {
  const v = await db.assignmentVersion.findUnique({
    where: { id: versionId },
    include: {
      assignment: {
        select: {
          accountId: true,
          title: true,
          attachments: { where: { owner: "material" }, orderBy: { id: "asc" } },
        },
      },
    },
  });
  if (!v) return null;
  let payload: {
    title?: unknown;
    instructions?: unknown;
    description?: unknown;
    materials?: unknown;
  };
  try {
    payload = JSON.parse(v.payload) as typeof payload;
  } catch {
    payload = {};
  }
  const title = asString(payload.title) ?? v.assignment.title;
  const description = asString(payload.instructions) ?? asString(payload.description) ?? "";
  const materials = Array.isArray(payload.materials)
    ? (payload.materials as PayloadMaterial[])
    : [];
  const rowByUrl = new Map<string, Attachment>(v.assignment.attachments.map((a) => [a.url, a]));

  const attachments: ClassifierAttachment[] = [];
  const keys: string[] = [];
  for (const m of materials) {
    const url = asString(m.url) ?? "";
    const row = rowByUrl.get(url);
    const driveFileId = asString(m.driveFileId) ?? row?.driveFileId ?? null;
    keys.push(row?.contentHash ? `hash:${row.contentHash}` : `id:${driveFileId ?? url}`);
    const text = row && readText ? await readText(row) : undefined;
    attachments.push({
      title: asString(m.title) ?? row?.title ?? url,
      kind: kindFromMime(asString(m.mime) ?? row?.mime ?? null, url),
      ...(text ? { text } : {}),
    });
  }

  return {
    versionId: v.id,
    accountId: v.assignment.accountId,
    input: { title, description, attachments },
    skeleton: { title, description, attachments: keys },
    expectsWork: (EXPECTS_WORK as readonly string[]).includes(v.expectsWork ?? "")
      ? (v.expectsWork as ExpectsWork)
      : null,
    skeletonHash: v.skeletonHash,
  };
}

/** The LLM input: description and attachment texts truncated to `EXPECTS_WORK_BUDGET`. Pure. */
export function buildClassifierInput(input: ClassifierInput): ClassifierInput {
  const caps = allocate(
    input.attachments.map((a) => a.text?.length ?? 0),
    EXPECTS_WORK_BUDGET.attachments,
  );
  return {
    title: input.title,
    description: truncate(input.description, EXPECTS_WORK_BUDGET.description),
    attachments: input.attachments.map((a, i) => ({
      title: a.title,
      kind: a.kind,
      ...(a.text ? { text: truncate(a.text, caps[i] ?? 0) } : {}),
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// Classifying

export type ClassifyStatus =
  /** Already classified; nothing done. */
  | "cached"
  /** Verdict reused from an earlier version with the same skeleton hash; no LLM call. */
  | "skeleton"
  /** The LLM answered. */
  | "llm"
  /** The LLM failed; nothing stored (retried next run). */
  | "failed"
  /** Over this run's LLM budget; left unclassified. */
  | "deferred"
  /** The version doesn't exist. */
  | "missing";

export interface ClassifyResult {
  status: ClassifyStatus;
  expectsWork?: ExpectsWork;
  error?: string;
}

export interface ClassifyOptions {
  provider: LlmProvider;
  readText?: ReadText | undefined;
  /** False: only the skeleton cache may answer (the run's LLM budget is used up). */
  allowLlm?: boolean;
  now?: Date;
}

/**
 * Classifies one assignment version: a stored verdict wins; else an LLM verdict (yes/no) of an
 * earlier version of the same account with the same skeleton hash is reused (`skeleton`); else
 * the LLM is asked (when allowed). Stores the verdict, reason, source and skeleton hash on the
 * version. A provider failure stores only the skeleton hash.
 */
export async function classifyVersion(
  db: Db,
  versionId: number,
  opts: ClassifyOptions,
): Promise<ClassifyResult> {
  const snap = await loadVersionSnapshot(db, versionId, opts.readText);
  if (!snap) return { status: "missing" };
  if (snap.expectsWork) return { status: "cached", expectsWork: snap.expectsWork };
  const now = opts.now ?? new Date();
  const hash = skeletonHash(snap.skeleton);
  if (snap.skeletonHash !== hash) {
    await db.assignmentVersion.update({ where: { id: versionId }, data: { skeletonHash: hash } });
  }

  const earlier = await db.assignmentVersion.findFirst({
    where: {
      id: { not: versionId },
      skeletonHash: hash,
      expectsWork: { in: ["yes", "no"] },
      expectsWorkSource: { startsWith: "llm:" },
      assignment: { accountId: snap.accountId },
    },
    orderBy: { id: "desc" },
    select: { expectsWork: true, expectsWorkReason: true },
  });
  if (earlier?.expectsWork) {
    const expectsWork = earlier.expectsWork as ExpectsWork;
    await store(db, versionId, expectsWork, earlier.expectsWorkReason ?? "", SKELETON_SOURCE, now);
    return { status: "skeleton", expectsWork };
  }

  if (opts.allowLlm === false) return { status: "deferred" };
  try {
    const out = await opts.provider.generate({
      instructions: expectsWorkPrompt(),
      input: buildClassifierInput(snap.input),
      schema: expectsWorkOutputSchema,
      jsonSchema: expectsWorkJsonSchema,
    });
    await store(db, versionId, out.expectsWork, out.reason, `llm:${opts.provider.name}`, now);
    return { status: "llm", expectsWork: out.expectsWork };
  } catch (err) {
    return { status: "failed", error: `${(err as Error).name}: ${(err as Error).message}` };
  }
}

async function store(
  db: Db,
  versionId: number,
  expectsWork: ExpectsWork,
  reason: string,
  source: string,
  now: Date,
): Promise<void> {
  await db.assignmentVersion.update({
    where: { id: versionId },
    data: {
      expectsWork,
      expectsWorkReason: truncate(reason.trim(), REASON_MAX),
      expectsWorkSource: source,
      expectsWorkAt: now,
    },
  });
}
