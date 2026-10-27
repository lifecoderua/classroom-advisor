import type { Command } from "commander";
import { type Config, loadConfig } from "../config/index.ts";
import {
  type LoginInfo,
  type LoginResult,
  LoginService,
  type LoginState,
  readLoginState,
  writeLoginRequest,
} from "../login/index.ts";
import { acquireRunLock, runLockHolder } from "../run/lock.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function printOpen(info: LoginInfo): void {
  const until = new Date(info.expiresAt).toLocaleTimeString("en-GB", { hour12: false });
  if (info.url) {
    console.log(`Login open until ${until}: ${info.url}`);
    console.log("(the link holds a one-time password; on a remote machine use an SSH tunnel)");
  } else {
    console.log(`Login open until ${until}: a Chrome window opened on this machine.`);
  }
  console.log(
    "Log in to every kid account by hand (account switcher), open classroom.google.com for " +
      "each, then quit Chrome (or run `login --done`).",
  );
}

function printResult(r: LoginResult, config: Config): void {
  if (r.error) {
    console.log(`Login ended (${r.end}) with an error: ${r.error}`);
    process.exitCode = 1;
    return;
  }
  if (r.end === "stopped") {
    console.log("Login stopped before the accounts were checked.");
    process.exitCode = 1;
    return;
  }
  console.log(`Login ended (${r.end}): ${r.loggedIn.length} account(s) logged in.`);
  if (r.missing.length) {
    console.log(`Still not logged in: ${r.missing.join(", ")}`);
    process.exitCode = 1;
  } else if (config.watchedAccounts.length) {
    console.log("All watched accounts are logged in.");
  }
}

/** Waits for the running loop to open the requested login, then for it to end. */
async function followLoop(config: Config, requestedAt: number, finishing: boolean): Promise<void> {
  let shown: string | undefined;
  let waitingNoted = false;
  for (;;) {
    const state: LoginState | undefined = readLoginState(config.dataDir);
    const fresh = state && Date.parse(state.updatedAt) >= requestedAt;
    if (state?.status === "active" && !finishing && shown !== state.info.startedAt) {
      shown = state.info.startedAt;
      printOpen(state.info);
      console.log("Waiting for the login to end (Ctrl-C leaves it open)...");
    } else if (state?.status === "done" && state.result && (fresh || shown)) {
      printResult(state.result, config);
      return;
    } else if (finishing && state?.status !== "active") {
      console.log("No login is open.");
      return;
    } else if (!waitingNoted && !shown && Date.now() - requestedAt > 3000) {
      waitingNoted = true;
      console.log("The loop opens the login after its current cycle; waiting...");
    }
    await sleep(1000);
  }
}

/** No loop runs: open the login here, holding the run lock so no loop or sync starts. */
async function loginHere(config: Config): Promise<void> {
  const lock = acquireRunLock(config.dataDir);
  const service = new LoginService({ config, log: () => undefined });
  const controller = new AbortController();
  const onSigint = () => {
    // First Ctrl-C ends the login like "done" (accounts are checked); a second one aborts.
    if (service.finish()) return;
    controller.abort();
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigint);
  const poll = setInterval(() => service.pollRequests(), 1000);
  const shown = setInterval(() => {
    if (service.active) {
      printOpen(service.active);
      clearInterval(shown);
    }
  }, 200);
  try {
    service.resetStale();
    service.request();
    printResult(await service.run(controller.signal), config);
  } finally {
    clearInterval(poll);
    clearInterval(shown);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigint);
    lock.release();
  }
}

/** Adds `login` to the CLI. */
export function registerLoginCommand(program: Command): void {
  program
    .command("login")
    .description(
      "Hand login on the collector profile: the running loop opens it, else this command does",
    )
    .option("--done", "end the open login: close the browser and check the accounts")
    .action(async (opts: { done?: boolean }) => {
      const config = loadConfig();
      if (!runLockHolder(config.dataDir)) {
        if (opts.done) {
          console.log("No login is open (nothing is running).");
          return;
        }
        await loginHere(config);
        return;
      }
      const requestedAt = Date.now();
      writeLoginRequest(config.dataDir, {
        action: opts.done ? "done" : "start",
        at: new Date(requestedAt).toISOString(),
      });
      await followLoop(config, requestedAt, Boolean(opts.done));
    });
}
