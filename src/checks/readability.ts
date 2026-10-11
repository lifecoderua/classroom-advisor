// Which attachments the review can actually read (#43). Pure. An unreadable attachment is not
// a problem with the child's work: it's reported as "not checked automatically" with a reason.

import { extname } from "node:path";

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

const PPT = "old PowerPoint format (.ppt)";
const DOC = "old Word format (.doc)";
const XLS = "old Excel format (.xls)";
const LEGACY_OFFICE: Readonly<Record<string, string>> = {
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

/** Short, parent-facing reason for a failed fetch (see `fetchAttachment` errors). */
export function fetchErrorReason(error: string): string {
  const big = /too large \((\d+) bytes/.exec(error);
  if (big?.[1]) {
    const mb = Math.round(Number(big[1]) / 1024 / 1024);
    return `file too large to download (${mb} MB)`;
  }
  const http = /HTTP (40[134]|410)\b/.exec(error);
  if (http) return `no access to the file (HTTP ${http[1]})`;
  if (/extraction failed/.test(error)) return "the file couldn't be read (damaged or unusual)";
  if (/no Drive file id|bad Drive file id/.test(error)) return "not a Drive file";
  const short = error.length > 120 ? `${error.slice(0, 119)}…` : error;
  return `download failed (${short})`;
}

const NOT_DOWNLOADED = "the file hasn't been downloaded";

/**
 * Whether an unreadable attachment may become readable on a later sync: not downloaded yet, or
 * a download error other than "too large" / a file that couldn't be extracted. Call only for an
 * attachment `unreadableReason` rejects.
 */
export function isTemporaryUnreadable(a: ReadabilityInput): boolean {
  const reason = unreadableReason(a);
  if (reason === NOT_DOWNLOADED) return true;
  if (!a.fetchError || reason !== fetchErrorReason(a.fetchError)) return false;
  return !/too large|extraction failed|Drive file id/.test(a.fetchError);
}

/**
 * Why the review can't read an attachment, or `undefined` when it can (text, image or a
 * structure summary). Empty text of a Google file is readable: it's an empty document.
 */
export function unreadableReason(a: ReadabilityInput): string | undefined {
  if (a.imagePath || a.hasStructure) return undefined;
  const mime = a.mime?.split(";")[0]?.trim().toLowerCase() ?? "";
  const titleExt = ext(a.title);
  if (a.text != null) {
    if (a.kind === "pdf" && !a.text.trim()) return "PDF without a text layer (scanned pages?)";
    return undefined;
  }
  if (
    a.kind === "video" ||
    mime.startsWith("video/") ||
    VIDEO_EXTS.has(titleExt) ||
    /youtube\.com|youtu\.be/.test(a.url)
  ) {
    return "video: needs watching";
  }
  if (mime.startsWith("audio/") || AUDIO_EXTS.has(titleExt)) {
    return "audio recording: needs listening";
  }
  if (a.kind === "form") return "Google Form: the answers can't be read";
  if (a.kind === "link") {
    const h = host(a.url);
    return `external link${h ? ` (${h})` : ""}: its content isn't downloaded`;
  }
  const legacy = LEGACY_OFFICE[mime] ?? LEGACY_OFFICE[titleExt];
  if (legacy) return `${legacy} isn't supported`;
  if (a.fetchError) return fetchErrorReason(a.fetchError);
  if (!a.contentPath) return NOT_DOWNLOADED;
  const cached = ext(a.contentPath);
  if (TEXT_EXTS.has(cached)) return "the downloaded copy couldn't be read";
  if (IMAGE_EXTS.has(cached) || IMAGE_EXTS.has(titleExt)) {
    return `image format ${IMAGE_EXTS.has(cached) ? cached : titleExt} isn't supported`;
  }
  const shown = titleExt && titleExt.length <= 6 ? ` (${titleExt})` : "";
  return `unsupported file format${shown}`;
}
