import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Debt, debtAgeDays, loadBacklog } from "../checks/backlog.ts";
import { findRecheckTarget, type RecheckResult } from "../checks/recheck.ts";
import { detailsUrl } from "../collector/classroom/todo.ts";
import {
  DEFAULT_LANG,
  formatAge,
  formatAgo,
  formatIn,
  formatTime,
  itemLabel,
  type Lang,
  type Locale,
  messages,
  renderAlert,
  zonedClock,
} from "../i18n/index.ts";
import { abortableSleep } from "../run/cycle.ts";
import { inQuietHours, type QuietHours } from "../run/schedule.ts";
import { type Db, markAlertsSent, muteAlert } from "../store/index.ts";
import type { AlertLevel } from "../store/types.ts";
import {
  alertText,
  buildReport,
  DEFAULT_UPCOMING_DAYS,
  parseAlertKey,
  type Report,
  type ReportAlert,
  reportHasAlerts,
  type UpcomingItem,
} from "./console.ts";

// Telegram notifier over the plain Bot API (fetch, no SDK). Panics go out right after each `run`
// cycle, everything else in a daily digest at `telegramDigestTime`. `Alert.sentAt` means
// "delivered to Telegram" (see D15). Commands (/status, /digest, /ack) are long-polled between
// cycles and answered only in the allowed chats; other chats are ignored silently.

const API_BASE = "https://api.telegram.org";
/** Telegram's limit is 4096 characters per message; stay below it with some margin. */
export const MESSAGE_LIMIT = 4000;
/** A single alert line is capped so it always fits in one message. */
const LINE_CAP = 1500;
const DAY_MS = 86_400_000;
/** Unsent alerts older than this are left to the console (e.g. after Telegram was off a while). */
export const MAX_ALERT_AGE_MS = 7 * DAY_MS;
/** Default `backlogForgetDays`. */
export const DEFAULT_BACKLOG_FORGET_DAYS = 14;

/** What a digest carried: alerts (now marked sent) and open debts (repeated every digest). */
export interface Sent {
  alerts: number;
  debts: number;
  /** Alerts closed automatically since the previous digest (a count line, #51). */
  closed: number;
  /** Items in the upcoming block (#53). */
  upcoming: number;
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export class TelegramError extends Error {
  override name = "TelegramError";
  constructor(
    message: string,
    readonly code?: number,
    readonly retryAfterSec?: number,
    /** The group became a supergroup with this id (`parameters.migrate_to_chat_id`). */
    readonly migrateToChatId?: string,
  ) {
    super(message);
  }
}

export interface TgChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TgMessage {
  message_id: number;
  date: number;
  chat: TgChat;
  text?: string;
  /** Service message: this group was upgraded to a supergroup with that id. */
  migrate_to_chat_id?: number;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  channel_post?: TgMessage;
  my_chat_member?: { chat: TgChat };
}

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Minimal Bot API client. The token is only ever put in the request URL and never logged. */
export class TelegramApi {
  constructor(
    private readonly token: string,
    private readonly fetchFn: FetchFn = fetch,
  ) {
    if (!token) throw new TelegramError("TELEGRAM_BOT_TOKEN is not set");
  }

  /** Removes the token from a text (error messages may echo the URL). */
  redact(text: string): string {
    return text.split(this.token).join("<token>");
  }

