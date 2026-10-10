// Turned-in heuristics (D6): pure functions over a plain snapshot. They emit signals with a
// confidence for the LLM pass; only clear-cut cases (an untouched template) carry a direct verdict.

import type { ReviewInput } from "../llm/types.ts";

/** Same shape as `ReviewInput.signals[number]`. */
export type Signal = ReviewInput["signals"][number];

export type SignalCode =
  | "no_attachments"
  | "fewer_attachments_than_expected"
  | "template_unchanged"
  | "empty_or_tiny_doc"
  | "fetch_failed"
  | "kind_hint";

export type KindHint = "quiz" | "online_test" | "link_only" | "material";

/**
 * Attachment/material kinds: `doc`, `slides`, `sheet`, `form`, `pdf`, `image`, `video`, `link`,
 * `file` (see `kindFromMime`). Unknown kinds are treated like `file`.
 */
export interface HeuristicMaterial {
  kind: string;
  title: string;
  driveFileId?: string | null | undefined;
  /** Extracted text; `undefined`/`null` when not fetched. */
  text?: string | null | undefined;
  /** "Make a copy for each student". */
  isTemplate?: boolean | undefined;
}

export interface HeuristicAttachment {
  kind: string;
  title: string;
  driveFileId?: string | null | undefined;
  /** Extracted text; `undefined`/`null` when not fetched, `""` when fetched and empty. */
  text?: string | null | undefined;
  /** Drive id of the template this file was copied from, when known. */
  templateSourceId?: string | null | undefined;
  bytes?: number | null | undefined;
  /** Absolute path to a local image of the attachment (carried for the LLM pass). */
  imagePath?: string | undefined;
}

export interface TurnedInInput {
  assignment: {
    kind: string;
    title: string;
    instructions: string;
    materials: readonly HeuristicMaterial[];
    /** Context for the LLM pass; unused by the heuristics. */
    courseName?: string | undefined;
    dueAt?: Date | null | undefined;
  };
  submission: {
    state: string;
    turnedInAt?: Date | null | undefined;
    attachments: readonly HeuristicAttachment[];
  };
}

export interface DirectVerdict {
  level: "panic" | "alert";
  reason: string;
}

export interface TurnedInResult {
  signals: Signal[];
  directVerdict?: DirectVerdict;
}

/** Google-native kinds: a text export always exists, so missing text means the fetch failed. */
const TEXT_KINDS: ReadonlySet<string> = new Set(["doc", "slides", "sheet"]);
const LINK_KINDS: ReadonlySet<string> = new Set(["link", "video", "form"]);
const DONE: ReadonlySet<string> = new Set(["turned_in", "returned"]);

// Keyword stems (lowercase, matched as substrings of normalized text). Keep these small.
const EXPECTS_UPLOAD = [
  "прикріп",
  "прикрип",
  "надішл",
  "фото",
  "сфотограф",
  "завантаж",
  "виконай",
  "зошит",
  "attach",
  "upload",
  "submit",
  "photo",
  "picture",
];
const ONLINE_TEST = [
  "тест",
  "онлайн",
  "naurok",
  "наурок",
  "vseosvita",
  "всеосвіт",
  "kahoot",
  "quizizz",
  "wordwall",
  "learningapps",
  "test",
  "online",
  "quiz",
];

export const TINY_WORDS = 15;
export const UNCHANGED_SIMILARITY = 0.98;
/** At or above this, the copy is treated as identical to the template. */
export const IDENTICAL_SIMILARITY = 0.999;
/** Templates shorter than this can't support a direct verdict (too little to compare). */
const MIN_TEMPLATE_WORDS = 5;
const MAX_EXPECTED = 10;

