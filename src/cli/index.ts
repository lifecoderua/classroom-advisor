import { Command } from "commander";
import { cachedImagePath, cachedTextReader } from "../checks/evaluate-heuristics.ts";
import { llmSource, pendingQualityVersions, reviewSubmission } from "../checks/quality.ts";
import { LLM_PROVIDERS, loadConfig } from "../config/index.ts";
import { setWatched } from "../config/local.ts";
import { createProvider } from "../llm/index.ts";
import { openDb } from "../store/index.ts";
import { accountRows, formatRows, listSessionAccounts } from "./accounts.ts";
import { runDoctor } from "./doctor.ts";

const program = new Command()
  .name("classroom-advisor")
  .description("Watches Google Classroom accounts and alerts on missing, late or weak work.");

program
  .command("doctor")
  .description("Print environment status (Node, Chrome, profile dir, claude CLI, Gemini key)")
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

const check = program.command("check").description("Run checks over the stored data");

check
  .command("quality")
  .description("LLM review of turned-in work without a review from this provider yet")
  .option("--submission-version <id>", "review only this submission version")
  .option("--provider <name>", `LLM provider (${LLM_PROVIDERS.join(" | ")})`)
  .action(async (opts: { submissionVersion?: string; provider?: string }) => {
    const config = loadConfig();
    if (opts.provider && !(LLM_PROVIDERS as readonly string[]).includes(opts.provider)) {
      throw new Error(`unknown provider '${opts.provider}' (use ${LLM_PROVIDERS.join(", ")})`);
    }
    const provider = createProvider({
      ...config,
      llmProvider: (opts.provider as (typeof LLM_PROVIDERS)[number]) ?? config.llmProvider,
    });
    const db = openDb(config);
    try {
      let ids: number[];
      if (opts.submissionVersion) {
        const id = Number(opts.submissionVersion);
        if (!Number.isInteger(id) || id <= 0) throw new Error("--submission-version must be an id");
        ids = [id];
      } else {
        ids = await pendingQualityVersions(db, llmSource(provider));
      }
      if (ids.length === 0) console.log("Nothing to review.");
      for (const id of ids) {
        const res = await reviewSubmission(
          db,
          id,
          provider,
          cachedTextReader(config.dataDir),
          new Date(),
          {
            imagePathOf: cachedImagePath(config.dataDir),
          },
        );
        const failures = res.llmFailures ? ` (LLM failed ${res.llmFailures}x)` : "";
        const tail = `${failures}${res.message ? `  ${res.message}` : ""}`;
        console.log(`#${id}  ${res.status}${res.verdict ? ` ${res.verdict}` : ""}${tail}`);
      }
    } finally {
      await db.$disconnect();
    }
  });

try {
  await program.parseAsync();
} catch (err) {
  console.error(`${(err as Error).name}: ${(err as Error).message}`);
  process.exitCode = 1;
}
