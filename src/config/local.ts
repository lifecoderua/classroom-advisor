import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ConfigError } from "./index.ts";

export const LOCAL_CONFIG_FILE = "config.local.json";

function readRaw(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new ConfigError(`Invalid JSON in ${path}: ${(err as Error).message}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new ConfigError(`${path} must contain a JSON object`);
  }
  return data as Record<string, unknown>;
}

function readWatched(raw: Record<string, unknown>, path: string): string[] {
  const parsed = z.array(z.string()).optional().safeParse(raw.watchedAccounts);
  if (!parsed.success) throw new ConfigError(`${path}: watchedAccounts must be a list of emails`);
  return parsed.data ?? [];
}

export function normalizeEmail(email: string): string {
  const e = email.trim().toLowerCase();
  if (!z.email().safeParse(e).success) throw new ConfigError(`Not an email: ${email}`);
  return e;
}

export interface WatchChange {
  changed: boolean;
  watchedAccounts: string[];
}

/**
 * Adds or removes an email in `watchedAccounts` of `config.local.json`, keeping other keys.
 * The CLI then mirrors the list to `Account.watched` (sync does it on every run too).
 */
export function setWatched(cwd: string, email: string, watched: boolean): WatchChange {
  const path = join(cwd, LOCAL_CONFIG_FILE);
  const raw = readRaw(path);
  const target = normalizeEmail(email);
  const current = readWatched(raw, path);
  const has = current.some((e) => e.toLowerCase() === target);
  if (has === watched) return { changed: false, watchedAccounts: current };

  const next = watched ? [...current, target] : current.filter((e) => e.toLowerCase() !== target);
  writeFileSync(path, `${JSON.stringify({ ...raw, watchedAccounts: next }, null, 2)}\n`);
  return { changed: true, watchedAccounts: next };
}

/**
 * Adds a Telegram chat id to `telegramChatIds` of `config.local.json`, keeping other keys.
 * Returns whether it changed and the resulting list.
 */
export function addTelegramChat(
  cwd: string,
  chatId: string,
): { changed: boolean; chatIds: string[] } {
  const path = join(cwd, LOCAL_CONFIG_FILE);
  const raw = readRaw(path);
  const id = chatId.trim();
  if (!/^-?\d+$/.test(id)) throw new ConfigError(`Not a Telegram chat id: ${chatId}`);
  const parsed = z.array(z.string()).optional().safeParse(raw.telegramChatIds);
  if (!parsed.success) throw new ConfigError(`${path}: telegramChatIds must be a list of ids`);
  const current = parsed.data ?? [];
  if (current.includes(id)) return { changed: false, chatIds: current };
  const next = [...current, id];
  writeFileSync(path, `${JSON.stringify({ ...raw, telegramChatIds: next }, null, 2)}\n`);
  return { changed: true, chatIds: next };
}
