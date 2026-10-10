import { Command } from "commander";
import { loadConfig } from "../config/index.ts";
import { setWatched } from "../config/local.ts";
import { accountRows, formatRows, listSessionAccounts } from "./accounts.ts";
import { runDoctor } from "./doctor.ts";

const program = new Command()
  .name("classroom-advisor")
  .description("Watches Google Classroom accounts and alerts on missing, late or weak work.");

program
  .command("doctor")
  .description("Print environment status (Node, Chrome, profile dir, claude CLI)")
  .option("--session", "also open the profile headless and count logged-in accounts")
  .action(async (opts: { session?: boolean }) => {
    const config = loadConfig();
    const results = runDoctor(config);
    if (opts.session) {
      try {
        const { accounts, method } = await listSessionAccounts(config, true);
        results.push({
          name: "Session",
          ok: true,
          detail: `${accounts.length} account(s) logged in (via ${method})`,
        });
      } catch (err) {
        results.push({ name: "Session", ok: false, detail: (err as Error).message });
      }
    }
    for (const r of results) {
      console.log(`${r.ok ? "ok  " : "FAIL"}  ${r.name.padEnd(12)} ${r.detail}`);
    }
    console.log(`      ${"LLM".padEnd(12)} ${config.llmProvider}`);
    console.log(`      ${"Data dir".padEnd(12)} ${config.dataDir}`);
    console.log(`      ${"Watching".padEnd(12)} ${config.watchedAccounts.length} account(s)`);
  });

const accounts = program
  .command("accounts")
  .description("Google accounts in the collector profile");

accounts
  .command("list")
  .description("List logged-in accounts and which are watched")
  .option("--headless", "run Chrome headless")
  .action(async (opts: { headless?: boolean }) => {
    const config = loadConfig();
    const { accounts: found, method } = await listSessionAccounts(config, Boolean(opts.headless));
    for (const line of formatRows(accountRows(found, config.watchedAccounts))) console.log(line);
    console.log(
      `\n${found.length} logged in (via ${method}), ${config.watchedAccounts.length} watched`,
    );
    if (process.env.CA_WATCHED_ACCOUNTS) {
      console.log("Note: CA_WATCHED_ACCOUNTS is set and overrides config.local.json.");
    }
  });

for (const [name, watched] of [
  ["watch", true],
  ["unwatch", false],
] as const) {
  accounts
    .command(`${name} <email>`)
    .description(
      `${watched ? "Add" : "Remove"} an account ${watched ? "to" : "from"} the watch list`,
    )
    .action((email: string) => {
      // TODO(#19): mirror to Account.watched in the DB.
      const { changed, watchedAccounts } = setWatched(process.cwd(), email, watched);
      console.log(
        changed
          ? `${watched ? "Watching" : "Stopped watching"} ${email.trim().toLowerCase()}.`
          : `No change: ${email} was ${watched ? "already" : "not"} watched.`,
      );
      console.log(`Watch list: ${watchedAccounts.length} account(s).`);
    });
}

try {
  await program.parseAsync();
} catch (err) {
  console.error(`${(err as Error).name}: ${(err as Error).message}`);
  process.exitCode = 1;
}