/** Lowercases, unifies apostrophes and splits into letter/digit tokens. */
export function tokenize(text: string): string[] {
  return (
    text
      .toLowerCase()
      .replace(/['’ʼ`]/g, "")
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

function normalize(text: string): string {
  return tokenize(text).join(" ");
}

function shingles(tokens: readonly string[], size = 3): Set<string> {
  if (tokens.length < size) return new Set(tokens.length ? [tokens.join(" ")] : []);
  const out = new Set<string>();
  for (let i = 0; i + size <= tokens.length; i++) out.add(tokens.slice(i, i + size).join(" "));
  return out;
}

/** Jaccard similarity of word 3-shingles, in [0, 1]. Two empty texts are 1. */
export function similarity(a: string, b: string): number {
  const sa = shingles(tokenize(a));
  const sb = shingles(tokenize(b));
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const s of sa) if (sb.has(s)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/** Words in `text` that are not accounted for by `base` (multiset difference). */
export function addedWordCount(text: string, base = ""): number {
  const left = new Map<string, number>();
  for (const t of tokenize(base)) left.set(t, (left.get(t) ?? 0) + 1);
  let n = 0;
  for (const t of tokenize(text)) {
    const c = left.get(t) ?? 0;
    if (c > 0) left.set(t, c - 1);
    else n++;
  }
  return n;
}

function mentions(text: string, stems: readonly string[]): boolean {
  return stems.some((s) => text.includes(s));
}

const COUNT_RE =
  /(\d{1,2})\s*(завдан|вправ|сторін|фото|аркуш|малюн|task|exercise|page|photo|sheet|picture)/gu;

/** Number of parts the instructions ask for: "3 фото", "2 pages", or a numbered list. */
export function expectedPartsFromInstructions(instructions: string): number {
  const lower = instructions.toLowerCase();
  let n = 0;
  for (const m of lower.matchAll(COUNT_RE)) n = Math.max(n, Number(m[1]));
  const listed = lower.split("\n").filter((l) => /^\s*\d{1,2}\s*[.)]\s+\S/.test(l)).length;
  if (listed >= 2) n = Math.max(n, listed);
  return Math.min(n, MAX_EXPECTED);
}

export function kindHints(input: TurnedInInput): Signal[] {
  const a = input.assignment;
  const text = normalize(`${a.title}\n${a.instructions}`);
  const out: Signal[] = [];
  const hint = (detail: KindHint, confidence: number) =>
    out.push({ code: "kind_hint", confidence, detail });

  if (a.kind === "material") hint("material", 1);
  if (a.kind === "quiz" || a.materials.some((m) => m.kind === "form")) hint("quiz", 0.9);
  else if (mentions(text, ONLINE_TEST)) hint("online_test", 0.6);
  if (a.materials.length > 0 && a.materials.every((m) => LINK_KINDS.has(m.kind))) {
    hint("link_only", 0.7);
  }
  return out;
}

const clamp = (x: number) => Math.round(Math.min(0.95, Math.max(0.05, x)) * 100) / 100;

function hasHint(hints: readonly Signal[], ...details: KindHint[]): boolean {
  return hints.some((h) => details.includes(h.detail as KindHint));
}

/** Signals for one turned-in submission. Not turned in → no signals. */
export function turnedInSignals(input: TurnedInInput): TurnedInResult {
  const { assignment: a, submission: s } = input;
  if (!DONE.has(s.state)) return { signals: [] };

  const hints = kindHints(input);
  const signals: Signal[] = [...hints];
  if (hasHint(hints, "material")) return { signals };

  const instr = normalize(`${a.title}\n${a.instructions}`);
  const templates = a.materials.filter((m) => m.isTemplate);
  const expectsUpload = mentions(instr, EXPECTS_UPLOAD);

  if (s.attachments.length === 0) {
    let c = 0.5;
    const why: string[] = [];
    const adjust = (when: boolean, delta: number, reason: string) => {
      if (!when) return;
      c += delta;
      why.push(reason);
    };
    adjust(expectsUpload, 0.25, "instructions ask to attach/submit");
    adjust(templates.length > 0, 0.3, "a template was provided");
    adjust(hasHint(hints, "quiz", "online_test"), -0.3, "looks like a quiz/online test");
    adjust(hasHint(hints, "link_only"), -0.15, "materials are links only");
    adjust(a.kind === "question", -0.3, "question post (answer typed inline)");
    adjust(!a.instructions.trim() && a.materials.length === 0, -0.25, "no instructions");
    signals.push({
      code: "no_attachments",
      confidence: clamp(c),
      detail: why.length ? why.join("; ") : "nothing attached",
    });
    return { signals };
  }

  const fromTemplates = templates.length;
  const fromInstructions = expectedPartsFromInstructions(a.instructions);
  if (s.attachments.length < fromTemplates) {
    signals.push({
      code: "fewer_attachments_than_expected",
      confidence: 0.6,
      detail: `${s.attachments.length} attached, ${fromTemplates} templates provided`,
    });
  } else if (s.attachments.length < fromInstructions) {
    signals.push({
      code: "fewer_attachments_than_expected",
      // Several parts often fit in one file or photo.
      confidence: 0.3,
      detail: `${s.attachments.length} attached, instructions mention ${fromInstructions} parts`,
    });
  }

  const withText = a.materials.filter((m): m is HeuristicMaterial & { text: string } =>
    Boolean(m.text?.trim()),
  );
  let unchanged = 0;
  let identical = 0;
  for (const att of s.attachments) {
    if (att.bytes === 0) {
      signals.push({
        code: "empty_or_tiny_doc",
        confidence: 0.9,
        detail: `"${att.title}" is 0 bytes`,
      });
      continue;
    }
    if (att.text == null) {
      if (TEXT_KINDS.has(att.kind)) {
        signals.push({
          code: "fetch_failed",
          confidence: 0.9,
          detail: `"${att.title}" has no text`,
        });
      }
      continue;
    }

    let best: { m: HeuristicMaterial & { text: string }; sim: number } | undefined;
    for (const m of withText) {
      const sim = similarity(att.text, m.text);
      if (!best || sim > best.sim) best = { m, sim };
    }
    if (best && best.sim >= UNCHANGED_SIMILARITY) {
      unchanged++;
      const same = best.sim >= IDENTICAL_SIMILARITY;
      if (same && tokenize(best.m.text).length >= MIN_TEMPLATE_WORDS) identical++;
      signals.push({
        code: "template_unchanged",
        confidence: same ? 0.99 : 0.8,
        detail: `"${att.title}" matches "${best.m.title}" (similarity ${best.sim.toFixed(3)})`,
      });
      continue;
    }

    const base = best && best.sim >= 0.3 ? best.m.text : "";
    const words = addedWordCount(att.text, base);
    if (words < TINY_WORDS) {
      signals.push({
        code: "empty_or_tiny_doc",
        confidence: clamp(words === 0 ? 0.8 : 0.6 - (0.3 * words) / TINY_WORDS),
        detail: `"${att.title}" has ${words} own words`,
      });
    }
  }

  // Clear-cut only when every attachment is an untouched copy (no photo of work on the side).
  if (identical > 0 && identical === unchanged && unchanged === s.attachments.length) {
    return {
      signals,
      directVerdict: { level: "panic", reason: "Turned in the template without changes." },
    };
  }
  return { signals };
}

/** Maps a Drive/HTTP mime type (and url) to a heuristic kind. */
export function kindFromMime(mime?: string | null, url = ""): string {
  if (/youtube\.com|youtu\.be/.test(url)) return "video";
  switch (mime) {
    case "application/vnd.google-apps.document":
      return "doc";
    case "application/vnd.google-apps.presentation":
      return "slides";
    case "application/vnd.google-apps.spreadsheet":
      return "sheet";
    case "application/vnd.google-apps.form":
      return "form";
    case "application/pdf":
      return "pdf";
  }
  if (mime?.startsWith("image/")) return "image";
  if (mime?.startsWith("video/")) return "video";
  if (!mime) return /docs\.google\.com\/forms/.test(url) ? "form" : "link";
  return "file";
}
