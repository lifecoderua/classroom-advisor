import type { Command } from "commander";
import { contextDeps, discoverAccounts, SessionMissingError } from "../collector/accounts.ts";
import { BUCKETS, type Bucket } from "../collector/classroom/enums.ts";
import { openClassroomPage } from "../collector/classroom/rpc.ts";
import { countByBucket, listTodo } from "../collector/classroom/todo.ts";
import { withSession } from "../collector/session.ts";
import { type Config, loadConfig } from "../config/index.ts";

/** One line of counts per bucket. No titles, names or emails. */
export function formatCounts(index: number, total: number, counts: Record<Bucket, number>): string {
  const parts = BUCKETS.filter((b) => counts[b] > 0).map((b) => `${b} ${counts[b]}`);
  return `Account #${index}: ${total} item(s)${parts.length ? `: ${parts.join(", ")}` : ""}`;
}

export interface TodoCountsOptions {
  headless: boolean;
  /** Index into `config.watchedAccounts`; all watched accounts when unset. */
  account?: number;
}

/** Read-only: lists each watched account's To-do via RPC and prints counts per bucket. */
export async function runTodoCounts(config: Config, options: TodoCountsOptions): Promise<void> {
  const watched = config.watchedAccounts.map((e) => e.toLowerCase());
  if (watched.length === 0)
    throw new Error("No watched accounts. Run `accounts watch <email>` first.");
  const indexes = options.account === undefined ? watched.map((_, i) => i) : [options.account];

  await withSession(
    { profileDir: config.profileDir, channel: config.chromeChannel, headless: options.headless },
    async (s) => {
      const { accounts } = await discoverAccounts(contextDeps(s.context));
      const loggedIn = new Map(accounts.map((a) => [a.email, a]));
      for (const i of indexes) {
        const email = watched[i];
        if (!email) throw new Error(`No watched account at index ${i}`);
        if (!loggedIn.get(email)?.valid) {
          throw new SessionMissingError(`watched account #${i} is not logged in`);
        }
        const cp = await openClassroomPage(s.context, email);
        try {
          const { courses, summaries } = await listTodo(cp.transport, cp.session, { delayMs: 300 });
          const active = courses.filter((c) => c.active).length;
          console.log(formatCounts(i, summaries.length, countByBucket(summaries)));
          console.log(`  courses: ${active} active of ${courses.length}`);
        } finally {
          await cp.close();
        }
      }
    },
  );
}

export function registerClassroomCommands(program: Command): void {
  const classroom = program
    .command("classroom")
    .description("Read-only Classroom queries via its internal RPCs");

  classroom
    .command("todo")
    .description("Count To-do items per bucket for each watched account (no titles)")
    .option("--account <n>", "only this watched account (0-based index in the watch list)")
    .option("--headless", "run Chrome headless")
    .action(async (opts: { account?: string; headless?: boolean }) => {
      await runTodoCounts(loadConfig(), {
        headless: Boolean(opts.headless),
        ...(opts.account !== undefined ? { account: Number(opts.account) } : {}),
      });
    });
}
