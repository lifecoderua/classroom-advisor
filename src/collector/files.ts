import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import type { APIRequestContext } from "playwright";
import { extractText } from "unpdf";
import type { Attachment, Db } from "../store/index.ts";
import { setAttachmentContent } from "../store/index.ts";
import { extractOffice, type OfficeFormat, officeFormat, officePlainText } from "./office.ts";

export const ATTACHMENT_KINDS = [
  "doc",
  "slides",
  "sheet",
  "pdf",
  "image",
  "form",
  "link",
  "youtube",
  "video",
  "other",
] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

/** Kinds we never download: only their metadata (url, title) is used. */
const METADATA_ONLY: ReadonlySet<AttachmentKind> = new Set(["form", "link", "youtube", "video"]);

export const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
export const DEFAULT_FETCH_TIMEOUT_MS = 60_000;

export class SessionExpiredError extends Error {
  override name = "SessionExpiredError";
  constructor(url: string) {
    super(`Google session expired or missing (got a login page for ${url}). Log in by hand.`);
  }
}

export interface FetchTarget {
  driveFileId?: string | null;
  url: string;
  kind: AttachmentKind;
  modifiedAt?: Date | null;
  mime?: string | null;
}

export interface HttpResponse {
  status: number;
  /** Final URL after redirects. */
  url: string;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  body: Buffer;
}

export type HttpGet = (url: string, opts: { timeoutMs: number }) => Promise<HttpResponse>;

/** {@link HttpGet} over Playwright's `context.request`, so the profile cookies apply. */
export function playwrightHttpGet(request: APIRequestContext): HttpGet {
  return async (url, { timeoutMs }) => {
    const res = await request.get(url, { timeout: timeoutMs, failOnStatusCode: false });
    return { status: res.status(), url: res.url(), headers: res.headers(), body: await res.body() };
  };
}

export interface FetchOptions {
  get: HttpGet;
  dataDir: string;
  /** Account email, sent as `authuser=` so the right signed-in account is used. */
  authuser?: string;
  maxBytes?: number;
  timeoutMs?: number;
}

export type FetchResult =
  | {
      ok: true;
      kind: AttachmentKind;
      /**
       * Text (docs/slides/pdf/Office files), csv (sheets) or raw file (images/other), relative to
       * dataDir. Office files (and Slides, exported as pptx) also get `<stem>.office.json`.
       */
      contentPath: string;
      /** sha256 of the file at `contentPath`. */
      contentHash: string;
      /** Raw downloaded file when it differs from `contentPath` (PDFs, Office files, Slides). */
      rawPath?: string;
      cached: boolean;
    }
  | { ok: true; kind: AttachmentKind; metadataOnly: true }
  | { ok: false; kind: AttachmentKind; error: string };

/** Extracts a Drive/Docs file id from common URL shapes (`/d/<id>`, `?id=<id>`). */
export function driveFileIdFromUrl(url: string): string | undefined {
  const m = /\/d\/([A-Za-z0-9_-]{10,})/.exec(url) ?? /[?&]id=([A-Za-z0-9_-]{10,})/.exec(url);
  return m?.[1];
}

/** Google-native mimes, including the internal names Classroom reports (kix, punch, ...). */
const GOOGLE_KIND: Readonly<Record<string, AttachmentKind>> = {
  "application/vnd.google-apps.document": "doc",
  "application/vnd.google-apps.kix": "doc",
  "application/vnd.google-apps.presentation": "slides",
  "application/vnd.google-apps.punch": "slides",
  "application/vnd.google-apps.spreadsheet": "sheet",
  "application/vnd.google-apps.ritz": "sheet",
  "application/vnd.google-apps.form": "form",
  "application/vnd.google-apps.freebird": "form",
};

