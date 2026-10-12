import type { Command } from "commander";
import {
  cachedImagePath,
  cachedOfficeReader,
  cachedTextReader,
} from "../checks/evaluate-heuristics.ts";
import { loadConfig } from "../config/index.ts";
import { replaceTelegramChat } from "../config/local.ts";
import { createProvider } from "../llm/index.ts";
import { buildReport, formatReport } from "../notify/console.ts";
import { TelegramApi, TelegramNotifier, telegramStatePath } from "../notify/telegram.ts";
import { abortableSleep, runCycle, runLoop } from "../run/cycle.ts";
import { acquireRunLock } from "../run/lock.ts";
import { parseDuration, parseQuietHours } from "../run/schedule.ts";
import { openDb } from "../store/index.ts";
import { formatOutcome, playwrightSync, runSync } from "../sync/index.ts";

const stamp = () => new Date().toLocaleTimeString("en-GB", { hour12: false });

/** Adds `sync`, `report` and `run` to the CLI. */
export function registerReportCommands(program: Command): void {
  program
    .command("sync")
    .description(
      "Read-only: sync watched accounts from Classroom into the DB (prints counts only, no titles)",
    )
    .option("--account <n>", "only this watched account (0-based index in the watch list)")
    .option("--headful", "show the Chrome window (headless by default)")
    .action(async (opts: { account?: string; headful?: boolean }) => {
      const config = loadConfig();
      const lock = acquireRunLock(config.dataDir);
      const db = openDb(config);
      try {
        const outcomes = await runSync(db, config, {
          headless: !opts.headful,
          ...(opts.account !== undefined ? { account: Number(opts.account) } : {}),
          log: () => undefined,
        });
        for (const o of outcomes) console.log(formatOutcome(o));
        if (outcomes.some((o) => o.status !== "ok")) process.exitCode = 1;
      } finally {
        await db.$disconnect();
        lock.release();
      }
    });

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
          backlog: { forgetDays: config.backlogForgetDays },
          upcoming: { days: config.upcomingDays },
          ...(since ? { autoClosedSince: since } : {}),
        });
        console.log(formatReport(report, { lang: config.digestLang, timeZone: config.timeZone }));
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
        const notifier =
          config.telegramBotToken && config.telegramChatIds.length > 0
            ? new TelegramNotifier({
                db,
                api: new TelegramApi(config.telegramBotToken),
                chatIds: config.telegramChatIds,
                digestTime: config.telegramDigestTime,
                backlogForgetDays: config.backlogForgetDays,
                upcomingDays: config.upcomingDays,
                refreshCooldownMin: config.refreshCooldownMin,
                lang: config.digestLang,
                timeZone: config.timeZone,
                onChatMigrated: (from, to) => {
                  if (replaceTelegramChat(process.cwd(), from, to)) {
                    log("telegram: config.local.json updated with the supergroup's chat id");
                  }
                },
                ...(quietHours ? { quietHours } : {}),
                statePath: telegramStatePath(config.dataDir),
                watchedEmails: config.watchedAccounts,
                log,
              })
            : undefined;
        if (notifier) {
          await notifier.setup();
          log(
            `telegram: ${notifier.chats.length} chat(s), digest at ${config.telegramDigestTime} (${config.timeZone}, ${config.digestLang})`,
          );
        } else if (config.telegramBotToken) {
          log("telegram: token set but no chat linked (run telegram link); console only");
        }
        if (!opts.once) {
          const quiet = config.quietHours ? `, quiet ${config.quietHours}` : "";
          log(`every ${config.runIntervalMin} min${quiet}; Ctrl-C to stop`);
        }
        await runLoop({
          intervalMin: config.runIntervalMin,
          ...(quietHours ? { quietHours } : {}),
          timeZone: config.timeZone,
          // `/refresh` and `/recheck` run a cycle now, even in quiet hours.
          ...(notifier ? { manualPending: () => notifier.manualPending() } : {}),
          once: Boolean(opts.once),
          signal: controller.signal,
          log,
          // With Telegram, the wait between cycles long-polls for commands and sends the digest.
          sleep: notifier ? (ms, signal) => notifier.idle(ms, signal) : abortableSleep,
          cycle: async () => {
            log("cycle start");
            const recheck = notifier?.startCycle() ?? [];
            const work = runCycle({
              db,
              sync: playwrightSync(config),
              deadlineOptions: { lookbackDays: config.alertLookbackDays },
              provider,
              readText: cachedTextReader(config.dataDir),
              reviewOptions: {
                imagePathOf: cachedImagePath(config.dataDir),
                readOffice: cachedOfficeReader(config.dataDir),
                lang: config.digestLang,
              },
              watchedEmails: config.watchedAccounts,
              lang: config.digestLang,
              timeZone: config.timeZone,
              signal: controller.signal,
              log,
              recheck,
            });
            // With Telegram, commands keep being answered while the cycle runs.
            const res = notifier ? await notifier.during(work) : await work;
            if (res.digest) console.log(res.digest);
            await notifier?.afterCycle(res);
            const errs = res.errors.length ? `, ${res.errors.length} error(s)` : "";
            log(
              `cycle done: ${res.newAlertIds.length} new alert(s), ${res.reviewed} reviewed, ${res.autoAcked} auto-closed, ${res.superseded} superseded${errs}`,
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
