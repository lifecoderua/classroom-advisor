import { randomInt } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { contextDeps, discoverAccounts, SessionMissingError } from "../collector/accounts.ts";
import { profileLock, withSession } from "../collector/session.ts";
import type { Config } from "../config/index.ts";
import {
  type Proc,
  type Spawn,
  spawnProc,
  startVnc,
  stopProc,
  type VncDisplay,
  type VncOptions,
} from "./processes.ts";

export type LoginLayout = "desktop" | "phone";

/** Why a login ended: the browser was closed, "done" was asked for, it timed out, or the loop stopped. */
export type LoginEnd = "closed" | "done" | "timeout" | "stopped";

export type LoginConfig = Pick<
  Config,
  | "profileDir"
  | "chromeChannel"
  | "dataDir"
  | "watchedAccounts"
  | "loginMode"
  | "loginPort"
  | "loginBaseUrl"
  | "loginTimeoutMin"
>;

export interface LoginInfo {
  mode: Config["loginMode"];
  layout: LoginLayout;
  startedAt: string;
  expiresAt: string;
  /** noVNC link with the one-time password (`vnc` mode only). */
  url?: string;
}

export interface LoginResult {
  end: LoginEnd;
  /** Accounts with a valid session after the login. */
  loggedIn: string[];
  /** Watched accounts that are still not logged in. */
  missing: string[];
  error?: string;
}

/** `<dataDir>/login.json`: the current or last login, for the `login` CLI (and later the bot). */
export interface LoginState {
  status: "active" | "done";
  info: LoginInfo;
  result?: LoginResult;
  updatedAt: string;
}

/** `<dataDir>/login-request.json`: dropped by `login` / `login --done`, taken by the loop. */
export interface LoginRequest {
  action: "start" | "done";
  layout?: LoginLayout;
  at: string;
}

/** Xvfb screen per layout. Chrome's window can't get much narrower than ~500px. */
const SCREENS: Record<LoginLayout, { w: number; h: number }> = {
  desktop: { w: 1280, h: 900 },
  phone: { w: 540, h: 960 },
};

/** Requests older than this are left over from a loop that died; they are dropped. */
const REQUEST_MAX_AGE_MS = 10 * 60_000;

export const loginStatePath = (dataDir: string) => join(dataDir, "login.json");
export const loginRequestPath = (dataDir: string) => join(dataDir, "login-request.json");

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** Private files: the state holds the one-time password in its link. */
function writePrivate(path: string, body: string): void {
  writeFileSync(path, body, { mode: 0o600 });
}

export function readLoginState(dataDir: string): LoginState | undefined {
  return readJson<LoginState>(loginStatePath(dataDir));
}

export function writeLoginRequest(dataDir: string, req: LoginRequest): void {
  mkdirSync(dataDir, { recursive: true });
  writePrivate(loginRequestPath(dataDir), JSON.stringify(req));
}

/** Reads and removes the request file; a stale or unreadable one is just removed. */
export function takeLoginRequest(dataDir: string, now: Date): LoginRequest | undefined {
  const path = loginRequestPath(dataDir);
  const req = readJson<LoginRequest>(path);
  rmSync(path, { force: true });
  if (!req || (req.action !== "start" && req.action !== "done")) return undefined;
  const at = Date.parse(req.at);
  if (!Number.isFinite(at) || now.getTime() - at > REQUEST_MAX_AGE_MS) return undefined;
  return req;
}

/** Random password; VNC authentication uses at most 8 characters. */
export function loginToken(): string {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  return Array.from({ length: 8 }, () => abc[randomInt(abc.length)]).join("");
}

/**
 * noVNC link that connects at once. The password goes in the fragment, which noVNC reads and
 * the browser never sends to the server.
 */
export function loginUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/vnc.html?autoconnect=1&resize=scale#password=${token}`;
}

/** The link carries the password; it isn't kept once the login ended. */
function withoutUrl(info: LoginInfo): LoginInfo {
  const { url: _url, ...rest } = info;
  return rest;
}

export class LoginError extends Error {
  override name = "LoginError";
}

/**
 * The plain browser binary for a hand login. It runs without Playwright/CDP: Google often
 * refuses to sign in to a browser it sees as automated. Must be the collector's browser (D12).
 */
