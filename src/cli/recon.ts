import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contextDeps, discoverAccounts, SessionMissingError } from "../collector/accounts.ts";
import { captureStamp, captureTargets, TODO_PATHS } from "../collector/recon.ts";
import { withSession } from "../collector/session.ts";
import type { Config } from "../config/index.ts";

export { TODO_PATHS };

/** One URL or path per line; blank lines and `#` comments are skipped. */
export function parseTargets(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

export function readTargetsFile(path: string): string[] {
  return parseTargets(readFileSync(path, "utf8"));
}

export interface RunReconOptions {
  targets: string[];
  headless: boolean;
  scrollRounds: number;
  /** Index into `config.watchedAccounts`; all watched accounts when unset. */
  account?: number;
}

/**
 * Captures each target for each watched account. Directories are named by the account's
 * watch-list index so emails never end up in paths or logs.
 */
export async function runRecon(config: Config, options: RunReconOptions): Promise<void> {
  const watched = config.watchedAccounts.map((e) => e.toLowerCase());
  if (watched.length === 0) {
    throw new Error("No watched accounts. Run `accounts watch <email>` first.");
  }
  const indexes = options.account === undefined ? watched.map((_, i) => i) : [options.account];
  const stamp = captureStamp();

  await withSession(
    { profileDir: config.profileDir, channel: config.chromeChannel, headless: options.headless },
    async (s) => {
      const { accounts } = await discoverAccounts(contextDeps(s.context));
      const loggedIn = new Map(accounts.map((a) => [a.email, a]));
      for (const i of indexes) {
        const email = watched[i];
        if (!email) throw new Error(`No watched account at index ${i}`);
        const account = loggedIn.get(email);
        if (!account?.valid) {
          throw new SessionMissingError(`watched account #${i} is not logged in`);
        }
        const outDir = join(config.dataDir, "captures", String(i), stamp);
        console.log(`Account #${i}: capturing ${options.targets.length} page(s) → ${outDir}`);
        await captureTargets(s.context, {
          email,
          outDir,
          targets: options.targets,
          scrollRounds: options.scrollRounds,
          log: (line) => console.log(`  ${line}`),
        });
      }
    },
  );
}
