import type { Command } from "commander";
import { cachedImagePath, cachedTextReader } from "../checks/evaluate-heuristics.ts";
import { loadConfig } from "../config/index.ts";
import { createProvider } from "../llm/index.ts";
import { buildReport, formatReport } from "../notify/console.ts";
import { runCycle, runLoop, stubSync } from "../run/cycle.ts";
import { acquireRunLock } from "../run/lock.ts";
import { parseDuration, parseQuietHours } from "../run/schedule.ts";
import { openDb } from "../store/index.ts";

const stamp = () => new Date().toLocaleTimeString("en-GB", { hour12: false });

/** Adds `report` and `run` to the CLI. */
export function registerReportCommands(program: Command): void {
  program
    .command("report")
    .description("Console digest per watched account: panics, alerts, turned-in work, deadlines")
    .option("--since <duration>", "window for alerts and turned-in work (e.g. 24h, 3d)", "24h")
    .option("--all", "every alert (sent ones too) and all turned-in work")
    .action(async (opts: { since: string; all?: boolean }) => {
      const config = loadConfig();
      const now = new Date();
      const since = opts.all ? null : new Date(now.getTime() - parseDuration(opts.since));
      const db = openDb(config);
      try {
        const report = await buildReport(db, {
          now,
          since,
          watchedEmails: config.watchedAccounts,
        });
        console.log(formatReport(report));
      } finally {
        await db.$disconnect();
      }
    });

  program
    .command("run")
    .description("Loop: sync, checks and a digest of new alerts every runIntervalMin minutes")
    .option("--once", "run a single cycle now (ignores quiet hours) and exit")
    .action(async (opts: { once?: boolean }) => {
      const config = loadConfig();
      const quietHours = config.quietHours ? parseQuietHours(config.quietHours) : undefined;
      const lock = acquireRunLock(config.dataDir);
      const db = openDb(config);
      const controller = new AbortController();
      const onSigint = () => {
        if (controller.signal.aborted) process.exit(130);
        console.log("\nStopping after the current step (Ctrl-C again to force).");
        controller.abort();
      };
      process.on("SIGINT", onSigint);
      process.on("SIGTERM", onSigint);
      const log = (line: string) => console.log(`[${stamp()}] ${line}`);
      try {
        const provider = createProvider(config);
        if (!opts.once) {
          const quiet = config.quietHours ? `, quiet ${config.quietHours}` : "";
          log(`every ${config.runIntervalMin} min${quiet}; Ctrl-C to stop`);
        }
        await runLoop({
          intervalMin: config.runIntervalMin,
          ...(quietHours ? { quietHours } : {}),
          once: Boolean(opts.once),
          signal: controller.signal,
          log,
          cycle: async () => {
            log("cycle start");
            const res = await runCycle({
              db,
              sync: stubSync,
              provider,
              readText: cachedTextReader(config.dataDir),
              reviewOptions: { imagePathOf: cachedImagePath(config.dataDir) },
              watchedEmails: config.watchedAccounts,
              signal: controller.signal,
              log,
            });
            if (res.digest) console.log(res.digest);
            const errs = res.errors.length ? `, ${res.errors.length} error(s)` : "";
            log(
              `cycle done: ${res.newAlertIds.length} new alert(s), ${res.reviewed} reviewed${errs}`,
            );
          },
        });
      } finally {
        process.off("SIGINT", onSigint);
        process.off("SIGTERM", onSigint);
        await db.$disconnect();
        lock.release();
      }
    });
}