export function loginBrowserPath(channel: string, platform = process.platform): string {
  if (channel === "chromium") return chromium.executablePath();
  if (channel === "chrome" && platform === "linux") return "/opt/google/chrome/chrome";
  if (channel === "chrome" && platform === "darwin") {
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  }
  throw new LoginError(`no browser path for channel '${channel}' on ${platform}`);
}

export function loginBrowserArgs(opts: {
  profileDir: string;
  mode: Config["loginMode"];
  layout: LoginLayout;
}): string[] {
  const args = [
    `--user-data-dir=${opts.profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];
  if (opts.mode === "vnc") {
    // The container: no sandbox (as Playwright launches it there) and no keyring, so the same
    // "basic" cookie key the collector ends up with.
    const { w, h } = SCREENS[opts.layout];
    args.push(
      "--no-sandbox",
      "--password-store=basic",
      "--start-maximized",
      "--window-position=0,0",
      `--window-size=${w},${h}`,
    );
  }
  args.push("https://classroom.google.com/");
  return args;
}

/** Valid logged-in accounts of the profile (opens it headless). */
export async function profileAccounts(
  config: Pick<Config, "profileDir" | "chromeChannel">,
): Promise<string[]> {
  try {
    const { accounts } = await withSession(
      { profileDir: config.profileDir, channel: config.chromeChannel, headless: true },
      (s) => discoverAccounts(contextDeps(s.context)),
    );
    return accounts.filter((a) => a.valid).map((a) => a.email);
  } catch (err) {
    if (err instanceof SessionMissingError) return [];
    throw err;
  }
}

export interface LoginDeps {
  config: LoginConfig;
  /** Logged-in accounts after the browser closed (default {@link profileAccounts}). */
  checkAccounts?: () => Promise<string[]>;
  spawn?: Spawn;
  startVnc?: (opts: VncOptions) => Promise<VncDisplay>;
  browserPath?: string;
  /** Whether a browser runs on the profile (default: its `SingletonLock`). */
  profileInUse?: () => boolean;
  now?: () => Date;
  token?: () => string;
  /** Default: `<dataDir>/login.json`. */
  saveState?: (state: LoginState) => void;
  log?: (line: string) => void;
}

function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * A hand login on the collector profile (#78, D2: a human types the password). The `run` loop
 * owns it: a request ends the wait between cycles, the loop runs {@link run} instead of a cycle
 * (no sync can touch the profile meanwhile), then syncs.
 */
export class LoginService {
  private requested: LoginLayout | undefined;
  private wake = new AbortController();
  private current: { info: LoginInfo; finish: AbortController } | undefined;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;

  constructor(private readonly deps: LoginDeps) {
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? console.log;
  }

  /** Asks for a login; the loop starts it after the current cycle. No-op while one is open. */
  request(layout: LoginLayout = "desktop"): void {
    if (this.current) return;
    this.requested ??= layout;
    this.wake.abort();
  }

  /** A login was asked for and hasn't started yet. */
  pending(): boolean {
    return this.requested !== undefined && !this.current;
  }

  /** Aborts when a login is requested, so the wait between cycles ends early. */
  wakeSignal(): AbortSignal {
    return this.wake.signal;
  }

  /** The open login, if any. */
  get active(): LoginInfo | undefined {
    return this.current?.info;
  }

  /** Ends the open login ("done"): the browser is closed and the accounts are checked. */
  finish(): boolean {
    if (!this.current) return false;
    this.current.finish.abort();
    return true;
  }

  /** Takes a request file dropped by the `login` CLI. Called on a timer by the loop. */
  pollRequests(): void {
    const req = takeLoginRequest(this.deps.config.dataDir, this.now());
    if (req?.action === "start") this.request(req.layout);
    else if (req?.action === "done") this.finish();
  }

  /** A `login.json` left `active` by a loop that died is marked as ended. */
  resetStale(): void {
    const state = readLoginState(this.deps.config.dataDir);
    if (state?.status !== "active") return;
    this.save({
      status: "done",
      info: withoutUrl(state.info),
      result: { end: "stopped", loggedIn: [], missing: [], error: "the loop stopped" },
      updatedAt: this.now().toISOString(),
    });
  }

  private save(state: LoginState): void {
    if (this.deps.saveState) {
      this.deps.saveState(state);
      return;
    }
    const { dataDir } = this.deps.config;
    mkdirSync(dataDir, { recursive: true });
    writePrivate(loginStatePath(dataDir), `${JSON.stringify(state, null, 2)}\n`);
  }

  /**
   * Opens the browser (on a noVNC display in `vnc` mode) and waits until it is closed, `finish`
   * is called, the timeout passes or `signal` aborts. Then closes everything and checks which
   * accounts are logged in (not after an abort: the process is stopping).
   */
  async run(signal: AbortSignal): Promise<LoginResult> {
    const { config } = this.deps;
    const layout = this.requested ?? "desktop";
    this.requested = undefined;
    this.wake = new AbortController();
    const started = this.now();
    const timeoutMs = config.loginTimeoutMin * 60_000;
    const info: LoginInfo = {
      mode: config.loginMode,
      layout,
      startedAt: started.toISOString(),
      expiresAt: new Date(started.getTime() + timeoutMs).toISOString(),
    };
    const finish = new AbortController();
    this.current = { info, finish };
    const passwordFile = join(config.dataDir, ".login-vnc-pass");
    let display: VncDisplay | undefined;
    let browser: Proc | undefined;
    let end: LoginEnd = "stopped";
    let error: string | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      const inUse = this.deps.profileInUse ?? (() => profileLock(config.profileDir) !== undefined);
      if (inUse()) throw new LoginError("a browser is already open on the profile; close it");
      const path = this.deps.browserPath ?? loginBrowserPath(config.chromeChannel);
      const env: NodeJS.ProcessEnv = { ...process.env };
      if (config.loginMode === "vnc") {
        const token = (this.deps.token ?? loginToken)();
        mkdirSync(config.dataDir, { recursive: true });
        writePrivate(passwordFile, `${token}\n`);
        const { w, h } = SCREENS[layout];
        display = await (this.deps.startVnc ?? startVnc)({
          screen: `${w}x${h}x24`,
          port: config.loginPort,
          passwordFile,
          ...(this.deps.spawn ? { spawn: this.deps.spawn } : {}),
        });
        env.DISPLAY = display.display;
        info.url = loginUrl(config.loginBaseUrl ?? `http://localhost:${config.loginPort}`, token);
      }
      const proc = (this.deps.spawn ?? spawnProc)(
        path,
        loginBrowserArgs({ profileDir: config.profileDir, mode: config.loginMode, layout }),
        { env },
      );
      browser = proc;
      this.save({ status: "active", info, updatedAt: this.now().toISOString() });
      this.log(
        config.loginMode === "vnc"
          ? `login: open on noVNC port ${config.loginPort} for ${config.loginTimeoutMin} min`
          : `login: browser open for ${config.loginTimeoutMin} min`,
      );
      end = await Promise.race([
        proc.exited.then(() => "closed" as const),
        aborted(finish.signal).then(() => "done" as const),
        aborted(signal).then(() => "stopped" as const),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), timeoutMs);
        }),
      ]);
    } catch (err) {
      error = `${(err as Error).name}: ${(err as Error).message}`;
    } finally {
      clearTimeout(timer);
      // SIGTERM lets Chrome shut down cleanly and write its cookies.
      if (browser) await stopProc(browser, 10_000);
      if (display) await display.stop();
      rmSync(passwordFile, { force: true });
    }

    let loggedIn: string[] = [];
    if (!error && end !== "stopped") {
      try {
        loggedIn = await (this.deps.checkAccounts ?? (() => profileAccounts(config)))();
      } catch (err) {
        error = `${(err as Error).name}: ${(err as Error).message}`;
      }
    }
    const have = new Set(loggedIn);
    const missing = config.watchedAccounts.map((e) => e.toLowerCase()).filter((e) => !have.has(e));
    const result: LoginResult = { end, loggedIn, missing, ...(error ? { error } : {}) };
    this.current = undefined;
    this.save({
      status: "done",
      info: withoutUrl(info),
      result,
      updatedAt: this.now().toISOString(),
    });
    this.log(`login: ${formatLoginResult(result, config.watchedAccounts.length)}`);
    return result;
  }
}

/** One line for logs: counts only, no emails. */
export function formatLoginResult(r: LoginResult, watched: number): string {
  if (r.error) return `ended (${r.end}) with an error: ${r.error}`;
  if (r.end === "stopped") return "stopped before the accounts were checked";
  const back = watched - r.missing.length;
  return `ended (${r.end}): ${r.loggedIn.length} account(s) logged in, ${back}/${watched} watched`;
}