/** Best-effort kind from url + mime. */
export function attachmentKind(a: { url: string; mime?: string | null }): AttachmentKind {
  const { url } = a;
  const mime = a.mime?.toLowerCase() ?? "";
  if (/docs\.google\.com\/document\//.test(url) || GOOGLE_KIND[mime] === "doc") return "doc";
  if (/docs\.google\.com\/presentation\//.test(url) || GOOGLE_KIND[mime] === "slides")
    return "slides";
  if (/docs\.google\.com\/spreadsheets\//.test(url) || GOOGLE_KIND[mime] === "sheet")
    return "sheet";
  if (/docs\.google\.com\/forms\/|forms\.gle\//.test(url) || GOOGLE_KIND[mime] === "form")
    return "form";
  if (/(?:youtube\.com|youtu\.be)\//.test(url)) return "youtube";
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("image/")) return "image";
  // Videos are large and no checker reads them: metadata only.
  if (mime.startsWith("video/")) return "video";
  if (/drive\.google\.com\//.test(url)) return "other";
  return "link";
}

const IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
};

function extFor(kind: AttachmentKind, mime: string | undefined): string {
  if (kind === "doc") return "txt";
  if (kind === "slides") return "pptx";
  if (kind === "sheet") return "csv";
  if (kind === "pdf") return "pdf";
  const base = mime?.split(";")[0]?.trim().toLowerCase();
  return (base && IMAGE_EXT[base]) || "bin";
}

function withAuthuser(url: string, authuser: string | undefined): string {
  if (!authuser) return url;
  const u = new URL(url);
  u.searchParams.set("authuser", authuser);
  return u.toString();
}

export function exportUrl(kind: AttachmentKind, id: string): string {
  const eid = encodeURIComponent(id);
  switch (kind) {
    case "doc":
      return `https://docs.google.com/document/d/${eid}/export?format=txt`;
    case "slides":
      return `https://docs.google.com/presentation/d/${eid}/export/pptx`;
    case "sheet":
      return `https://docs.google.com/spreadsheets/d/${eid}/export?format=csv`;
    default:
      return `https://drive.google.com/uc?export=download&id=${eid}`;
  }
}

/** Plain-text export of Slides: the fallback when the pptx export fails (e.g. too large). */
export function slidesTextUrl(id: string): string {
  return `https://docs.google.com/presentation/d/${encodeURIComponent(id)}/export/txt`;
}

/** Sidecar with the structure summary of an Office file, next to its `.txt`. */
export const OFFICE_SUMMARY_SUFFIX = ".office.json";

/** `<stem>.office.json` for a `<stem>.txt` content path. */
export function officeSummaryPath(contentPath: string): string {
  return contentPath.replace(/\.txt$/, OFFICE_SUMMARY_SUFFIX);
}

function versionStem(modifiedAt: Date | null | undefined): string {
  return modifiedAt ? modifiedAt.toISOString().replace(/[:.]/g, "-") : "nomod";
}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

async function writeAtomic(path: string, data: Buffer | string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

const LOGIN_URL = /^https:\/\/accounts\.google\.com\//;
const LOGIN_BODY =
  /accounts\.google\.com\/(?:ServiceLogin|v3\/signin|signin|AccountChooser)|id="identifierId"/;

/** True when an HTML body looks like a Google sign-in or account chooser page. */
export function isLoginPage(html: string): boolean {
  return LOGIN_BODY.test(html);
}

function isHtml(res: HttpResponse): boolean {
  return /text\/html/i.test(res.headers["content-type"] ?? "");
}

/** Drive's "can't scan for viruses" page: a form or link that confirms the download. */
export function driveConfirmUrl(html: string, baseUrl: string): string | undefined {
  const form = /<form[^>]*id="download-form"[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/i.exec(
    html,
  );
  if (form?.[1]) {
    const u = new URL(decodeEntities(form[1]), baseUrl);
    for (const m of (form[2] ?? "").matchAll(/<input[^>]*type="hidden"[^>]*>/gi)) {
      const name = /name="([^"]+)"/.exec(m[0])?.[1];
      const value = /value="([^"]*)"/.exec(m[0])?.[1];
      if (name) u.searchParams.set(name, decodeEntities(value ?? ""));
    }
    return u.toString();
  }
  const link = /href="([^"]*[?&]confirm=[^"]+)"/.exec(html);
  return link?.[1] ? new URL(decodeEntities(link[1]), baseUrl).toString() : undefined;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

async function getWithTimeout(get: HttpGet, url: string, timeoutMs: number): Promise<HttpResponse> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([get(url, { timeoutMs }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

class FetchFailure extends Error {}

async function download(
  url: string,
  expectHtml: boolean,
  opts: Required<Pick<FetchOptions, "get" | "maxBytes" | "timeoutMs">>,
): Promise<HttpResponse> {
  let res = await getWithTimeout(opts.get, url, opts.timeoutMs);
  for (let hop = 0; hop < 2; hop++) {
    if (LOGIN_URL.test(res.url)) throw new SessionExpiredError(url);
    if (expectHtml || !isHtml(res)) break;
    const html = res.body.toString("utf8");
    if (LOGIN_BODY.test(html)) throw new SessionExpiredError(url);
    const confirm = res.status === 200 ? driveConfirmUrl(html, res.url) : undefined;
    if (!confirm || hop > 0) {
      throw new FetchFailure(`HTTP ${res.status}: got an HTML page instead of the file`);
    }
    res = await getWithTimeout(opts.get, confirm, opts.timeoutMs);
  }
  if (res.status === 401) throw new SessionExpiredError(url);
  if (res.status < 200 || res.status >= 300) throw new FetchFailure(`HTTP ${res.status}`);
  const declared = Number(res.headers["content-length"]);
  const size = Math.max(res.body.length, Number.isFinite(declared) ? declared : 0);
  if (size > opts.maxBytes) {
    throw new FetchFailure(`file too large (${size} bytes > ${opts.maxBytes})`);
  }
  return res;
}

async function findCached(dir: string, stem: string, ext: string | undefined) {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return undefined;
  }
  const own = names.filter(
    (n) => n.startsWith(`${stem}.`) && !n.endsWith(".tmp") && !n.endsWith(OFFICE_SUMMARY_SUFFIX),
  );
  if (ext) return own.includes(`${stem}.${ext}`) ? { content: `${stem}.${ext}`, own } : undefined;
  // Unknown extension: a `.txt` next to the raw file means we extracted text (PDF, Office).
  const content = own.find((n) => n === `${stem}.txt`) ?? own[0];
  return content ? { content, own } : undefined;
}

/**
 * Writes `<stem>.txt` (plain text) and `<stem>.office.json` (structure) for an Office file.
 * Returns the text, or an error message when the file can't be read.
 */
async function writeOfficeText(
  dir: string,
  stem: string,
  body: Buffer,
  format: OfficeFormat,
): Promise<{ text: string } | { error: string }> {
  try {
    const summary = extractOffice(new Uint8Array(body), format);
    const text = officePlainText(summary);
    await writeAtomic(join(dir, `${stem}${OFFICE_SUMMARY_SUFFIX}`), JSON.stringify(summary));
    await writeAtomic(join(dir, `${stem}.txt`), text);
    return { text };
  } catch (err) {
    return { error: `${format} text extraction failed: ${(err as Error).message}` };
  }
}

/**
 * Downloads one attachment's content into the cache at
 * `<dataDir>/files/<driveFileId>/<modifiedAt|nomod>.<ext>` (one directory per Drive file).
 * A cached copy for the same `modifiedAt` is reused; `nomod` entries are always refetched.
 * Throws only {@link SessionExpiredError}; other failures come back as `{ ok: false }`.
 */
export async function fetchAttachment(
  target: FetchTarget,
  options: FetchOptions,
): Promise<FetchResult> {
  const { kind } = target;
  if (METADATA_ONLY.has(kind)) return { ok: true, kind, metadataOnly: true };
  const opts = {
    get: options.get,
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    timeoutMs: options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
  };
  const id = target.driveFileId ?? driveFileIdFromUrl(target.url);
  if (!id) return { ok: false, kind, error: "no Drive file id" };
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return { ok: false, kind, error: `bad Drive file id ${id}` };

  const relDir = posix.join("files", id);
  const dir = join(options.dataDir, relDir);
  const stem = versionStem(target.modifiedAt);
  // PDFs and Slides (pptx) are recorded by their extracted text; images/other by whatever
  // extension they got (`.txt` when it turned out to be a PDF or an Office file).
  const contentExt =
    kind === "pdf" || kind === "slides"
      ? "txt"
      : kind === "image" || kind === "other"
        ? undefined
        : extFor(kind, undefined);

  if (target.modifiedAt) {
    const hit = await findCached(dir, stem, contentExt);
    // An opaque `.bin` from before Office extraction: detect and extract locally, no refetch.
    if (hit?.content.endsWith(".bin")) {
      const body = await readFile(join(dir, hit.content));
      const format = officeFormat(body);
      if (format) {
        const rawName = `${stem}.${format}`;
        await rename(join(dir, hit.content), join(dir, rawName));
        const out = await writeOfficeText(dir, stem, body, format);
        if ("error" in out) return { ok: false, kind, error: out.error };
        return {
          ok: true,
          kind,
          contentPath: posix.join(relDir, `${stem}.txt`),
          contentHash: sha256(out.text),
          rawPath: posix.join(relDir, rawName),
          cached: true,
        };
      }
    }
    if (hit) {
      const body = await readFile(join(dir, hit.content));
      const raw = hit.own.find((n) => n !== hit.content);
      return {
        ok: true,
        kind,
        contentPath: posix.join(relDir, hit.content),
        contentHash: sha256(body),
        ...(raw ? { rawPath: posix.join(relDir, raw) } : {}),
        cached: true,
      };
    }
  }

  try {
    const url = withAuthuser(exportUrl(kind, id), options.authuser);
    let res: HttpResponse;
    try {
      res = await download(url, false, opts);
    } catch (err) {
      if (kind !== "slides" || !(err instanceof FetchFailure)) throw err;
      // The pptx export failed (too large, say): fall back to plain text, without structure.
      const txt = await download(withAuthuser(slidesTextUrl(id), options.authuser), false, opts);
      await mkdir(dir, { recursive: true });
      await writeAtomic(join(dir, `${stem}.txt`), txt.body);
      return {
        ok: true,
        kind,
        contentPath: posix.join(relDir, `${stem}.txt`),
        contentHash: sha256(txt.body),
        cached: false,
      };
    }
    await mkdir(dir, { recursive: true });
    // Office files are recognized by their zip contents: Drive's mime types are often generic.
    const format = officeFormat(res.body);
    const ext = format ?? extFor(kind, target.mime ?? res.headers["content-type"]);
    const rawName = `${stem}.${ext}`;
    await writeAtomic(join(dir, rawName), res.body);
    if (format) {
      const out = await writeOfficeText(dir, stem, res.body, format);
      if ("error" in out) return { ok: false, kind, error: out.error };
      return {
        ok: true,
        kind,
        contentPath: posix.join(relDir, `${stem}.txt`),
        contentHash: sha256(out.text),
        rawPath: posix.join(relDir, rawName),
        cached: false,
      };
    }
    if (kind === "slides") return { ok: false, kind, error: "Slides export is not a pptx file" };
    if (ext !== "pdf") {
      return {
        ok: true,
        kind,
        contentPath: posix.join(relDir, rawName),
        contentHash: sha256(res.body),
        cached: false,
      };
    }
    let text: string;
    try {
      const out = await extractText(new Uint8Array(res.body), { mergePages: true });
      text = out.text;
    } catch (err) {
      return { ok: false, kind, error: `PDF text extraction failed: ${(err as Error).message}` };
    }
    const textName = `${stem}.txt`;
    await writeAtomic(join(dir, textName), text);
    return {
      ok: true,
      kind,
      contentPath: posix.join(relDir, textName),
      contentHash: sha256(text),
      rawPath: posix.join(relDir, rawName),
      cached: false,
    };
  } catch (err) {
    if (err instanceof SessionExpiredError) throw err;
    return { ok: false, kind, error: (err as Error).message };
  }
}

export interface AttachmentFetchOutcome {
  attachment: Attachment;
  result: FetchResult;
}

/**
 * Fetches content for stored attachments and records `contentPath`/`contentHash`.
 * Rows are updated only when the content changed. Stops on {@link SessionExpiredError}.
 */
export async function fetchAttachmentContents(
  db: Db,
  rows: readonly Attachment[],
  options: FetchOptions,
  now: Date = new Date(),
): Promise<AttachmentFetchOutcome[]> {
  const out: AttachmentFetchOutcome[] = [];
  for (const row of rows) {
    const result = await fetchAttachment(
      {
        url: row.url,
        driveFileId: row.driveFileId,
        modifiedAt: row.modifiedAt,
        mime: row.mime,
        kind: attachmentKind(row),
      },
      options,
    );
    let attachment = row;
    if (
      result.ok &&
      !("metadataOnly" in result) &&
      (row.contentPath !== result.contentPath || row.contentHash !== result.contentHash)
    ) {
      attachment = await setAttachmentContent(
        db,
        row.id,
        { contentPath: result.contentPath, contentHash: result.contentHash },
        now,
      );
    }
    out.push({ attachment, result });
  }
  return out;
}
