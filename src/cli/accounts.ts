import {
  contextDeps,
  type Discovery,
  discoverAccounts,
  type GoogleAccount,
} from "../collector/accounts.ts";
import { withSession } from "../collector/session.ts";
import type { Config } from "../config/index.ts";

export interface AccountRow {
  email: string;
  name?: string;
  loggedIn: boolean;
  watched: boolean;
  valid: boolean;
}

/** Merges logged-in accounts with the watch list; watched-but-missing accounts are listed too. */
export function accountRows(accounts: GoogleAccount[], watched: string[]): AccountRow[] {
  const watchSet = new Set(watched.map((e) => e.toLowerCase()));
  const rows: AccountRow[] = accounts.map((a) => ({
    email: a.email,
    ...(a.name ? { name: a.name } : {}),
    loggedIn: true,
    watched: watchSet.has(a.email),
    valid: a.valid,
  }));
  const seen = new Set(rows.map((r) => r.email));
  for (const email of watchSet) {
    if (!seen.has(email)) rows.push({ email, loggedIn: false, watched: true, valid: false });
  }
  return rows;
}

export function formatRows(rows: AccountRow[]): string[] {
  return rows.map((r) => {
    const status = !r.loggedIn ? "NOT LOGGED IN" : r.valid ? "logged in" : "SESSION EXPIRED";
    const watch = r.watched ? "watched" : "-";
    return `${watch.padEnd(8)} ${status.padEnd(15)} ${r.email}${r.name ? ` (${r.name})` : ""}`;
  });
}

export async function listSessionAccounts(config: Config, headless: boolean): Promise<Discovery> {
  return withSession({ profileDir: config.profileDir, headless }, (s) =>
    discoverAccounts(contextDeps(s.context)),
  );
}
