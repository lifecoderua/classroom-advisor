import { readlinkSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { type BrowserContext, chromium } from "playwright";

export class ProfileLockedError extends Error {
  override name = "ProfileLockedError";
  constructor(profileDir: string, detail?: string) {
    super(
      `Chrome profile ${profileDir} is in use${detail ? ` (${detail})` : ""}. ` +
        "Quit the Chrome window that uses it (Cmd+Q) and retry.",
    );
  }
}

export class SessionError extends Error {
  override name = "SessionError";
}

export interface SessionOptions {
  profileDir: string;
  /** Headful by default so a human can see what the collector does. */
  headless?: boolean;
}

export interface Session {
  context: BrowserContext;
  close(): Promise<void>;
}

export interface LockInfo {
  host: string;
  pid: number;
}

/** Chrome's `SingletonLock` is a symlink whose target is `<hostname>-<pid>`. */
export function parseSingletonLock(target: string): LockInfo | undefined {
  const m = /^(.+)-(\d+)$/.exec(target);
  if (!m?.[1] || !m[2]) return undefined;
  return { host: m[1], pid: Number(m[2]) };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface LockCheckDeps {
  readlink?: (path: string) => string;
  host?: string;
  alive?: (pid: number) => boolean;
}

/**
 * Returns the lock holder if Chrome looks like it is running on `profileDir`.
 * A stale lock (same host, dead pid) is ignored; Chrome clears it on launch.
 * A lock from another host counts as held, since we can't check that pid.
 */
export function profileLock(profileDir: string, deps: LockCheckDeps = {}): LockInfo | undefined {
  const readlink = deps.readlink ?? ((p: string) => readlinkSync(p));
  let target: string;
  try {
    target = readlink(join(profileDir, "SingletonLock"));
  } catch {
    return undefined;
  }
  const lock = parseSingletonLock(target);
  if (!lock) return undefined;
  if (lock.host !== (deps.host ?? hostname())) return lock;
  return (deps.alive ?? isAlive)(lock.pid) ? lock : undefined;
}

const LOCK_ERROR =
  /ProcessSingleton|profile (?:appears to be )?in use|SingletonLock|user data directory is already in use/i;

/** Playwright defaults we drop: they would hide the real cookie key or flag automation. */
export const IGNORED_DEFAULT_ARGS = [
  "--use-mock-keychain",
  "--password-store=basic",
  "--enable-automation",
];

/**
 * Opens a persistent Chrome context on the collector profile. Never logs in.
 * Throws {@link ProfileLockedError} if Chrome already runs on the profile.
 */
export async function openSession(options: SessionOptions): Promise<Session> {
  const { profileDir, headless = false } = options;
  const lock = profileLock(profileDir);
  if (lock) throw new ProfileLockedError(profileDir, `pid ${lock.pid} on ${lock.host}`);

  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      channel: "chrome",
      headless,
      viewport: null,
      ignoreDefaultArgs: IGNORED_DEFAULT_ARGS,
    });
  } catch (err) {
    const message = (err as Error).message;
    if (LOCK_ERROR.test(message) || profileLock(profileDir)) {
      throw new ProfileLockedError(profileDir);
    }
    throw new SessionError(`Could not launch Chrome on ${profileDir}: ${message}`);
  }

  let closed = false;
  return {
    context,
    async close() {
      if (closed) return;
      closed = true;
      await context.close().catch(() => undefined);
    },
  };
}

/** Runs `fn` with an open session and always closes it, also on Ctrl+C. */
export async function withSession<T>(
  options: SessionOptions,
  fn: (session: Session) => Promise<T>,
): Promise<T> {
  const session = await openSession(options);
  const onSignal = () => {
    void session.close().finally(() => process.exit(130));
  };
  process.once("SIGINT", onSignal);
  try {
    return await fn(session);
  } finally {
    process.off("SIGINT", onSignal);
    await session.close();
  }
}
