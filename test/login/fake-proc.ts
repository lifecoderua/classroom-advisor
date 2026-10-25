import type { Proc, Spawn } from "../../src/login/processes.ts";

export interface FakeProc extends Proc {
  cmd: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv | undefined;
  signals: NodeJS.Signals[];
  /** Ends the process as if it exited by itself. */
  exit(code?: number | null): void;
}

/**
 * A process that records its spawn and the signals it gets. By default it exits on SIGTERM;
 * `ignoreTerm` makes it wait for SIGKILL.
 */
export function fakeProc(
  cmd: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
  opts: { ignoreTerm?: boolean } = {},
): FakeProc {
  let resolve!: (code: number | null) => void;
  let done = false;
  const exited = new Promise<number | null>((r) => {
    resolve = r;
  });
  const proc: FakeProc = {
    name: cmd,
    cmd,
    args,
    env,
    signals: [],
    exited,
    get done() {
      return done;
    },
    exit(code = 0) {
      if (done) return;
      done = true;
      resolve(code);
    },
    kill(signal = "SIGTERM") {
      proc.signals.push(signal);
      if (signal === "SIGKILL" || !opts.ignoreTerm) proc.exit(null);
    },
  };
  return proc;
}

/** A `Spawn` that keeps every fake process it starts. */
export function fakeSpawner(opts: { ignoreTerm?: boolean } = {}): {
  spawn: Spawn;
  procs: FakeProc[];
} {
  const procs: FakeProc[] = [];
  return {
    procs,
    spawn: (cmd, args, o) => {
      const p = fakeProc(cmd, args, o?.env, opts);
      procs.push(p);
      return p;
    },
  };
}
