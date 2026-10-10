import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

export const LLM_PROVIDERS = ["claude-cli", "gemini", "fake"] as const;

/** Latest stable Flash model with a Gemini API free tier (checked 2026-10 at ai.google.dev). */
export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";

export const configSchema = z.strictObject({
  profileDir: z.string().min(1).default("~/.classroom-advisor/chrome-profile"),
  dataDir: z.string().min(1).default("./.data"),
  watchedAccounts: z.array(z.email()).default([]),
  llmProvider: z.enum(LLM_PROVIDERS).default("claude-cli"),
  claudeBin: z.string().min(1).default("claude"),
  /** Model alias or id passed to `claude --model`; CLI default when unset. */
  claudeModel: z.string().min(1).optional(),
  /** Gemini model id for the `gemini` provider. */
  geminiModel: z.string().min(1).default(DEFAULT_GEMINI_MODEL),
  /** Per-call LLM timeout. */
  llmTimeoutMs: z.coerce.number().int().positive().default(180_000),
  /** Minutes between `run` cycles. */
  runIntervalMin: z.coerce.number().int().positive().default(60),
  /** Local-time window `HH:MM-HH:MM` in which `run` skips cycles (may cross midnight). */
  quietHours: z
    .string()
    .regex(/^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/, "expected HH:MM-HH:MM")
    .optional(),
});

export type Config = z.infer<typeof configSchema> & {
  /**
   * Secret, from `GEMINI_API_KEY` in the environment or `.env` only (never `config.local.json`,
   * which rejects it as an unknown key). Absent when unset.
   */
  geminiApiKey?: string;
};

/** Env var → config key. Env values override `config.local.json`. */
const ENV_KEYS = {
  CA_PROFILE_DIR: "profileDir",
  CA_DATA_DIR: "dataDir",
  CA_WATCHED_ACCOUNTS: "watchedAccounts",
  CA_LLM_PROVIDER: "llmProvider",
  CA_CLAUDE_BIN: "claudeBin",
  CA_CLAUDE_MODEL: "claudeModel",
  CA_GEMINI_MODEL: "geminiModel",
  CA_LLM_TIMEOUT_MS: "llmTimeoutMs",
  CA_RUN_INTERVAL_MIN: "runIntervalMin",
  CA_QUIET_HOURS: "quietHours",
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

  const dotenvVars = readDotenv(join(cwd, ".env"));
  const merged = {
    ...file,
    ...fromEnv(dotenvVars),
    ...fromEnv(env),
  };
  const geminiApiKey = (env.GEMINI_API_KEY?.trim() || dotenvVars.GEMINI_API_KEY?.trim()) ?? "";

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
    ...(geminiApiKey ? { geminiApiKey } : {}),
  };
}
