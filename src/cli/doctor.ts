import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import type { Config } from "../config/index.ts";

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

export function runDoctor(config: Config): CheckResult[] {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const chrome = chromeCandidates().find((p) => existsSync(p));
  const claude = which(config.claudeBin);
  return [
    {
      name: "Node",
      ok: nodeMajor >= 22,
      detail: `${process.version}${nodeMajor >= 22 ? "" : " (need >= 22)"}`,
    },
    { name: "Chrome", ok: Boolean(chrome), detail: chrome ?? "not found in the usual locations" },
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
  ];
}
