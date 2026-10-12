import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import dotenv from "dotenv";
import { z } from "zod";
import { DEFAULT_LANG, DEFAULT_TIME_ZONE, isTimeZone, LANGS } from "../i18n/index.ts";

export const LLM_PROVIDERS = ["claude-cli", "gemini", "fake"] as const;

/** Latest stable Flash model with a Gemini API free tier (checked 2026-10 at ai.google.dev). */
export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";

export const configSchema = z.strictObject({
  profileDir: z.string().min(1).default("~/.classroom-advisor/chrome-profile"),
  /**
   * Playwright browser channel for the collector: `chrome` (installed Google Chrome, the default)
   * or `chromium` (Playwright's bundled Chromium, e.g. on linux/arm64 where Chrome has no build).
   * The profile must be logged in with the same browser.
   */
  chromeChannel: z.string().min(1).default("chrome"),
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
  /**
   * `untouched_24h` and `no_due_date` fire only for items posted within this many days, so
   * old lesson posts don't flood the digest.
   */
  alertLookbackDays: z.coerce.number().int().positive().default(14),
  /**
   * Open debts (redo requests, missing work, "check by hand" items) repeat in every digest until
   * resolved or acked, and are forgotten this many days after they appeared.
   */
  backlogForgetDays: z.coerce.number().int().positive().default(14),
  /**
   * The green "upcoming" block (digest, report, `/status`) lists work not turned in yet that is
   * due later than a day from now and within this many days.
   */
  upcomingDays: z.coerce.number().int().positive().default(14),
  /** Telegram `/refresh` and `/recheck`: at most one manual cycle per this many minutes. */
  refreshCooldownMin: z.coerce.number().int().nonnegative().default(5),
  /** Sync re-fetches the details of every item at least this often (slow full refresh). */
  fullRefreshDays: z.coerce.number().int().positive().default(7),
  /** Pause between Classroom RPC calls during sync, to keep the request rate low. */
  syncDelayMs: z.coerce.number().int().nonnegative().default(300),
  /** Language of every parent-facing text: alerts, digests, report, bot replies, LLM review. */
  digestLang: z.enum(LANGS).default(DEFAULT_LANG),
  /** IANA time zone for the digest time, quiet hours and every displayed time. */
  timeZone: z
    .string()
    .refine(isTimeZone, "expected an IANA time zone, e.g. Europe/Kyiv")
    .default(DEFAULT_TIME_ZONE),
  /** Window `HH:MM-HH:MM` (in `timeZone`) in which `run` skips cycles (may cross midnight). */
  quietHours: z
    .string()
    .regex(/^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/, "expected HH:MM-HH:MM")
    .optional(),
  /**
   * Telegram chats the bot sends to and takes commands from (`telegram link` adds one). Other
   * chats are ignored. The bot token is a secret and comes from `TELEGRAM_BOT_TOKEN` only.
   */
  telegramChatIds: z.array(z.string().regex(/^-?\d+$/, "expected a numeric chat id")).default([]),
  /** Time `HH:MM` (in `timeZone`) of the daily Telegram digest (alerts and info; panics go out at once). */
  telegramDigestTime: z
    .string()
    .regex(/^\d{1,2}:\d{2}$/, "expected HH:MM")
    .default("19:00"),
});

export type Config = z.infer<typeof configSchema> & {
  /**
   * Secret, from `GEMINI_API_KEY` in the environment or `.env` only (never `config.local.json`,
   * which rejects it as an unknown key). Absent when unset.
   */
  geminiApiKey?: string;
  /** Secret, from `TELEGRAM_BOT_TOKEN` in the environment or `.env` only, like `geminiApiKey`. */
  telegramBotToken?: string;
};

/** Env var → config key. Env values override `config.local.json`. */
const ENV_KEYS = {
  CA_PROFILE_DIR: "profileDir",
  CA_CHROME_CHANNEL: "chromeChannel",
  CA_DATA_DIR: "dataDir",
  CA_WATCHED_ACCOUNTS: "watchedAccounts",
  CA_LLM_PROVIDER: "llmProvider",
  CA_CLAUDE_BIN: "claudeBin",
  CA_CLAUDE_MODEL: "claudeModel",
  CA_GEMINI_MODEL: "geminiModel",
  CA_LLM_TIMEOUT_MS: "llmTimeoutMs",
  CA_RUN_INTERVAL_MIN: "runIntervalMin",
  CA_QUIET_HOURS: "quietHours",
  CA_DIGEST_LANG: "digestLang",
  CA_TIMEZONE: "timeZone",
  CA_ALERT_LOOKBACK_DAYS: "alertLookbackDays",
  CA_BACKLOG_FORGET_DAYS: "backlogForgetDays",
  CA_UPCOMING_DAYS: "upcomingDays",
  CA_REFRESH_COOLDOWN_MIN: "refreshCooldownMin",
  CA_FULL_REFRESH_DAYS: "fullRefreshDays",
  CA_SYNC_DELAY_MS: "syncDelayMs",
  CA_TELEGRAM_CHAT_IDS: "telegramChatIds",
  CA_TELEGRAM_DIGEST_TIME: "telegramDigestTime",
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
      configKey === "watchedAccounts" || configKey === "telegramChatIds"
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
  const telegramBotToken =
    (env.TELEGRAM_BOT_TOKEN?.trim() || dotenvVars.TELEGRAM_BOT_TOKEN?.trim()) ?? "";

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
    ...(telegramBotToken ? { telegramBotToken } : {}),
  };
}
