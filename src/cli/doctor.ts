import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { chromium } from "playwright";
import type { Config } from "../config/index.ts";
import { databasePath, openDbAt } from "../store/index.ts";

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

/** Well-known Chrome install locations per platform. Playwright-based discovery comes with the collector. */
export function chromeCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  switch (platform) {
    case "darwin":
      return [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        join(homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
      ];
    case "win32":
      return [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA]
        .filter((d): d is string => Boolean(d))
        .map((d) => join(d, "Google", "Chrome", "Application", "chrome.exe"));
    default:
      return [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/opt/google/chrome/chrome",
      ];
  }
}

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolves a binary name or path the way a shell would, without running it. */
export function which(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (isAbsolute(bin) || bin.includes("/")) return isExecutable(bin) ? bin : undefined;
  const exts =
    platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").concat("") : [""];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, bin + ext);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Google Chrome for the `chrome` channel; Playwright's bundled build for `chromium`. */
export function chromeCheck(
  channel: string,
  bundledPath: () => string = () => chromium.executablePath(),
): CheckResult {
  if (channel === "chrome") {
    const chrome = chromeCandidates().find((p) => existsSync(p));
    return {
      name: "Chrome",
      ok: Boolean(chrome),
      detail: chrome ?? "not found in the usual locations",
    };
  }
  if (channel === "chromium") {
    const path = bundledPath();
    const ok = existsSync(path);
    return {
      name: "Chrome",
      ok,
      detail: `chromium channel: ${path}${ok ? "" : " missing (pnpm exec playwright install chromium)"}`,
    };
  }
  return { name: "Chrome", ok: true, detail: `channel ${channel} (not checked)` };
}

export function runDoctor(config: Config): CheckResult[] {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const claude = which(config.claudeBin);
  return [
    {
      name: "Node",
      ok: nodeMajor >= 22,
      detail: `${process.version}${nodeMajor >= 22 ? "" : " (need >= 22)"}`,
    },
    chromeCheck(config.chromeChannel),
    {
      name: "Profile dir",
      ok: existsSync(config.profileDir),
      detail: existsSync(config.profileDir)
        ? config.profileDir
        : `${config.profileDir} missing (see README setup)`,
    },
    {
      name: "claude CLI",
      ok: Boolean(claude),
      detail: claude ?? `'${config.claudeBin}' not found on PATH`,
    },
    {
      // Never print the key itself. Only required when the gemini provider is selected.
      name: "Gemini key",
      ok: Boolean(config.geminiApiKey) || config.llmProvider !== "gemini",
      detail: config.geminiApiKey
        ? `GEMINI_API_KEY set (model ${config.geminiModel})`
        : `GEMINI_API_KEY not set${config.llmProvider === "gemini" ? " (required by llmProvider gemini)" : ""}`,
    },
    {
      // Optional notifier; never print the token. A token without a linked chat is a half setup.
      name: "Telegram",
      ok: !config.telegramBotToken || config.telegramChatIds.length > 0,
      detail: !config.telegramBotToken
        ? "TELEGRAM_BOT_TOKEN not set (console only)"
        : config.telegramChatIds.length > 0
          ? `token set, ${config.telegramChatIds.length} chat(s), digest at ${config.telegramDigestTime}`
          : "token set, no chat linked (run telegram link)",
    },
  ];
}

/** DB reachable (file present and queryable) and how many accounts are watched in it. */
export async function checkDatabase(config: Pick<Config, "dataDir">): Promise<CheckResult> {
  const path = databasePath(config);
  if (!existsSync(path)) {
    return { name: "Database", ok: false, detail: `${path} missing (run pnpm db:migrate)` };
  }
  const db = openDbAt(path);
  try {
    const [watched, total] = await Promise.all([
      db.account.count({ where: { watched: true } }),
      db.account.count(),
    ]);
    return { name: "Database", ok: true, detail: `${watched} watched of ${total} account(s)` };
  } catch (err) {
    return { name: "Database", ok: false, detail: (err as Error).message.split("\n")[0] ?? "" };
  } finally {
    await db.$disconnect();
  }
}
