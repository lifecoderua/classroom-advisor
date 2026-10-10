import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

export const LLM_PROVIDERS = ["claude-cli", "gemini", "fake"] as const;

export const configSchema = z.strictObject({
  profileDir: z.string().min(1).default("~/.classroom-advisor/chrome-profile"),
  dataDir: z.string().min(1).default("./.data"),
  watchedAccounts: z.array(z.email()).default([]),
  llmProvider: z.enum(LLM_PROVIDERS).default("claude-cli"),
  claudeBin: z.string().min(1).default("claude"),
});

export type Config = z.infer<typeof configSchema>;

/** Env var → config key. Env values override `config.local.json`. */
const ENV_KEYS = {
  CA_PROFILE_DIR: "profileDir",
  CA_DATA_DIR: "dataDir",
  CA_WATCHED_ACCOUNTS: "watchedAccounts",
  CA_LLM_PROVIDER: "llmProvider",
  CA_CLAUDE_BIN: "claudeBin",
} as const satisfies Record<string, keyof Config>;

export class ConfigError extends Error {
  override name = "ConfigError";
}

export interface LoadConfigOptions {
  /** Directory holding `.env` and `config.local.json`. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Process environment. Defaults to `process.env`; it wins over values from `.env`. */
  env?: NodeJS.ProcessEnv;
  /** Home dir used to expand `~`. Defaults to `os.homedir()`. */
  home?: string;
}

export function expandHome(path: string, home: string = homedir()): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

function readJsonFile(path: string): unknown {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new ConfigError(`Invalid JSON in ${path}: ${(err as Error).message}`);
  }
}

function readDotenv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  return dotenv.parse(readFileSync(path, "utf8"));
}

function fromEnv(env: Record<string, string | undefined>): Partial<Record<keyof Config, unknown>> {
  const out: Partial<Record<keyof Config, unknown>> = {};
  for (const [envKey, configKey] of Object.entries(ENV_KEYS)) {
    const raw = env[envKey]?.trim();
    if (!raw) continue;
    out[configKey] =
      configKey === "watchedAccounts"
        ? raw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : raw;
  }
  return out;
}

/**
 * Loads config: defaults < `config.local.json` < `.env` < process env.
 * Paths come back absolute (`~` expanded, relative paths resolved against `cwd`).
 */
export function loadConfig(options: LoadConfigOptions = {}): Config {
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;

  const filePath = join(cwd, "config.local.json");
  const file = readJsonFile(filePath);
  if (typeof file !== "object" || file === null || Array.isArray(file)) {
    throw new ConfigError(`${filePath} must contain a JSON object`);
  }

  const merged = {
    ...file,
    ...fromEnv(readDotenv(join(cwd, ".env"))),
    ...fromEnv(env),
  };

  const parsed = configSchema.safeParse(merged);
  if (!parsed.success) {
    throw new ConfigError(`Invalid config:\n${z.prettifyError(parsed.error)}`);
  }

  const toAbsolute = (p: string) => {
    const expanded = expandHome(p, home);
    return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  };

  return {
    ...parsed.data,
    profileDir: toAbsolute(parsed.data.profileDir),
    dataDir: toAbsolute(parsed.data.dataDir),
  };
}