  async call<T>(method: string, params: object = {}, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(`${API_BASE}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new TelegramError(`${method}: network error: ${this.redact((err as Error).message)}`);
    }
    let body: {
      ok?: boolean;
      result?: T;
      description?: string;
      error_code?: number;
      parameters?: { retry_after?: number; migrate_to_chat_id?: number };
    };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new TelegramError(`${method}: HTTP ${res.status} without a JSON body`, res.status);
    }
    if (!body.ok) {
      const code = body.error_code ?? res.status;
      throw new TelegramError(
        `${method}: ${code} ${this.redact(body.description ?? "error")}`,
        code,
        body.parameters?.retry_after,
        body.parameters?.migrate_to_chat_id === undefined
          ? undefined
          : String(body.parameters.migrate_to_chat_id),
      );
    }
    return body.result as T;
  }

  getMe(): Promise<TgUser> {
    return this.call<TgUser>("getMe");
  }

  getUpdates(
    params: { offset?: number; timeout?: number; allowed_updates?: string[] },
    signal?: AbortSignal,
  ): Promise<TgUpdate[]> {
    return this.call<TgUpdate[]>("getUpdates", params, signal);
  }

  /** Sends one HTML message (≤ 4096 chars); waits out one 429 (`retry_after`, ≤ 60s) and retries. */
  async sendMessage(chatId: string, html: string): Promise<void> {
    const params = {
      chat_id: chatId,
      text: html,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    };
    try {
      await this.call("sendMessage", params);
    } catch (err) {
      if (!(err instanceof TelegramError) || err.code !== 429) throw err;
      await delay(Math.min(err.retryAfterSec ?? 1, 60) * 1000);
      await this.call("sendMessage", params);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Formatting

/** Escapes text for Telegram's HTML parse mode (also safe inside a double-quoted attribute). */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Cuts an over-long HTML line as plain text: tags dropped, no entity cut in half. */
function cutLine(line: string, limit: number): string {
  let cut = line.replace(/<[^>]*>/g, "").slice(0, limit - 1);
  const amp = cut.lastIndexOf("&");
  if (amp > cut.lastIndexOf(";")) cut = cut.slice(0, amp);
  return `${cut}…`;
}

/**
 * Splits an HTML message into chunks of at most `limit` characters on line boundaries. Every
 * line is self-contained (tags open and close on the same line), so no tag is ever split.
 */
export function splitMessage(html: string, limit = MESSAGE_LIMIT): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const raw of html.split("\n")) {
    const line = raw.length > limit ? cutLine(raw, limit) : raw;
    const next = current ? `${current}\n${line}` : line;
    if (next.length > limit) {
      if (current.trim()) chunks.push(current.trim());
      current = line;
    } else {
      current = next;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

const LEVEL_ICON: Record<AlertLevel, string> = { panic: "🔴", alert: "🟠", info: "ℹ️" };

/**
 * A tappable command: `/ack_12@my_bot`. In groups Telegram only links underscore commands that
 * carry the bot's username; in private chats the suffix is harmless.
 */
export function commandRef(name: string, id: number, bot?: string): string {
  return `/${name}_${id}${bot ? `@${bot}` : ""}`;
}

function alertLine(
  a: ReportAlert,
  targets: ReadonlyMap<number, AlertTarget>,
  opts: { loc: Locale; bot?: string | undefined },
  icon = LEVEL_ICON[a.level],
): string {
  const target = targets.get(a.id);
  const open = messages(opts.loc.lang).telegram.open;
  const link = target ? ` · <a href="${escapeHtml(target.url)}">${open}</a>` : "";
  const recheck = target?.recheck
    ? ` · ${commandRef("recheck", target.assignmentId, opts.bot)}`
    : "";
  return `${icon} ${escapeHtml(truncate(alertText(a, opts.loc), LINE_CAP))}${link}${recheck} · ${commandRef("ack", a.id, opts.bot)}`;
}

export interface TelegramFormatOptions {
  /** Header line, already HTML (e.g. `🚨 <b>Urgent</b>`). */
  title: string;
  lang?: Lang;
  timeZone?: string | undefined;
  /** Bot username (without `@`), appended to tappable commands so they link in groups. */
  bot?: string | undefined;
  /** Assignments with turned-in work: their debt lines get `/recheck_<id>`. */
  recheckable?: ReadonlySet<number>;
  /** Shown when the message has nothing else (a `/refresh` digest is always sent). */
  emptyText?: string;
}

function debtLine(
  d: Debt,
  now: Date,
  opts: { lang: Lang; bot?: string | undefined; recheck: boolean },
): string {
  const m = messages(opts.lang);
  const recheck = opts.recheck ? ` · ${commandRef("recheck", d.assignmentId, opts.bot)}` : "";
  const ack = d.alertId === null ? "" : ` · ${commandRef("ack", d.alertId, opts.bot)}`;
  return `${m.report.debt[d.kind]}: ${escapeHtml(
    truncate(itemLabel(d.title, d.courseName, opts.lang), LINE_CAP),
  )} · ${formatAge(debtAgeDays(d, now), opts.lang)} · <a href="${escapeHtml(d.url)}">${
    m.telegram.open
  }</a>${recheck}${ack}`;
}

function upcomingLine(u: UpcomingItem, now: Date, loc: Locale): string {
  const when = `${formatTime(u.dueAt, loc)} (${formatIn(u.dueAt.getTime() - now.getTime(), loc.lang)})`;
  return `🟢 ${escapeHtml(when)} ${escapeHtml(
    truncate(itemLabel(u.title, u.courseName, loc.lang), LINE_CAP),
  )} · <a href="${escapeHtml(u.url)}">${messages(loc.lang).telegram.open}</a>`;
}

/**
 * The alerts of a report, grouped per kid (panics, alerts, info), as Telegram HTML. "Check by
 * hand" items (`quality:<id>:unchecked`, level `info`, so never sent at once) get their own
 * low-noise block after the rest, then the kid's open debts (#48) when the report has them.
 */
export function formatAlertsHtml(
  report: Report,
  targets: ReadonlyMap<number, AlertTarget>,
  opts: TelegramFormatOptions,
): string {
  const loc: Locale = { lang: opts.lang ?? DEFAULT_LANG, timeZone: opts.timeZone };
  const line = { loc, bot: opts.bot };
  const t = messages(loc.lang).telegram;
  const out = [`${opts.title} · ${escapeHtml(formatTime(report.generatedAt, loc))}`];
  const head = out.length;
  for (const a of report.accounts) {
    const alerts = [...a.panics, ...a.alerts, ...a.info];
    if (alerts.length + a.checkByHand.length + a.backlog.length + a.upcoming.length === 0) {
      continue;
    }
    out.push(
      "",
      `👤 <b>${escapeHtml(a.label)}</b>`,
      ...alerts.map((x) => alertLine(x, targets, line)),
    );
    if (a.checkByHand.length) {
      out.push(t.checkByHand, ...a.checkByHand.map((x) => alertLine(x, targets, line, "🔍")));
    }
    if (a.backlog.length) {
      out.push(
        t.debts,
        ...a.backlog.map((d) =>
          debtLine(d, report.generatedAt, {
            lang: loc.lang,
            bot: opts.bot,
            recheck: opts.recheckable?.has(d.assignmentId) ?? false,
          }),
        ),
      );
    }
    if (a.upcoming.length) {
      out.push(
        t.upcoming(report.upcomingDays),
        ...a.upcoming.map((u) => upcomingLine(u, report.generatedAt, loc)),
      );
    }
  }
  if (report.other.length) {
    out.push("", t.other, ...report.other.map((x) => alertLine(x, targets, line)));
  }
  if (report.autoClosed) out.push("", messages(loc.lang).report.autoClosed(report.autoClosed));
  if (out.length === head && opts.emptyText) out.push("", opts.emptyText);
  return out.join("\n");
}

/** What a digest line links to: the assignment details page, and whether it can be re-checked. */
export interface AlertTarget {
  url: string;
  assignmentId: number;
  /** The assignment has turned-in work (`/recheck_<assignmentId>` makes sense). */
  recheck: boolean;
}

/** Assignment ids among `ids` with turned-in (or returned) work. */
export async function recheckableAssignments(db: Db, ids: readonly number[]): Promise<Set<number>> {
  const rows = await db.submission.findMany({
    where: { assignmentId: { in: [...new Set(ids)] }, state: { in: ["turned_in", "returned"] } },
    select: { assignmentId: true },
  });
  return new Set(rows.map((r) => r.assignmentId));
}

/**
 * Assignment details URL (with `authuser=<email>`) per alert, for alerts whose key points at an
 * assignment: `deadline:<assignmentId>`, `quality:<submissionVersionId>`, `comment:<commentId>`.
 */
export async function alertLinks(
  db: Db,
  alerts: readonly Pick<ReportAlert, "id" | "key">[],
): Promise<Map<number, AlertTarget>> {
  const parsed = alerts.map((a) => [a.id, parseAlertKey(a.key)] as const);
  const versionIds = parsed.flatMap(([, p]) => (p?.kind === "quality" ? [p.versionId] : []));
  const commentIds = parsed.flatMap(([, p]) => (p?.kind === "comment" ? [p.commentId] : []));
  const [versions, comments] = await Promise.all([
    db.submissionVersion.findMany({
      where: { id: { in: versionIds } },
      select: { id: true, submission: { select: { assignmentId: true } } },
    }),
    db.comment.findMany({
      where: { id: { in: commentIds } },
      select: { id: true, assignmentId: true },
    }),
  ]);
  const byVersion = new Map(versions.map((v) => [v.id, v.submission.assignmentId]));
  const byComment = new Map(comments.map((c) => [c.id, c.assignmentId]));
  const assignmentOf = new Map<number, number>();
  for (const [id, p] of parsed) {
    const assignmentId =
      p?.kind === "deadline"
        ? p.assignmentId
        : p?.kind === "quality"
          ? byVersion.get(p.versionId)
          : p?.kind === "comment"
            ? byComment.get(p.commentId)
            : undefined;
    if (assignmentId !== undefined) assignmentOf.set(id, assignmentId);
  }
  const assignments = await db.assignment.findMany({
    where: { id: { in: [...new Set(assignmentOf.values())] } },
    select: {
      id: true,
      classroomId: true,
      kind: true,
      account: { select: { email: true } },
      course: { select: { classroomId: true } },
      submission: { select: { state: true } },
    },
  });
  const done = new Set(
    assignments.flatMap((a) =>
      a.submission && ["turned_in", "returned"].includes(a.submission.state) ? [a.id] : [],
    ),
  );
  const urls = new Map(
    assignments.map((a) => [
      a.id,
      detailsUrl(
        a.course.classroomId,
        a.classroomId,
        a.kind === "material" ? "material" : "assignment",
        a.account.email,
      ),
    ]),
  );
  const out = new Map<number, AlertTarget>();
  for (const [alertId, assignmentId] of assignmentOf) {
    const url = urls.get(assignmentId);
    if (url) out.set(alertId, { url, assignmentId, recheck: done.has(assignmentId) });
  }
  return out;
}

/** `/ack 12`, `/ack_12`, `/status@my_bot` → `{name, args}`; anything else → null. */
export function parseCommand(text: string): { name: string; args: string[] } | null {
  const m = /^\/([a-z]+)(?:_(\d+))?(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m?.[1]) return null;
  const args = [...(m[2] ? [m[2]] : []), ...(m[3]?.split(/[\s,]+/).filter(Boolean) ?? [])];
  return { name: m[1].toLowerCase(), args };
}

/** Distinct chats seen in updates (for `telegram link`). */
export function chatsOf(updates: readonly TgUpdate[]): TgChat[] {
  const chats = new Map<number, TgChat>();
  for (const u of updates) {
    const chat =
      u.message?.chat ?? u.edited_message?.chat ?? u.channel_post?.chat ?? u.my_chat_member?.chat;
    if (chat) chats.set(chat.id, chat);
  }
  return [...chats.values()];
}

export function chatLabel(chat: TgChat): string {
  const name = [chat.first_name, chat.last_name].filter(Boolean).join(" ");
  return chat.title || name || (chat.username ? `@${chat.username}` : "");
}

/** The bot's help text (HTML) in `lang`. */
export function helpHtml(lang: Lang): string {
  return messages(lang).telegram.help;
}

// ---------------------------------------------------------------------------------------------
// Notifier

export interface TelegramState {
  /** Next `getUpdates` offset (last handled update id + 1). */
  updateOffset?: number;
  /** `YYYY-MM-DD` (in the configured zone) of the last scheduled digest. */
  lastDigestDay?: string;
  /** ISO time of the last digest sent (scheduled or `/digest`): "closed automatically" counts from it. */
  lastDigestAt?: string;
  /**
   * Groups upgraded to supergroups: old chat id → new one. Applied to the configured chat ids,
   * so a migration sticks even when `CA_TELEGRAM_CHAT_IDS` overrides `config.local.json`.
   */
  chatMigrations?: Record<string, string>;
}

export function telegramStatePath(dataDir: string): string {
  return join(dataDir, "telegram.json");
}

function readState(path: string): TelegramState {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as TelegramState;
    return typeof raw === "object" && raw !== null ? raw : {};
  } catch {
    return {};
  }
}

/** Calendar day `YYYY-MM-DD` of `d` in `timeZone` (default: the process zone). */
export function localDay(d: Date, timeZone?: string): string {
  return zonedClock(d, timeZone).day;
}

/** `HH:MM` → minutes after midnight. */
export function parseClockTime(spec: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(spec.trim());
  const h = Number(m?.[1]);
  const min = Number(m?.[2]);
  if (!m || h > 23 || min > 59) throw new TelegramError(`invalid digest time '${spec}'`);
  return h * 60 + min;
}

export interface NotifierOptions {
  db: Db;
  api: TelegramApi;
  /** Allowed chats: messages go there, commands are taken only from there. */
  chatIds: readonly string[];
  /** `HH:MM` (in `timeZone`) of the daily digest. */
  digestTime: string;
  /** Language of every message and reply (default `uk`). */
  lang?: Lang;
  /** Open debts older than this are left out of digests and `/status` (default 14). */
  backlogForgetDays?: number;
  /** Horizon of the upcoming block in digests and `/status`, in days (default 14). */
  upcomingDays?: number;
  quietHours?: QuietHours;
  /** JSON file for the update offset and the last digest day (`<dataDir>/telegram.json`). */
  statePath: string;
  watchedEmails?: readonly string[];
  now?: () => Date;
  log?: (line: string) => void;
  /** IANA zone of the digest time, quiet hours and displayed times (default: process zone). */
  timeZone?: string;
  /**
   * A linked group was upgraded to a supergroup (Telegram moved it to `to`). Called after the
   * notifier switched over; the CLI rewrites `config.local.json` here.
   */
  onChatMigrated?: (from: string, to: string) => void;
  /** Resolves after `ms` or as soon as `signal` aborts (used after a polling error). */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Long-poll timeout per `getUpdates`, in seconds. */
  pollTimeoutSec?: number;
  /** At most one manual cycle (`/refresh`, `/recheck`) per this many minutes (default 5). */
  refreshCooldownMin?: number;
  /** Bot username (no `@`); `setup()` reads it with `getMe` when not given. */
  botUsername?: string;
}

/** Default `refreshCooldownMin`. */
export const DEFAULT_REFRESH_COOLDOWN_MIN = 5;

/** The bot's commands, for `setMyCommands`. */
export const BOT_COMMANDS = ["status", "digest", "refresh", "recheck", "ack", "help"] as const;

export class TelegramNotifier {
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private readonly digestMin: number;
  private readonly pollTimeoutSec: number;
  private state: TelegramState;
  /** Allowed chats, with supergroup migrations applied. */
  private chatIds: string[];
  /** After a failed scheduled digest, don't retry before this time. */
  private digestRetryAt = 0;
  /** A `run` cycle is in progress (commands are polled meanwhile, see `during`). */
  private busy = false;
  /** Chats waiting for a fresh digest after the next/current cycle (`/refresh`). */
  private refreshWaiters = new Set<string>();
  /** `/refresh` asked for a cycle that hasn't started yet. */
  private refreshQueued = false;
  /** `/recheck` requests not handed to a cycle yet: assignment id → chats to answer. */
  private rechecks = new Map<number, Set<string>>();
  /** Rechecks handed to the current cycle. */
  private recheckInFlight = new Map<number, Set<string>>();
  /** When the last manual cycle started (epoch ms). */
  private lastManualAt = Number.NEGATIVE_INFINITY;
  private bot: string | undefined;

  constructor(private readonly opts: NotifierOptions) {
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? console.log;
    this.digestMin = parseClockTime(opts.digestTime);
    this.pollTimeoutSec = opts.pollTimeoutSec ?? 50;
    this.state = readState(opts.statePath);
    const moved = this.state.chatMigrations ?? {};
    this.chatIds = [...new Set(opts.chatIds.map((id) => moved[id] ?? id))];
    this.bot = opts.botUsername;
  }

  /**
   * Startup: reads the bot's username (for `/cmd_<id>@bot` links, which groups need) and
   * registers the command menu for private chats (default scope) and all group chats. Failures
   * are logged; the bot works without them.
   */
  async setup(): Promise<void> {
    try {
      if (!this.bot) this.bot = (await this.opts.api.getMe()).username;
      const t = messages(this.lang).telegram;
      const commands = BOT_COMMANDS.map((c) => ({ command: c, description: t.commands[c] }));
      for (const type of ["default", "all_group_chats"]) {
        await this.opts.api.call("setMyCommands", { commands, scope: { type } });
      }
    } catch (err) {
      this.log(`telegram: setup failed: ${this.describe(err)}`);
    }
  }

  private get cooldownMs(): number {
    return (this.opts.refreshCooldownMin ?? DEFAULT_REFRESH_COOLDOWN_MIN) * 60_000;
  }

  /** A manual cycle is asked for and the cooldown has passed: the loop should run one now. */
  manualPending(at: Date = this.now()): boolean {
    if (this.busy) return false;
    if (!this.refreshQueued && this.rechecks.size === 0) return false;
    return at.getTime() >= this.lastManualAt + this.cooldownMs;
  }

  /**
   * Called when a cycle starts: hands it the queued rechecks (assignment ids) and, when it was
   * asked for by hand, starts the cooldown.
   */
  startCycle(): number[] {
    if (this.manualPending()) this.lastManualAt = this.now().getTime();
    this.refreshQueued = false;
    for (const [id, chats] of this.rechecks) {
      const set = this.recheckInFlight.get(id) ?? new Set<string>();
      for (const c of chats) set.add(c);
      this.recheckInFlight.set(id, set);
    }
    this.rechecks.clear();
    return [...this.recheckInFlight.keys()];
  }

  /**
   * Runs a cycle while answering commands: polls `getUpdates` with short timeouts until `work`
   * settles (a `/refresh` meanwhile gets "already running" and the digest afterwards).
   */
  async during<T>(work: Promise<T>): Promise<T> {
    this.busy = true;
    const stop = new AbortController();
    const settled = work.finally(() => stop.abort());
    const poll = (async () => {
      const sleep = this.opts.sleep ?? abortableSleep;
      while (!stop.signal.aborted) {
        try {
          await this.pollOnce(Math.min(this.pollTimeoutSec, 10), stop.signal);
        } catch (err) {
          if (stop.signal.aborted) break;
          this.log(`telegram: polling failed: ${this.describe(err)}`);
          await sleep(10_000, stop.signal);
        }
      }
    })();
    try {
      return await settled;
    } finally {
      this.busy = false;
      await poll;
    }
  }

  private get lang(): Lang {
    return this.opts.lang ?? DEFAULT_LANG;
  }

  private get loc(): Locale {
    return { lang: this.lang, timeZone: this.opts.timeZone };
  }

  /** The chats messages go to (configured ids with supergroup migrations applied). */
  get chats(): readonly string[] {
    return this.chatIds;
  }

  /** Switches a linked chat to its new supergroup id and remembers it. */
  private migrateChat(from: string, to: string): void {
    if (!this.chatIds.includes(from) || from === to) return;
    this.chatIds = [...new Set(this.chatIds.map((id) => (id === from ? to : id)))];
    this.state.chatMigrations = { ...this.state.chatMigrations, [from]: to };
    this.saveState();
    this.log(`telegram: a linked group became a supergroup; switched to its new chat id`);
    try {
      this.opts.onChatMigrated?.(from, to);
    } catch (err) {
      this.log(`telegram: saving the new chat id failed: ${this.describe(err)}`);
    }
  }

  /** Sends chunks to one chat; follows a supergroup migration once (and resends there). */
  private async sendTo(chatId: string, chunks: readonly string[]): Promise<void> {
    let target = chatId;
    for (const chunk of chunks) {
      try {
        await this.opts.api.sendMessage(target, chunk);
      } catch (err) {
        if (!(err instanceof TelegramError) || !err.migrateToChatId || target !== chatId) {
          throw err;
        }
        this.migrateChat(chatId, err.migrateToChatId);
        target = err.migrateToChatId;
        await this.opts.api.sendMessage(target, chunk);
      }
    }
  }

  private saveState(): void {
    mkdirSync(dirname(this.opts.statePath), { recursive: true });
    writeFileSync(this.opts.statePath, `${JSON.stringify(this.state, null, 2)}\n`);
  }

  private describe(err: unknown): string {
    return this.opts.api.redact(`${(err as Error).name}: ${(err as Error).message}`);
  }

  /** Sends `html` to every allowed chat; throws only when no chat got all of it. */
  private async broadcast(html: string): Promise<void> {
    const chunks = splitMessage(html);
    let delivered = 0;
    let lastError: unknown;
    for (const chatId of [...this.chatIds]) {
      try {
        await this.sendTo(chatId, chunks);
        delivered++;
      } catch (err) {
        lastError = err;
        this.log(`telegram: sending to a chat failed: ${this.describe(err)}`);
      }
    }
    if (delivered === 0) throw lastError ?? new TelegramError("no chat configured");
  }

  private get forgetDays(): number {
    return this.opts.backlogForgetDays ?? DEFAULT_BACKLOG_FORGET_DAYS;
  }

  /**
   * Sends unsent, unmuted alerts (recent ones only) and marks them sent; with `backlog`, the
   * open debts too (sent even when no alert is new). `to` sends to that chat only, and `always`
   * sends even an empty digest (`/refresh`). Returns what was sent.
   */
  private async sendAlerts(
    levels: readonly AlertLevel[] | null,
    title: string,
    backlog = false,
    target: { to?: string; always?: boolean } = {},
  ): Promise<Sent> {
    const now = this.now();
    const rows = await this.opts.db.alert.findMany({
      where: {
        sentAt: null,
        mutedAt: null,
        createdAt: { gte: new Date(now.getTime() - MAX_ALERT_AGE_MS) },
        ...(levels ? { level: { in: [...levels] } } : {}),
      },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    const none = { alerts: 0, debts: 0, closed: 0, upcoming: 0 };
    if (rows.length === 0 && !backlog && !target.always) return none;
    const closedSince = this.state.lastDigestAt
      ? new Date(this.state.lastDigestAt)
      : new Date(now.getTime() - DAY_MS);
    const ids = rows.map((r) => r.id);
    const report = await buildReport(this.opts.db, {
      now,
      alertIds: ids,
      ...(this.opts.watchedEmails ? { watchedEmails: this.opts.watchedEmails } : {}),
      ...(backlog
        ? {
            backlog: { forgetDays: this.forgetDays },
            autoClosedSince: closedSince,
            upcoming: { days: this.opts.upcomingDays ?? DEFAULT_UPCOMING_DAYS },
          }
        : {}),
    });
    const debts = report.accounts.reduce((n, a) => n + a.backlog.length, 0);
    const upcoming = report.accounts.reduce((n, a) => n + a.upcoming.length, 0);
    const empty = !reportHasAlerts(report) && !debts && !upcoming && !report.autoClosed;
    if (empty && !target.always) return none;
    const all = report.accounts.flatMap((a) => [
      ...a.panics,
      ...a.alerts,
      ...a.checkByHand,
      ...a.info,
    ]);
    const targets = await alertLinks(this.opts.db, [...all, ...report.other]);
    const recheckable = await recheckableAssignments(
      this.opts.db,
      report.accounts.flatMap((a) => a.backlog.map((d) => d.assignmentId)),
    );
    const html = formatAlertsHtml(report, targets, {
      title,
      ...this.loc,
      bot: this.bot,
      recheckable,
      emptyText: messages(this.lang).telegram.nothingPending,
    });
    if (target.to) await this.sendTo(target.to, splitMessage(html));
    else await this.broadcast(html);
    await markAlertsSent(this.opts.db, ids, this.now());
    if (backlog) {
      this.state.lastDigestAt = now.toISOString();
      this.saveState();
    }
    return { alerts: ids.length, debts, closed: report.autoClosed, upcoming };
  }

  /** Unsent panics, right away (also during quiet hours). Returns the count. */
  async sendPanics(): Promise<number> {
    return (await this.sendAlerts(["panic"], messages(this.lang).telegram.urgent)).alerts;
  }

  /** Every unsent alert (any level) plus the open debts, as one digest. */
  sendDigest(title = messages(this.lang).telegram.digest): Promise<Sent> {
    return this.sendAlerts(null, title, true);
  }

  /** Scheduled digest: once a day (in `timeZone`), from `digestTime` on, outside quiet hours. */
  digestDue(at: Date = this.now()): boolean {
    const tz = this.opts.timeZone;
    if (this.opts.quietHours && inQuietHours(this.opts.quietHours, at, tz)) return false;
    const clock = zonedClock(at, tz);
    if (clock.minutes < this.digestMin) return false;
    return this.state.lastDigestDay !== clock.day;
  }

  /** Sends the daily digest when due; failures are logged and retried after 5 minutes. */
  async maybeSendDigest(): Promise<Sent> {
    const now = this.now();
    const none = { alerts: 0, debts: 0, closed: 0, upcoming: 0 };
    if (!this.digestDue(now) || now.getTime() < this.digestRetryAt) return none;
    try {
      const sent = await this.sendDigest(messages(this.lang).telegram.dailyDigest);
      this.state.lastDigestDay = localDay(now, this.opts.timeZone);
      this.saveState();
      return sent;
    } catch (err) {
      this.digestRetryAt = now.getTime() + 5 * 60_000;
      this.log(`telegram: digest failed: ${this.describe(err)}`);
      return none;
    }
  }

  private logDigest(sent: Sent): void {
    if (sent.alerts + sent.debts + sent.closed + sent.upcoming) {
      this.log(
        `telegram: digest with ${sent.alerts} alert(s), ${sent.debts} open debt(s), ${sent.upcoming} upcoming, ${sent.closed} auto-closed sent`,
      );
    }
  }

  /**
   * After a `run` cycle: panics at once, answers the rechecks, sends a fresh digest to every chat
   * that asked with `/refresh`, then the daily digest if it's due. Never throws.
   */
  async afterCycle(result: { rechecked?: readonly RecheckResult[] } = {}): Promise<void> {
    try {
      const n = await this.sendPanics();
      if (n) this.log(`telegram: sent ${n} panic(s)`);
    } catch (err) {
      this.log(`telegram: sending panics failed: ${this.describe(err)}`);
    }
    await this.answerRechecks(result.rechecked ?? []);
    const waiters = [...this.refreshWaiters];
    this.refreshWaiters.clear();
    for (const chatId of waiters) {
      try {
        const title = messages(this.lang).telegram.freshDigest;
        this.logDigest(await this.sendAlerts(null, title, true, { to: chatId, always: true }));
      } catch (err) {
        this.log(`telegram: fresh digest failed: ${this.describe(err)}`);
      }
    }
    this.logDigest(await this.maybeSendDigest());
  }

  private async answerRechecks(results: readonly RecheckResult[]): Promise<void> {
    const t = messages(this.lang).telegram;
    const verdicts = messages(this.lang).report.verdict;
    for (const r of results) {
      const chats = this.recheckInFlight.get(r.assignmentId) ?? new Set<string>();
      this.recheckInFlight.delete(r.assignmentId);
      const item = escapeHtml(itemLabel(r.title, r.course, this.lang));
      let html: string;
      if (r.status === "reviewed" && r.verdict) {
        const alert = r.content
          ? `\n${escapeHtml(truncate(renderAlert(r.content, this.now(), this.loc), LINE_CAP))}`
          : "";
        html = `${t.recheckDone(item, verdicts[r.verdict])}${alert}`;
      } else if (r.status === "not_turned_in") {
        html = t.recheckNotTurnedIn(item);
      } else {
        html = t.recheckFailed(item);
      }
      for (const chatId of chats) {
        try {
          await this.reply(chatId, html);
        } catch (err) {
          this.log(`telegram: recheck reply failed: ${this.describe(err)}`);
        }
      }
    }
    // A step that failed returns no result: don't keep the requests forever.
    this.recheckInFlight.clear();
  }

  /** `/status`: last sync per watched account, open (unmuted, last 7 days) and pending alerts. */
  async statusHtml(): Promise<string> {
    const { db } = this.opts;
    const now = this.now();
    const open = await db.alert.findMany({
      where: {
        mutedAt: null,
        OR: [{ sentAt: null }, { createdAt: { gte: new Date(now.getTime() - MAX_ALERT_AGE_MS) } }],
      },
      select: { id: true },
    });
    const report = await buildReport(db, {
      now,
      alertIds: open.map((a) => a.id),
      upcoming: { days: this.opts.upcomingDays ?? DEFAULT_UPCOMING_DAYS },
      ...(this.opts.watchedEmails ? { watchedEmails: this.opts.watchedEmails } : {}),
    });
    const accounts = await db.account.findMany({
      where: { email: { in: report.accounts.map((a) => a.email) } },
      select: {
        email: true,
        syncRuns: { orderBy: [{ startedAt: "desc" }, { id: "desc" }], take: 1 },
      },
    });
    const lastRun = new Map(accounts.map((a) => [a.email, a.syncRuns[0]]));
    // Every open debt counts here, also those whose alert is listed above.
    const debts = await loadBacklog(db, {
      now,
      forgetDays: this.forgetDays,
      accountIds: report.accounts.map((a) => a.id),
    });
    const debtCount = (accountId: number) => debts.filter((d) => d.accountId === accountId).length;
    const loc = this.loc;
    const t = messages(loc.lang).telegram;
    const counts = (alerts: readonly ReportAlert[]) => {
      const n = (l: AlertLevel) => alerts.filter((a) => a.level === l).length;
      const pending = alerts.filter((a) => a.sentAt === null).length;
      return t.openCounts(n("panic"), n("alert"), n("info"), pending);
    };
    const out = [`${t.status} · ${escapeHtml(formatTime(now, loc))}`];
    if (report.accounts.length === 0) out.push("", t.noAccounts);
    for (const a of report.accounts) {
      const run = lastRun.get(a.email);
      const at = run ? (run.finishedAt ?? run.startedAt) : undefined;
      const sync =
        run && at
          ? `${escapeHtml(t.syncStatus[run.status] ?? run.status)} · ${escapeHtml(
              formatTime(at, loc),
            )} (${formatAgo(now.getTime() - at.getTime(), loc.lang)})`
          : t.never;
      out.push(
        "",
        `👤 <b>${escapeHtml(a.label)}</b>`,
        t.lastSync(sync),
        counts([...a.panics, ...a.alerts, ...a.checkByHand, ...a.info]),
        t.debtCount(debtCount(a.id)),
        t.upcomingCount(a.upcoming.length),
      );
    }
    if (report.other.length) out.push("", `${t.other}: ${counts(report.other)}`);
    out.push("", t.statusFooter(escapeHtml(this.opts.digestTime), this.forgetDays));
    return out.join("\n");
  }

  /** Replies in the chat the command came from (a private chat or a group). */
  private async reply(chatId: string, html: string): Promise<void> {
    await this.sendTo(chatId, splitMessage(html));
  }

  /**
   * Handles one update: commands from allowed chats only (private chats and groups alike, also
   * `/cmd@bot`); everything else is ignored. A linked group's "migrated to supergroup" service
   * message switches the chat id.
   */
  async handleUpdate(update: TgUpdate): Promise<void> {
    const msg = update.message;
    if (!msg) return;
    const chatId = String(msg.chat.id);
    if (!this.chatIds.includes(chatId)) return;
    if (msg.migrate_to_chat_id !== undefined) {
      this.migrateChat(chatId, String(msg.migrate_to_chat_id));
      return;
    }
    if (!msg.text) return;
    const cmd = parseCommand(msg.text);
    if (!cmd) return;
    const t = messages(this.lang).telegram;
    switch (cmd.name) {
      case "status":
        await this.reply(chatId, await this.statusHtml());
        return;
      case "digest": {
        const sent = await this.sendDigest();
        if (sent.alerts + sent.debts + sent.closed + sent.upcoming === 0) {
          await this.reply(chatId, t.nothingPending);
        }
        return;
      }
      case "refresh": {
        if (this.busy) {
          this.refreshWaiters.add(chatId);
          await this.reply(chatId, t.alreadyRunning);
          return;
        }
        const left = this.lastManualAt + this.cooldownMs - this.now().getTime();
        if (left > 0 && !this.refreshQueued) {
          const every = Math.round(this.cooldownMs / 60_000);
          await this.reply(chatId, t.cooldown(Math.ceil(left / 60_000), every));
          return;
        }
        this.refreshWaiters.add(chatId);
        this.refreshQueued = true;
        await this.reply(chatId, t.refreshing);
        return;
      }
      case "recheck": {
        const ref = cmd.args.join(" ");
        const found = ref ? await findRecheckTarget(this.opts.db, ref) : null;
        if (!found) {
          await this.reply(chatId, t.recheckUsage);
          return;
        }
        const item = escapeHtml(itemLabel(found.title, found.course, this.lang));
        if (!found.turnedIn) {
          await this.reply(chatId, t.recheckNotTurnedIn(item));
          return;
        }
        const chats = this.rechecks.get(found.assignmentId) ?? new Set<string>();
        chats.add(chatId);
        this.rechecks.set(found.assignmentId, chats);
        await this.reply(chatId, t.recheckQueued(item));
        return;
      }
      case "ack": {
        const ids = cmd.args.map(Number).filter((n) => Number.isInteger(n) && n > 0);
        if (ids.length === 0) {
          await this.reply(chatId, t.ackUsage);
          return;
        }
        const lines: string[] = [];
        for (const id of ids) {
          const alert = await muteAlert(this.opts.db, id, this.now());
          lines.push(alert ? t.acked(id) : t.noAlert(id));
        }
        await this.reply(chatId, lines.join("\n"));
        return;
      }
      default:
        await this.reply(chatId, t.help);
    }
  }

  /** One `getUpdates` long poll; handles what arrives and stores the new offset. */
  async pollOnce(timeoutSec: number, signal: AbortSignal): Promise<number> {
    const guard = AbortSignal.any([signal, AbortSignal.timeout((timeoutSec + 15) * 1000)]);
    const updates = await this.opts.api.getUpdates(
      {
        ...(this.state.updateOffset !== undefined ? { offset: this.state.updateOffset } : {}),
        timeout: timeoutSec,
        allowed_updates: ["message"],
      },
      guard,
    );
    for (const u of updates) {
      this.state.updateOffset = u.update_id + 1;
      try {
        await this.handleUpdate(u);
      } catch (err) {
        this.log(`telegram: command failed: ${this.describe(err)}`);
      }
    }
    if (updates.length) this.saveState();
    return updates.length;
  }

  /**
   * Replaces the `run` loop's sleep: long-polls for commands for `ms` and sends the daily
   * digest when it's due. Returns early when `signal` aborts.
   */
  async idle(ms: number, signal: AbortSignal): Promise<void> {
    const sleep = this.opts.sleep ?? abortableSleep;
    const end = this.now().getTime() + ms;
    while (!signal.aborted) {
      this.logDigest(await this.maybeSendDigest());
      // `/refresh` or `/recheck`: hand control back so the loop runs a cycle now.
      if (this.manualPending()) return;
      const left = end - this.now().getTime();
      if (left < 1000) {
        if (left > 0) await sleep(left, signal);
        return;
      }
      try {
        await this.pollOnce(Math.min(this.pollTimeoutSec, Math.floor(left / 1000)), signal);
      } catch (err) {
        if (signal.aborted) return;
        this.log(`telegram: polling failed: ${this.describe(err)}`);
        await sleep(Math.min(30_000, left), signal);
      }
    }
  }
}
