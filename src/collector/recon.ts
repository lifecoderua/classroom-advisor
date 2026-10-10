import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Page, Request, Response } from "playwright";
import { classroomUrl } from "./accounts.ts";

/**
 * Read-only recon (#18): loads Classroom pages and saves the raw traffic for parser work.
 * It only navigates and scrolls. It never clicks, so it cannot turn in, unsubmit or comment.
 * Output goes to `<dataDir>/captures/<accountIndex>/<timestamp>/` and holds real data:
 * it must stay out of git.
 */

export const TODO_PATHS = ["/a/not-turned-in/all", "/a/missing/all", "/a/turned-in/all"] as const;

export interface CapturedExchange {
  seq: number;
  pageUrl: string;
  url: string;
  method: string;
  resourceType: string;
  /** batchexecute `rpcids` query param, if any. */
  rpcids?: string;
  postData?: string;
  status: number;
  contentType?: string;
  body?: string;
  error?: string;
}

export interface CapturedPage {
  url: string;
  finalUrl: string;
  status?: number;
  htmlFile: string;
  exchanges: number;
  /** `AF_initDataCallback` keys found in the server HTML (e.g. `ds:0`). */
  initDataKeys: string[];
  hasWizGlobalData: boolean;
}

/** Only XHR/fetch traffic carries data; scripts, images and fonts are skipped. */
export function isDataRequest(resourceType: string): boolean {
  return resourceType === "xhr" || resourceType === "fetch";
}

export function rpcidsOf(url: string): string | undefined {
  try {
    return new URL(url).searchParams.get("rpcids") ?? undefined;
  } catch {
    return undefined;
  }
}

/** `AF_initDataCallback({key: 'ds:3', ...})` keys present in a page's HTML. */
export function initDataKeys(html: string): string[] {
  return [...html.matchAll(/AF_initDataCallback\(\{key:\s*'([^']+)'/g)].map((m) => m[1] ?? "");
}

/** Filesystem-safe timestamp, e.g. `2026-10-10T08-15-00Z`. */
export function captureStamp(date = new Date()): string {
  return date
    .toISOString()
    .replace(/\.\d+Z$/, "Z")
    .replace(/:/g, "-");
}

/** A short, filesystem-safe label for one exchange. */
export function exchangeLabel(url: string): string {
  const rpc = rpcidsOf(url);
  if (rpc) return rpc.replace(/[^A-Za-z0-9,_-]/g, "_").slice(0, 60);
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60);
  } catch {
    return "unknown";
  }
}

export interface ReconOptions {
  /** Account email; only used as `authuser`, never written to disk paths. */
  email: string;
  /** Directory that receives this run's files. */
  outDir: string;
  /** Classroom paths or absolute URLs to load. */
  targets: string[];
  /** Scroll rounds per page to trigger lazy loads. */
  scrollRounds?: number;
  log?: (line: string) => void;
}

async function scrollToBottom(page: Page, rounds: number): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await page.mouse.wheel(0, 4000).catch(() => undefined);
    await page
      .evaluate(() => {
        const g = globalThis as unknown as {
          document: {
            scrollingElement?: { scrollTop: number; scrollHeight: number };
            querySelectorAll(s: string): ArrayLike<{
              scrollTop: number;
              scrollHeight: number;
              clientHeight: number;
            }>;
          };
        };
        const root = g.document.scrollingElement;
        if (root) root.scrollTop = root.scrollHeight;
        // Classroom scrolls inner containers, not the window.
        for (const el of Array.from(g.document.querySelectorAll("*"))) {
          if (el.scrollHeight > el.clientHeight + 50) el.scrollTop = el.scrollHeight;
        }
      })
      .catch(() => undefined);
    await page.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => undefined);
    await page.waitForTimeout(800);
  }
}

function resolveTarget(email: string, target: string): string {
  if (/^https?:\/\//.test(target)) {
    const url = new URL(target);
    url.searchParams.set("authuser", email);
    return url.toString();
  }
  return classroomUrl(email, target);
}

/** Loads each target in a fresh page and records its HTML plus every XHR/fetch exchange. */
export async function captureTargets(
  context: BrowserContext,
  options: ReconOptions,
): Promise<CapturedPage[]> {
  const { email, outDir, targets, scrollRounds = 4, log = () => undefined } = options;
  mkdirSync(join(outDir, "xhr"), { recursive: true });
  let seq = 0;
  const pages: CapturedPage[] = [];

  for (const [i, target] of targets.entries()) {
    const url = resolveTarget(email, target);
    const page = await context.newPage();
    const pending: Promise<void>[] = [];
    let exchanges = 0;

    const record = async (request: Request, response: Response | null, error?: string) => {
      if (!isDataRequest(request.resourceType())) return;
      const n = ++seq;
      exchanges++;
      const entry: CapturedExchange = {
        seq: n,
        pageUrl: url,
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
        status: response?.status() ?? 0,
      };
      const rpc = rpcidsOf(request.url());
      if (rpc) entry.rpcids = rpc;
      const post = request.postData();
      if (post) entry.postData = post;
      const ct = response?.headers()["content-type"];
      if (ct) entry.contentType = ct;
      if (error) entry.error = error;
      if (response) {
        try {
          entry.body = await response.text();
        } catch (err) {
          entry.error = `body: ${(err as Error).message}`;
        }
      }
      const file = `${String(n).padStart(4, "0")}-${exchangeLabel(entry.url)}.json`;
      writeFileSync(join(outDir, "xhr", file), `${JSON.stringify(entry, null, 2)}\n`);
    };

    page.on("requestfinished", (req) => {
      pending.push(req.response().then((res) => record(req, res)));
    });
    page.on("requestfailed", (req) => {
      pending.push(record(req, null, req.failure()?.errorText ?? "failed"));
    });

    try {
      log(`→ page ${i + 1}/${targets.length}`);
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      const html = response ? await response.text().catch(() => "") : "";
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
      await scrollToBottom(page, scrollRounds);
      await Promise.allSettled(pending);

      const htmlFile = `page-${String(i + 1).padStart(2, "0")}.html`;
      writeFileSync(join(outDir, htmlFile), html);
      // The rendered DOM helps to map positions to what the student sees.
      writeFileSync(
        join(outDir, `page-${String(i + 1).padStart(2, "0")}.dom.html`),
        await page.content(),
      );
      const captured: CapturedPage = {
        url,
        finalUrl: page.url(),
        htmlFile,
        exchanges,
        initDataKeys: initDataKeys(html),
        hasWizGlobalData: html.includes("WIZ_global_data"),
      };
      if (response) captured.status = response.status();
      pages.push(captured);
      log(
        `  ${captured.status ?? "?"} ${exchanges} xhr, ${captured.initDataKeys.length} init blobs`,
      );
    } finally {
      await page.close();
    }
  }

  writeFileSync(
    join(outDir, "manifest.json"),
    `${JSON.stringify({ capturedAt: new Date().toISOString(), pages }, null, 2)}\n`,
  );
  return pages;
}
