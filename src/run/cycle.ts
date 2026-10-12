import { autoAck, supersedeAlerts } from "../checks/auto-ack.ts";
import { type EvaluateDeadlinesOptions, evaluateDeadlines } from "../checks/evaluate-deadlines.ts";
import type { ReadText } from "../checks/evaluate-heuristics.ts";
import {
  llmSource,
  pendingQualityVersions,
  type ReviewSubmissionOptions,
  reviewSubmission,
} from "../checks/quality.ts";
import { type RecheckResult, recheckAssignments } from "../checks/recheck.ts";
import { DEFAULT_LANG, type Lang } from "../i18n/index.ts";
import type { LlmProvider } from "../llm/index.ts";
import { buildReport, formatReport, reportHasAlerts } from "../notify/console.ts";
import type { Db } from "../store/index.ts";
import { inQuietHours, type QuietHours } from "./schedule.ts";

export interface SyncContext {
  db: Db;
  now: Date;
  log: (line: string) => void;
  /** Assignment ids to re-fetch ignoring caches (`/recheck`, #54). */
  force?: readonly number[];
}

/** Collects and stores fresh Classroom data (`playwrightSync` in `src/sync/`). */
export type SyncFn = (ctx: SyncContext) => Promise<void>;

export interface CycleDeps {
  db: Db;
  sync: SyncFn;
  provider: LlmProvider;
  readText: ReadText;
  reviewOptions?: ReviewSubmissionOptions;
  deadlineOptions?: EvaluateDeadlinesOptions;
  now?: () => Date;
  log?: (line: string) => void;
  watchedEmails?: readonly string[];
  /** Language and IANA time zone of the printed digest. */
  lang?: Lang;
  timeZone?: string;
  /** Stops reviewing further submissions (SIGINT); the current one finishes. */
  signal?: AbortSignal;
  /** Assignment ids to re-check (`/recheck`, #54): re-fetched ignoring caches, reviewed again. */
  recheck?: readonly number[];
}

export interface CycleResult {
  newAlertIds: number[];
  reviewed: number;
  /** Alerts muted automatically this cycle (resolved work, #51). */
  autoAcked: number;
  /** Alerts of replaced turn-ins muted this cycle (#52). */
  superseded: number;
  errors: string[];
  /** The digest of new alerts, or undefined when there are none. */
  digest?: string;
  /** Results of the requested re-checks (empty when none were asked). */
  rechecked: RecheckResult[];
}

/**
 * One `run` cycle: sync → deadline rules → pending quality reviews → digest of the alerts
 * raised during the cycle. A failing step is logged and the remaining steps still run.
 */
export async function runCycle(deps: CycleDeps): Promise<CycleResult> {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? console.log;
  const errors: string[] = [];
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      const msg = `${name} failed: ${(err as Error).name}: ${(err as Error).message}`;
      errors.push(msg);
      log(msg);
    }
  };

  const before = (await db.alert.aggregate({ _max: { id: true } }))._max.id ?? 0;
  const started = now();
  const recheck = [...new Set(deps.recheck ?? [])];

  await step("sync", () =>
    deps.sync({ db, now: now(), log, ...(recheck.length ? { force: recheck } : {}) }),
  );
  await step("deadlines", async () => {
    await evaluateDeadlines(db, now(), deps.deadlineOptions);
  });
  let reviewed = 0;
  await step("quality", async () => {
    const ids = await pendingQualityVersions(db, llmSource(deps.provider));
    for (const id of ids) {
      if (deps.signal?.aborted) break;
      await reviewSubmission(db, id, deps.provider, deps.readText, now(), deps.reviewOptions);
      reviewed++;
    }
  });
  let rechecked: RecheckResult[] = [];
  if (recheck.length) {
    await step("recheck", async () => {
      rechecked = await recheckAssignments(
        db,
        recheck,
        deps.provider,
        deps.readText,
        now(),
        started,
        deps.reviewOptions,
      );
    });
  }
  // Replaced turn-ins retire their alerts (#52), resolved work closes its old ones (#51), both
  // before the digest is built.
  let autoAcked = 0;
  let superseded = 0;
  await step("auto-ack", async () => {
    superseded = (await supersedeAlerts(db, now())).length;
    autoAcked = (await autoAck(db, now())).length;
  });

  const fresh = await db.alert.findMany({
    where: { id: { gt: before }, mutedAt: null },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  const newAlertIds = fresh.map((a) => a.id);
  const result: CycleResult = { newAlertIds, reviewed, autoAcked, superseded, errors, rechecked };
  if (newAlertIds.length) {
    const report = await buildReport(db, {
      now: now(),
      alertIds: newAlertIds,
      ...(deps.watchedEmails ? { watchedEmails: deps.watchedEmails } : {}),
    });
    if (reportHasAlerts(report)) {
      result.digest = formatReport(report, {
        lang: deps.lang ?? DEFAULT_LANG,
        timeZone: deps.timeZone,
      });
    }
  }
  return result;
}

export interface LoopOptions {
  intervalMin: number;
  quietHours?: QuietHours;
  /** A manual cycle was asked for (`/refresh`, `/recheck`): it runs even in quiet hours. */
  manualPending?: () => boolean;
  /** IANA zone of `quietHours` (default: the process zone). */
  timeZone?: string;
  /** One cycle, ignoring quiet hours. */
  once?: boolean;
  cycle: () => Promise<unknown>;
  now?: () => Date;
  /** Resolves after `ms` or as soon as `signal` aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  signal: AbortSignal;
  log?: (line: string) => void;
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Runs `cycle` every `intervalMin` minutes until `signal` aborts; skips quiet hours. */
export async function runLoop(opts: LoopOptions): Promise<{ cycles: number; skipped: number }> {
  const now = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? abortableSleep;
  const log = opts.log ?? console.log;
  let cycles = 0;
  let skipped = 0;
  while (!opts.signal.aborted) {
    const manual = opts.manualPending?.() ?? false;
    if (
      !opts.once &&
      !manual &&
      opts.quietHours &&
      inQuietHours(opts.quietHours, now(), opts.timeZone)
    ) {
      skipped++;
      log("quiet hours: skipping this cycle");
    } else {
      cycles++;
      await opts.cycle();
    }
    if (opts.once || opts.signal.aborted) break;
    await sleep(opts.intervalMin * 60_000, opts.signal);
  }
  return { cycles, skipped };
}
