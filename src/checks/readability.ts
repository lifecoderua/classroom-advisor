// Which attachments the review can actually read (#43). Pure. An unreadable attachment is not
// a problem with the child's work: it's reported as "not checked automatically" with a reason.

import { extname } from "node:path";
import { en } from "../i18n/en.ts";
import type { UnreadableCause, UnreadableCode } from "../store/types.ts";

export interface ReadabilityInput {
  /** Heuristic kind (`kindFromMime`). */
  kind: string;
  title: string;
  url: string;
  mime?: string | null | undefined;
  /** Cached content, relative to dataDir. */
  contentPath?: string | null | undefined;
  /** Why the last fetch failed (see `fetchAttachmentContents`). */
  fetchError?: string | null | undefined;
  /** Extracted text; `undefined`/`null` when there is none. */
  text?: string | null | undefined;
  imagePath?: string | undefined;
  /** An Office/Slides structure summary is available. */
  hasStructure?: boolean | undefined;
}

const PPT = "legacy_ppt";
const DOC = "legacy_doc";
const XLS = "legacy_xls";
const LEGACY_OFFICE: Readonly<Record<string, UnreadableCode>> = {
  "application/vnd.ms-powerpoint": PPT,
  "application/msword": DOC,
  "application/vnd.ms-excel": XLS,
  ".ppt": PPT,
  ".pps": PPT,
  ".doc": DOC,
  ".xls": XLS,
};
const AUDIO_EXTS: ReadonlySet<string> = new Set([
  ".mp3",
  ".m4a",
  ".wav",
  ".ogg",
  ".oga",
  ".aac",
  ".flac",
  ".opus",
  ".amr",
]);
const VIDEO_EXTS: ReadonlySet<string> = new Set([".mp4", ".mov", ".avi", ".mkv", ".webm", ".3gp"]);
const IMAGE_EXTS: ReadonlySet<string> = new Set([".bmp", ".svg", ".tif", ".tiff", ".ico"]);
const TEXT_EXTS: ReadonlySet<string> = new Set([".txt", ".csv", ".md"]);

const ext = (name: string | null | undefined) => (name ? extname(name).toLowerCase() : "");

function host(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, "") || undefined;
  } catch {
    return undefined;
  }
}

/** Structured reason for a failed fetch (see `fetchAttachment` errors). */
export function fetchErrorCause(error: string): UnreadableCause {
  const big = /too large \((\d+) bytes/.exec(error);
  if (big?.[1]) {
    return { code: "too_large", arg: String(Math.round(Number(big[1]) / 1024 / 1024)) };
  }
  const http = /HTTP (40[134]|410)\b/.exec(error);
  if (http?.[1]) return { code: "no_access", arg: http[1] };
  if (/extraction failed/.test(error)) return { code: "extract_failed" };
  if (/no Drive file id|bad Drive file id/.test(error)) return { code: "not_drive" };
  const short = error.length > 120 ? `${error.slice(0, 119)}…` : error;
  return { code: "download_failed", arg: short };
}

/** Short reason for a failed fetch, in English (the LLM input and logs). */
export function fetchErrorReason(error: string): string {
  return en.unreadable(fetchErrorCause(error));
}

/**
 * Whether an unreadable attachment may become readable on a later sync: not downloaded yet, or
 * a download error other than "too large" / a file that couldn't be extracted. Call only for an
 * attachment `unreadableCause` rejects.
 */
export function isTemporaryUnreadable(a: ReadabilityInput): boolean {
  const cause = unreadableCause(a);
  if (cause?.code === "not_downloaded") return true;
  return cause?.code === "download_failed" || cause?.code === "no_access";
}

/**
 * Why the review can't read an attachment, or `undefined` when it can (text, image or a
 * structure summary). Empty text of a Google file is readable: it's an empty document.
 * Rendered per language for the parent; {@link unreadableReason} is the English text.
 */
export function unreadableCause(a: ReadabilityInput): UnreadableCause | undefined {
  if (a.imagePath || a.hasStructure) return undefined;
  const mime = a.mime?.split(";")[0]?.trim().toLowerCase() ?? "";
  const titleExt = ext(a.title);
  if (a.text != null) {
    if (a.kind === "pdf" && !a.text.trim()) return { code: "pdf_no_text" };
    return undefined;
  }
  if (
    a.kind === "video" ||
    mime.startsWith("video/") ||
    VIDEO_EXTS.has(titleExt) ||
    /youtube\.com|youtu\.be/.test(a.url)
  ) {
    return { code: "video" };
  }
  if (mime.startsWith("audio/") || AUDIO_EXTS.has(titleExt)) return { code: "audio" };
  if (a.kind === "form") return { code: "form" };
  if (a.kind === "link") {
    const h = host(a.url);
    return h ? { code: "link", arg: h } : { code: "link" };
  }
  const legacy = LEGACY_OFFICE[mime] ?? LEGACY_OFFICE[titleExt];
  if (legacy) return { code: legacy };
  if (a.fetchError) return fetchErrorCause(a.fetchError);
  if (!a.contentPath) return { code: "not_downloaded" };
  const cached = ext(a.contentPath);
  if (TEXT_EXTS.has(cached)) return { code: "copy_unreadable" };
  if (IMAGE_EXTS.has(cached) || IMAGE_EXTS.has(titleExt)) {
    return { code: "image_format", arg: IMAGE_EXTS.has(cached) ? cached : titleExt };
  }
  return titleExt && titleExt.length <= 6
    ? { code: "unsupported_format", arg: titleExt }
    : { code: "unsupported_format" };
}

/** {@link unreadableCause} as English text (what the LLM gets), or `undefined` when readable. */
export function unreadableReason(a: ReadabilityInput): string | undefined {
  const cause = unreadableCause(a);
  return cause && en.unreadable(cause);
}
