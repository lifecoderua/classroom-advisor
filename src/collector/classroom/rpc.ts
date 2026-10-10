import type { BrowserContext, Page } from "playwright";
import { classroomUrl } from "../accounts.ts";
import { isLoginPage, SessionExpiredError } from "../files.ts";
import { ParseDriftError } from "./parse-util.ts";

/**
 * Client for Classroom's internal `batchexecute` endpoint (see docs/CLASSROOM-INTERNALS.md).
 *
 * Read-only by construction: {@link READ_ONLY_RPCIDS} is a hard allow-list, and any other
 * rpcid throws before a request is built. Requests are sent through an injected
 * {@link Transport}; {@link playwrightTransport} runs a same-origin `fetch` inside an open
 * Classroom page, so the profile's cookies apply and nothing is clicked.
 */

/** rpcids observed as plain reads during the #18 recon. Never add a state-changing one. */
export const READ_ONLY_RPCIDS = [
  "gXtzob", // courses
  "UG41I", // users
  "pONvgf", // stream-item query (To-do)
  "Zj93ge", // submissions
  "tQShAc", // stream items by key
  "t51ITc", // materials of one item
  "sLc6hf", // comments (read)
  "dpT4Vd", // classwork query
  "O1Xqee", // course membership
  "ZZFlc", // topics
  "Bypadc", // rubrics
] as const;
export type RpcId = (typeof READ_ONLY_RPCIDS)[number];

const ALLOWED: ReadonlySet<string> = new Set(READ_ONLY_RPCIDS);

export class RpcNotAllowedError extends Error {
  override name = "RpcNotAllowedError";
  constructor(rpcid: string) {
    super(`rpcid ${JSON.stringify(rpcid)} is not on the read-only allow-list`);
  }
}

/** A `wrb.fr` error row, an HTTP error, or a response without the expected row. */
export class RpcError extends Error {
  override name = "RpcError";
  constructor(
    readonly rpcid: string,
    message: string,
    /** batchexecute error code from the row's `[5]`, e.g. `[3]` for a bad argument. */
    readonly code?: unknown,
  ) {
    super(`${rpcid}: ${message}`);
  }
}

export function assertReadOnly(rpcid: string): asserts rpcid is RpcId {
  if (!ALLOWED.has(rpcid)) throw new RpcNotAllowedError(rpcid);
}

/** POSTs a form body to a same-origin path (with query) and returns the response text. */
export type Transport = (url: string, body: string) => Promise<string>;

/** What direct RPC calls need, read from one loaded Classroom page. */
export interface ClassroomSession {
  /** Account email, sent as `authuser` in links. */
  authuser: string;
  /** Multi-login prefix: `""` for account 0, else `/u/<n>`. */
  basePath: string;
  /** Path of the page the calls are made from, prefix included (`source-path`). */
  sourcePath: string;
  /** XSRF token (`WIZ_global_data.SNlM0e`), sent as `at`. */
  at: string;
  /** `WIZ_global_data.FdrFJe`, sent as `f.sid`. */
  fsid: string;
  /** Build label (`WIZ_global_data.cfb2h`), sent as `bl`. */
  bl: string;
  hl: string;
  /** Classroom user id of the signed-in student (`x3UoP[0]`). */
  userId: string;
}

// ---- encoding ---------------------------------------------------------------------------

const NUM_MARK = "\u0001num:";

/**
 * A decimal id sent as a JSON **number** (requests send ids as numbers, responses as
 * strings). Serialized textually, so ids beyond 2^53 survive.
 */
export class NumId {
  constructor(readonly id: string) {
    if (!/^\d+$/.test(id)) throw new Error("NumId: not a decimal id");
  }
  toJSON(): string {
    return `${NUM_MARK}${this.id}`;
  }
}
export const num = (id: string): NumId => new NumId(id);

/** JSON.stringify that writes {@link NumId}s as bare numbers. */
export function encodeArgs(args: unknown): string {
  return JSON.stringify(args).replace(/"\\u0001num:(\d+)"/g, "$1");
}

