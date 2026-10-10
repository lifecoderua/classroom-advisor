import { Command } from "commander";
import { loadConfig } from "../config/index.ts";
import { runDoctor } from "./doctor.ts";

const program = new Command()
  .name("classroom-advisor")
  .description("Watches Google Classroom accounts and alerts on missing, late or weak work.");

program
  .command("doctor")
  .description("Print environment status (Node, Chrome, profile dir, claude CLI)")
  .action(() => {
    const config = loadConfig();
    const results = runDoctor(config);
    for (const r of results) {
      console.log(`${r.ok ? "ok  " : "FAIL"}  ${r.name.padEnd(12)} ${r.detail}`);
    }
    console.log(`      ${"LLM".padEnd(12)} ${config.llmProvider}`);
    console.log(`      ${"Data dir".padEnd(12)} ${config.dataDir}`);
    console.log(`      ${"Watching".padEnd(12)} ${config.watchedAccounts.length} account(s)`);
  });

await program.parseAsync();
