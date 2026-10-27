import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { connect } from "node:net";

/** A child process the login starts (Xvfb, x11vnc, websockify, the browser). */
export interface Proc {
  readonly name: string;
  /** Resolves once the process has ended (exit code, null when killed by a signal). */
  readonly exited: Promise<number | null>;
  /** Whether the process has ended. */
  readonly done: boolean;
  kill(signal?: NodeJS.Signals): void;
}

export type Spawn = (
  cmd: string,
  args: readonly string[],
  opts?: { env?: NodeJS.ProcessEnv },
) => Proc;

/** Spawns with output ignored; a missing binary ends the process at once (code -1). */
export const spawnProc: Spawn = (cmd, args, opts = {}) => {
  const child = spawn(cmd, args, { stdio: "ignore", env: opts.env ?? process.env });
  let done = false;
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => {
      done = true;
      resolve(code);
    });
    child.once("error", () => {
      done = true;
      resolve(-1);
    });
  });
  return {
    name: cmd,
    exited,
    get done() {
      return done;
    },
    kill(signal: NodeJS.Signals = "SIGTERM") {
      if (!done) child.kill(signal);
    },
  };
};

/** SIGTERM, then SIGKILL after `graceMs`. Chrome shuts down cleanly on SIGTERM (cookies saved). */
export async function stopProc(proc: Proc, graceMs: number): Promise<void> {
  if (proc.done) return;
  proc.kill("SIGTERM");
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), graceMs);
  });
  const res = await Promise.race([proc.exited, timeout]);
  clearTimeout(timer);
  if (res === "timeout") {
    proc.kill("SIGKILL");
    await proc.exited;
  }
}

/** Polls `check` every 100ms until it's true; false after `timeoutMs`. */
export async function waitUntil(
  check: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return check();
}

/** Whether something accepts TCP connections on `127.0.0.1:port`. */
export function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

export class LoginDisplayError extends Error {
  override name = "LoginDisplayError";
}

export interface VncOptions {
  /** Xvfb screen `WxHxDepth`. */
  screen: string;
  /** noVNC (websockify) port; VNC itself stays on the loopback. */
  port: number;
  /** File holding the one-time VNC password; x11vnc reads and deletes it (`rm:`). */
  passwordFile: string;
  spawn?: Spawn;
  /** Readiness checks, injectable for tests. */
  displayReady?: () => boolean | Promise<boolean>;
  portReady?: (port: number) => Promise<boolean>;
  readyTimeoutMs?: number;
}

export interface VncDisplay {
  /** The X display the browser runs on (`DISPLAY`). */
  display: string;
  stop(): Promise<void>;
}

const DISPLAY_NUM = 99;
const VNC_PORT = 5900;

/**
 * Starts Xvfb + x11vnc + websockify/noVNC for a hand login (D12). x11vnc listens on the loopback
 * only and asks for the one-time password; noVNC on `port` is the way in.
 */
export async function startVnc(opts: VncOptions): Promise<VncDisplay> {
  const run = opts.spawn ?? spawnProc;
  const timeout = opts.readyTimeoutMs ?? 10_000;
  const display = `:${DISPLAY_NUM}`;
  const procs: Proc[] = [];
  const stop = async () => {
    for (const p of [...procs].reverse()) await stopProc(p, 3000);
  };
  const ready = async (proc: Proc, check: () => boolean | Promise<boolean>, what: string) => {
    const ok = await waitUntil(async () => proc.done || (await check()), timeout);
    if (!ok || proc.done) throw new LoginDisplayError(`${what} did not start (is it installed?)`);
  };
  if (!opts.displayReady) {
    // Leftovers of a killed Xvfb would make the display look ready (or block a new one). Nothing
    // else uses this display number.
    rmSync(`/tmp/.X${DISPLAY_NUM}-lock`, { force: true });
    rmSync(`/tmp/.X11-unix/X${DISPLAY_NUM}`, { force: true });
  }
  try {
    const xvfb = run("Xvfb", [display, "-screen", "0", opts.screen, "-nolisten", "tcp"]);
    procs.push(xvfb);
    await ready(
      xvfb,
      opts.displayReady ?? (() => existsSync(`/tmp/.X11-unix/X${DISPLAY_NUM}`)),
      "Xvfb",
    );
    const portReady = opts.portReady ?? portOpen;
    const vnc = run("x11vnc", [
      "-display",
      display,
      "-rfbport",
      String(VNC_PORT),
      "-localhost",
      "-forever",
      "-shared",
      "-quiet",
      "-passwdfile",
      `rm:${opts.passwordFile}`,
    ]);
    procs.push(vnc);
    await ready(vnc, () => portReady(VNC_PORT), "x11vnc");
    const web = run("websockify", [
      "--web",
      "/usr/share/novnc",
      String(opts.port),
      `localhost:${VNC_PORT}`,
    ]);
    procs.push(web);
    await ready(web, () => portReady(opts.port), "websockify (noVNC)");
  } catch (err) {
    await stop();
    throw err;
  }
  return { display, stop };
}