export interface BuiltRequest {
  url: string;
  body: string;
}

export function buildRequest(
  rpcid: string,
  args: unknown,
  session: ClassroomSession,
  reqid: number,
): BuiltRequest {
  assertReadOnly(rpcid);
  const q = new URLSearchParams({
    rpcids: rpcid,
    "source-path": session.sourcePath,
    "f.sid": session.fsid,
    bl: session.bl,
    hl: session.hl,
    "soc-app": "1",
    "soc-platform": "1",
    "soc-device": "1",
    _reqid: String(reqid),
    rt: "c",
  });
  const freq = JSON.stringify([[[rpcid, encodeArgs(args), null, "generic"]]]);
  const body = new URLSearchParams({ "f.req": freq, at: session.at }).toString();
  return { url: `${session.basePath}/_/ClassroomUi/data/batchexecute?${q}`, body };
}

// ---- decoding ---------------------------------------------------------------------------

const XSSI = /^\)\]\}'\n?/;

/** Splits `)]}'` + length-prefixed JSON chunks into the parsed chunks. */
export function parseFrames(body: string): unknown[] {
  let s = body.replace(XSSI, "");
  const out: unknown[] = [];
  while (s.trim()) {
    const m = /^\s*(\d+)\n/.exec(s);
    if (!m) throw new Error("batchexecute: bad framing");
    s = s.slice(m[0].length);
    // Lengths count UTF-16 units of "\n" + json + "\n"; finding the end of the JSON value
    // is simpler and robust to that.
    let depth = 0;
    let inStr = false;
    let i = 0;
    for (; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (c === "\\") i++;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === "[" || c === "{") depth++;
      else if (c === "]" || c === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push(JSON.parse(s.slice(0, i + 1)));
    s = s.slice(i + 1);
  }
  return out;
}

/**
 * Returns the decoded payload of the `wrb.fr` row for `rpcid`.
 * Throws {@link SessionExpiredError} on a login page, {@link RpcError} on an error row and
 * {@link ParseDriftError} on a body that isn't batchexecute framing.
 */
export function unwrapResponse(body: string, rpcid: string): unknown {
  if (!XSSI.test(body)) {
    if (isLoginPage(body)) throw new SessionExpiredError(`batchexecute ${rpcid}`);
    throw new ParseDriftError({ rpcid, detail: "response is not batchexecute framing" });
  }
  let chunks: unknown[];
  try {
    chunks = parseFrames(body);
  } catch (err) {
    throw new ParseDriftError({ rpcid, detail: `bad framing (${(err as Error).name})` });
  }
  for (const chunk of chunks) {
    if (!Array.isArray(chunk)) continue;
    for (const row of chunk) {
      if (!Array.isArray(row) || row[0] !== "wrb.fr" || row[1] !== rpcid) continue;
      if (typeof row[2] !== "string") {
        throw new RpcError(rpcid, `error row (code ${JSON.stringify(row[5] ?? null)})`, row[5]);
      }
      try {
        return JSON.parse(row[2]);
      } catch {
        throw new ParseDriftError({ rpcid, detail: "payload is not JSON" });
      }
    }
    for (const row of chunk) {
      if (Array.isArray(row) && row[0] === "er") {
        throw new RpcError(rpcid, "batch error row", row[1]);
      }
    }
  }
  throw new ParseDriftError({ rpcid, detail: "no wrb.fr row for this rpcid" });
}

// ---- client -----------------------------------------------------------------------------

export interface RpcClient {
  readonly session: ClassroomSession;
  /** Calls one allow-listed rpc and returns its decoded payload. */
  call(rpcid: RpcId, args: unknown): Promise<unknown>;
}

export interface RpcClientOptions {
  /** Pause before each call after the first, to keep the request rate low. */
  delayMs?: number;
}

export function createRpcClient(
  transport: Transport,
  session: ClassroomSession,
  options: RpcClientOptions = {},
): RpcClient {
  const delayMs = options.delayMs ?? 0;
  // Classroom uses a random 4-digit start and steps by 100000.
  let reqid = 1000 + Math.floor(Math.random() * 9000);
  let calls = 0;
  return {
    session,
    async call(rpcid, args) {
      assertReadOnly(rpcid);
      if (calls++ > 0 && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      const req = buildRequest(rpcid, args, session, reqid);
      reqid += 100_000;
      return unwrapResponse(await transport(req.url, req.body), rpcid);
    },
  };
}

// ---- request templates (exact shapes recorded in fixtures/classroom/*.json) --------------

/** Field mask of a stream item, as the To-do page sends it. */
const ITEM_MASK = [
  1,
  1,
  1,
  1,
  1,
  null,
  null,
  [1, 1, 1, null, 1, 1, 1],
  1,
  1,
  1,
  1,
  1,
  1,
  null,
  null,
  null,
  null,
  1,
  null,
  null,
  null,
  1,
  [1],
  1,
  [null, null, 1, 1, 1, null, 1],
];
const WORK_MASK = [
  1,
  1,
  1,
  1,
  1,
  1,
  [1],
  1,
  null,
  [1, 1],
  1,
  1,
  null,
  1,
  [[1, 1, [], [null, 1]], 1, 1],
  null,
  null,
  null,
  1,
];
export const TODO_MASK = [
  [ITEM_MASK, WORK_MASK, [null, 1], null, [1, 1]],
  [ITEM_MASK],
  [ITEM_MASK, WORK_MASK, [1]],
  null,
  null,
  [ITEM_MASK],
];

/** Every To-do bucket (`pONvgf` filter `[14]`, submission `[20]`). */
export const ALL_BUCKETS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] as const;
/** Stream item types the To-do pages ask for: assignment and question. */
const TODO_ITEM_TYPES = [2, 5];

export const TODO_PAGE_SIZE = 100;

/** `pONvgf` args: To-do query for some courses and buckets, one page. */
export function todoArgs(
  courseIds: readonly string[],
  buckets: readonly number[] = ALL_BUCKETS,
  pageToken: string | null = null,
): unknown {
  const filter: unknown[] = [null, courseIds.map((id) => [num(id)]), TODO_ITEM_TYPES, [2]];
  while (filter.length < 14) filter.push(null);
  filter.push([...buckets]);
  return [[TODO_PAGE_SIZE, pageToken, 1, 0], TODO_MASK, [filter]];
}

export const COURSES_MASK = [
  1,
  1,
  null,
  null,
  1,
  1,
  null,
  1,
  [null, 1, 1, 1, null, 1, [1, 1, 1, 0, 0, 0], null, [1], 1, 1, 1, 1, [1, 1], [1, 0]],
  1,
  1,
  null,
  null,
  1,
  null,
  null,
  null,
  null,
  null,
  null,
  [1, 1, 1, 1, 1, 1, 1],
  1,
  null,
  null,
  1,
  null,
  null,
  null,
  [1, 1],
  1,
  1,
  null,
  null,
  1,
  1,
  1,
  1,
  null,
  1,
  1,
  [
    null,
    null,
    null,
    null,
    1,
    1,
    null,
    null,
    1,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    1,
    1,
    1,
    1,
    1,
    1,
  ],
  null,
  [1, 1, 1],
  [1, 1, null, 1],
  1,
  1,
  1,
  [[[1, 1, 1], 1], [[[1, 1]]], 1],
  null,
  1,
  [1, 1],
  null,
  null,
  1,
  null,
  [null, null, 1],
  1,
];

/** `gXtzob` args: the user's courses (all states), one page. */
export function coursesArgs(pageToken: string | null = null): unknown {
  return [
    [100, pageToken, 1, 0],
    COURSES_MASK,
    [[null, [[1]]], null, null, [1, 2, 3], null, null, [1, 2]],
  ];
}

/** `Zj93ge` list mask (state, bucket, grade, attachment count; no attachments). */
export const SUBMISSION_LIST_MASK = [
  null,
  1,
  null,
  null,
  1,
  null,
  1,
  1,
  1,
  null,
  null,
  null,
  1,
  null,
  [1],
  null,
  null,
  null,
  1,
  1,
  1,
  null,
  null,
  null,
  [[1, 1]],
  [[1, 1]],
  [1, [[1, 1, [], [null, 1, 1]], 1, 1, 1]],
  null,
  null,
  null,
  null,
  1,
];
/** `Zj93ge` detail mask: adds the student attachments at `[4]`. */
export const SUBMISSION_ATTACHMENTS_MASK = [null, 1, null, 1];

export interface SubmissionKey {
  studentId: string;
  itemId: string;
  courseId: string;
}

export const SUBMISSIONS_BATCH = 100;

/** `Zj93ge` args for some submission keys (≤ {@link SUBMISSIONS_BATCH} per call). */
export function submissionsArgs(
  keys: readonly SubmissionKey[],
  options: { attachments?: boolean } = {},
): unknown {
  return [
    [null, null, 1, 0],
    options.attachments ? SUBMISSION_ATTACHMENTS_MASK : SUBMISSION_LIST_MASK,
    [null, null, keys.map((k) => [num(k.studentId), [num(k.itemId), [num(k.courseId)]]])],
    1,
  ];
}

// ---- Playwright -------------------------------------------------------------------------

export const SESSION_PAGE = "/a/not-turned-in/all";

const CLASSROOM_ORIGIN = "https://classroom.google.com";

/** What the page hands back: tokens only, plus a boolean for the account check. */
export interface PageGlobals {
  href: string;
  lang: string | null;
  at: string | null;
  fsid: string | null;
  bl: string | null;
  user: string | null;
  /** True when `WIZ_global_data.oPEP7c` (signed-in email) equals the expected email. */
  emailMatches: boolean;
  /** True when the HTML looks like a Google sign-in page. */
  loginPage: boolean;
}

/** Parses `x3UoP` (`%.@.` + JSON array) and returns the user id at `[0]`. */
export function userIdFromX3UoP(raw: string | null): string | null {
  if (!raw) return null;
  const body = raw.replace(/^%\.@\./, "");
  try {
    const v = JSON.parse(body) as unknown;
    if (Array.isArray(v) && typeof v[0] === "string" && /^\d+$/.test(v[0])) return v[0];
  } catch {
    // fall through to a regex for a truncated or odd tail
  }
  return /^\["(\d+)"/.exec(body)?.[1] ?? null;
}

/** `/u/<n>` from a Classroom URL path, or `""` for account 0. */
export function basePathOf(pathname: string): string {
  return /^\/u\/\d+(?=\/|$)/.exec(pathname)?.[0] ?? "";
}

/**
 * Builds a {@link ClassroomSession} from page globals. Throws {@link SessionExpiredError}
 * when the page is a sign-in page or not Classroom, and {@link ParseDriftError} when
 * tokens are missing.
 */
export function sessionFromGlobals(email: string, g: PageGlobals): ClassroomSession {
  const url = new URL(g.href);
  if (url.origin !== CLASSROOM_ORIGIN) {
    throw new SessionExpiredError(`Classroom (landed on ${url.hostname})`);
  }
  if (g.loginPage) throw new SessionExpiredError("Classroom (sign-in form)");
  if (!g.emailMatches) {
    throw new SessionExpiredError("Classroom (page is signed in as a different account)");
  }
  const userId = userIdFromX3UoP(g.user);
  const missing = [
    !g.at && "SNlM0e",
    !g.fsid && "FdrFJe",
    !g.bl && "cfb2h",
    !userId && "x3UoP",
  ].filter(Boolean);
  if (missing.length > 0 || !g.at || !g.fsid || !g.bl || !userId) {
    throw new ParseDriftError({
      rpcid: "WIZ_global_data",
      detail: `missing ${missing.join(", ")}`,
    });
  }
  return {
    authuser: email,
    basePath: basePathOf(url.pathname),
    sourcePath: url.pathname,
    at: g.at,
    fsid: g.fsid,
    bl: g.bl,
    hl: g.lang || "en",
    userId,
  };
}

/** Reads {@link PageGlobals} from a loaded Classroom page. */
export async function readPageGlobals(page: Page, email: string): Promise<PageGlobals> {
  // No named helpers inside the evaluated function: tsx (esbuild keepNames) would wrap them
  // in a `__name` call that doesn't exist in the page.
  const raw = await page.evaluate((expected) => {
    const g = globalThis as unknown as {
      WIZ_global_data?: Record<string, unknown>;
      location: { href: string };
      document: { documentElement: { lang: string; outerHTML: string } };
    };
    const wiz = g.WIZ_global_data ?? {};
    const html = g.document.documentElement.outerHTML;
    return {
      href: g.location.href,
      lang: g.document.documentElement.lang || null,
      at: wiz.SNlM0e,
      fsid: wiz.FdrFJe,
      bl: wiz.cfb2h,
      user: wiz.x3UoP,
      // `oPEP7c` is the signed-in email on Google web apps.
      emailMatches: typeof wiz.oPEP7c === "string" && wiz.oPEP7c.toLowerCase() === expected,
      // Only the sign-in form itself: normal pages link to ServiceLogin (account switcher).
      loginPage: html.includes('id="identifierId"'),
    };
  }, email.toLowerCase());
  const s = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    ...raw,
    at: s(raw.at),
    fsid: s(raw.fsid),
    bl: s(raw.bl),
    user: s(raw.user),
  };
}

/** Runs each request as a same-origin `fetch` inside `page` (cookies included). */
export function playwrightTransport(page: Page): Transport {
  return async (url, body) => {
    const res = await page.evaluate(
      async ({ url, body }) => {
        const r = await fetch(url, {
          method: "POST",
          credentials: "include",
          headers: {
            "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
            "x-same-domain": "1",
          },
          body,
        });
        return { status: r.status, url: r.url, text: await r.text() };
      },
      { url, body },
    );
    const rpcid = new URL(url, CLASSROOM_ORIGIN).searchParams.get("rpcids") ?? "?";
    if (res.status === 401 || /^https:\/\/accounts\.google\.com\//.test(res.url)) {
      throw new SessionExpiredError(`batchexecute ${rpcid}`);
    }
    if (res.status !== 200) {
      if (isLoginPage(res.text)) throw new SessionExpiredError(`batchexecute ${rpcid}`);
      throw new RpcError(rpcid, `HTTP ${res.status}`);
    }
    return res.text;
  };
}

export interface ClassroomPage {
  page: Page;
  session: ClassroomSession;
  transport: Transport;
  close(): Promise<void>;
}

/**
 * Opens one Classroom page for `email` (read-only: it only navigates) and prepares direct
 * RPC calls from it. Never logs in: a sign-in page throws {@link SessionExpiredError}.
 */
export async function openClassroomPage(
  context: BrowserContext,
  email: string,
  path = SESSION_PAGE,
): Promise<ClassroomPage> {
  const page = await context.newPage();
  try {
    await page.goto(classroomUrl(email, path), { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page
      .waitForFunction(
        () =>
          Boolean(
            (globalThis as { WIZ_global_data?: { SNlM0e?: unknown } }).WIZ_global_data?.SNlM0e,
          ),
        null,
        { timeout: 15_000 },
      )
      .catch(() => undefined);
    const session = sessionFromGlobals(email, await readPageGlobals(page, email));
    return {
      page,
      session,
      transport: playwrightTransport(page),
      close: () => page.close().catch(() => undefined),
    };
  } catch (err) {
    await page.close().catch(() => undefined);
    throw err;
  }
}
