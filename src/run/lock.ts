import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

export class RunLockedError extends Error {
  override name = "RunLockedError";
}

export interface RunLock {
  path: string;
  release(): void;
}

interface LockInfo {
  pid: number;
  host?: string;
  startedAt?: string;
}

export function lockPath(dataDir: string): string {
  return join(dataDir, "run.lock");
}

/** `process.kill(pid, 0)` probe: EPERM means the process exists but belongs to someone else. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readInfo(path: string): LockInfo | undefined {
  try {
    const info = JSON.parse(readFileSync(path, "utf8")) as LockInfo;
    return Number.isInteger(info.pid) && info.pid > 0 ? info : undefined;
  } catch {
    return undefined;
  }
}

export interface AcquireOptions {
  pid?: number;
  isAlive?: (pid: number) => boolean;
  now?: Date;
}

/**
 * Creates `<dataDir>/run.lock` exclusively with `{pid, host, startedAt}`. A lock whose PID is
 * gone on this host (or that can't be read) is stale and replaced; a live one throws.
 */
export function acquireRunLock(dataDir: string, opts: AcquireOptions = {}): RunLock {
  const path = lockPath(dataDir);
  const pid = opts.pid ?? process.pid;
  const isAlive = opts.isAlive ?? pidAlive;
  const host = hostname();
  mkdirSync(dirname(path), { recursive: true });
  const body = JSON.stringify({
    pid,
    host,
    startedAt: (opts.now ?? new Date()).toISOString(),
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, body, { flag: "wx" });
      return {
        path,
        release() {
          if (readInfo(path)?.pid === pid) rmSync(path, { force: true });
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const info = readInfo(path);
    // A lock from another host can't be probed; trust it. Our own PID on this host is stale: in a
    // restarted container the new process often gets the same PID as the one that left the lock.
    const live =
      info &&
      (info.host !== undefined && info.host !== host
        ? true
        : info.pid !== pid && isAlive(info.pid));
    if (live) {
      throw new RunLockedError(
        `another run is active (pid ${info.pid}${info.startedAt ? `, since ${info.startedAt}` : ""}); remove ${path} if that's wrong`,
      );
    }
    rmSync(path, { force: true });
  }
  throw new RunLockedError(`could not acquire ${path}`);
}
