// Sync orchestrator (#19): opens the collector profile once, then syncs each watched account
// through one headless Classroom page (direct read-only RPCs, see docs/ARCHITECTURE.md).

import { contextDeps, discoverAccounts, type GoogleAccount } from "../collector/accounts.ts";
import { openClassroomPage } from "../collector/classroom/rpc.ts";
import { playwrightHttpGet, SessionExpiredError } from "../collector/files.ts";
import { openSession } from "../collector/session.ts";
import type { Config } from "../config/index.ts";
import { accountLabel } from "../notify/console.ts";
import type { SyncFn } from "../run/cycle.ts";
import {
  type Account,
  type Db,
  finishSyncRun,
  setWatchedAccounts,
  startSyncRun,
  upsertAccount,
} from "../store/index.ts";
import {
  emptyStats,
  type SyncAccountResult,
  type SyncStats,
  sessionAlert,
  syncAccount,
} from "./account.ts";

export * from "./account.ts";
export * from "./normalize.ts";

/** Mirrors the config watch list to `Account.watched` and returns the watched rows. */
export async function syncWatchList(db: Db, emails: readonly string[]): Promise<Account[]> {
  const list = [...new Set(emails.map((e) => e.trim().toLowerCase()))];
  await setWatchedAccounts(db, list);
  const rows = await db.account.findMany({ where: { watched: true } });
  const order = new Map(list.map((e, i) => [e, i]));
  return rows.sort((a, b) => (order.get(a.email) ?? 0) - (order.get(b.email) ?? 0));
}

export interface AccountOutcome extends SyncAccountResult {
  /** Index in the watch list (log lines never carry emails). */
  index: number;
}

export interface SyncOptions {
  headless?: boolean;
  /** Only this index of the watch list. */
  account?: number;
  /** Assignment ids (DB) whose details and files are re-fetched ignoring caches (`/recheck`). */
  force?: readonly number[];
}

/** One line of counts for a sync outcome. No titles, names or emails. */
export function formatOutcome(o: AccountOutcome): string {
  const s: SyncStats = o.stats;
  const events = Object.entries(s.events)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  const f = s.files;
  const c = s.comments;
  return [
    `Account #${o.index}: ${o.status}${s.baseline ? " (baseline)" : ""}`,
    `${s.items} item(s) in ${s.courses} course(s)${s.skippedItems ? ` (+${s.skippedItems} skipped: drift)` : ""}`,
    `details ${s.details}${s.detailErrors ? ` (+${s.detailErrors} failed)` : ""}`,
    `assignments new ${s.assignments.new} / updated ${s.assignments.updated}`,
    `submission versions ${s.submissionVersions}`,
    `events ${events || "none"}`,
    `files ${f.fetched} fetched, ${f.cached} cached, ${f.failed} failed`,
    `comments ${c.fetched} (${c.new} new, ${c.teacherAlerts} teacher alerts${
      c.errors ? `, ${c.errors} failed calls` : ""
    })`,
  ].join("; ");
}

/**
 * Syncs every watched account through the collector profile. Never logs in: a missing or
 * expired session is recorded (run log + alert) and that account is skipped.
 * Throws only when the profile can't be opened (e.g. Chrome is running on it).
 */
export async function runSync(
  db: Db,
  config: Config,
  options: SyncOptions & { now?: Date; log?: (line: string) => void } = {},
): Promise<AccountOutcome[]> {
  const log = options.log ?? console.log;
  const now = options.now ?? new Date();
  const watched = await syncWatchList(db, config.watchedAccounts);
  if (watched.length === 0) {
    log("sync: no watched accounts (`accounts watch <email>`)");
    return [];
  }
  const targets = watched
    .map((account, index) => ({ account, index }))
    .filter((t) => options.account === undefined || t.index === options.account);

  const session = await openSession({
    profileDir: config.profileDir,
    channel: config.chromeChannel,
    headless: options.headless ?? true,
  });
  const outcomes: AccountOutcome[] = [];
  try {
    let loggedIn = new Map<string, GoogleAccount>();
    try {
      const { accounts } = await discoverAccounts(contextDeps(session.context));
      loggedIn = new Map(accounts.map((a) => [a.email, a]));
    } catch (err) {
      log(`sync: account discovery failed (${(err as Error).name})`);
    }
    for (const { account: row, index } of targets) {
      const found = loggedIn.get(row.email);
      const account = await upsertAccount(db, {
        email: row.email,
        displayName: found?.name ?? row.displayName,
        authuser: found ? String(found.index) : row.authuser,
      });
      const label = accountLabel(account);
      if (!found?.valid) {
        outcomes.push({ index, ...(await missingSession(db, account, label, now)) });
        log(`sync: account #${index} is not logged in; skipped`);
        continue;
      }
      let result: SyncAccountResult;
      try {
        const page = await openClassroomPage(session.context, account.email);
        try {
          result = await syncAccount(
            db,
            account,
            {
              transport: page.transport,
              session: page.session,
              httpGet: playwrightHttpGet(session.context.request),
            },
            {
              now,
              dataDir: config.dataDir,
              fullRefreshDays: config.fullRefreshDays,
              delayMs: config.syncDelayMs,
              label,
              log,
              ...(options.force?.length ? { force: options.force } : {}),
              materials: {
                lookbackDays: config.alertLookbackDays,
                max: config.expectsWorkMaxPerRun,
              },
            },
          );
        } finally {
          await page.close();
        }
      } catch (err) {
        // Opening the page failed (sign-in page, wrong account, missing tokens).
        const e = err as Error;
        const expired = e instanceof SessionExpiredError;
        if (expired) await sessionAlert(db, account, label, now);
        const run = await startSyncRun(
          db,
          { accountId: account.id, baseline: account.baselineAt === null },
          now,
        );
        const status = expired ? "session_expired" : "error";
        const error = `${e.name}: ${e.message}`;
        await finishSyncRun(db, run.id, { status, stats: {}, error }, now);
        result = { status, stats: emptyStats(account.baselineAt === null), error };
      }
      outcomes.push({ index, ...result });
      log(formatOutcome({ index, ...result }));
    }
  } finally {
    await session.close();
  }
  return outcomes;
}

async function missingSession(
  db: Db,
  account: Account,
  label: string,
  now: Date,
): Promise<SyncAccountResult> {
  await sessionAlert(db, account, label, now, "session_missing");
  const run = await startSyncRun(
    db,
    { accountId: account.id, baseline: account.baselineAt === null },
    now,
  );
  const error = "account is not logged in to the collector profile";
  await finishSyncRun(db, run.id, { status: "session_missing", stats: {}, error }, now);
  return { status: "session_missing", stats: emptyStats(account.baselineAt === null), error };
}

/** The real {@link SyncFn} for `run`: headless sync of every watched account. */
export function playwrightSync(config: Config): SyncFn {
  return async ({ db, now, log, force }) => {
    await runSync(db, config, { now, log, headless: true, ...(force?.length ? { force } : {}) });
  };
}
