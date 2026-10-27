import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadBacklog } from "../checks/backlog.ts";
import { findRecheckTarget, type RecheckResult } from "../checks/recheck.ts";
import { detailsUrl } from "../collector/classroom/todo.ts";
import {
  DEFAULT_LANG,
  formatAgo,
  formatTime,
  itemLabel,
  type Lang,
  type Locale,
  messages,
  renderAlert,
  zonedClock,
} from "../i18n/index.ts";
import type { LoginInfo, LoginLayout, LoginState } from "../login/index.ts";
import { abortableSleep } from "../run/cycle.ts";
import { inQuietHours, type QuietHours } from "../run/schedule.ts";
import { type Db, markAlertsSent, muteAlert } from "../store/index.ts";
import type { AlertLevel } from "../store/types.ts";
import {
  accountLabel,
  buildReport,
  DEFAULT_UPCOMING_DAYS,
  parseAlertKey,
  type Report,
  type ReportAlert,
  reportHasAlerts,
} from "./console.ts";
import {
  type Action,
  type Button,
  buildModel,
  cardView,
  type DigestModel,
  decodeAction,
  escapeHtml,
  findGroup,
  listView,
  loadModelInput,
  loginAskView,
  loginCheckingView,
  loginLostView,
  loginOpenView,
  loginResultView,
  loginWaitView,
  summaryView,
  upcomingView,
  type View,
} from "./telegram-views.ts";

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

/** What a digest carried: open alerts (the new ones now marked sent) and open debts. */
export interface Sent {
  alerts: number;
  /** Of `alerts`, the ones sent for the first time. */
  fresh: number;
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

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  /** The bot's message the button was on (absent for very old messages). */
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
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

  /** Calls `method`; waits out one 429 (`retry_after`, ≤ 60s) and retries. */
  private async callRetrying<T>(method: string, params: object): Promise<T> {
    try {
      return await this.call<T>(method, params);
    } catch (err) {
      if (!(err instanceof TelegramError) || err.code !== 429) throw err;
      await delay(Math.min(err.retryAfterSec ?? 1, 60) * 1000);
      return await this.call<T>(method, params);
    }
  }

  /** Sends one HTML message (≤ 4096 chars), with inline buttons when given. */
  sendMessage(chatId: string, html: string, keyboard?: Button[][]): Promise<TgMessage> {
    return this.callRetrying<TgMessage>("sendMessage", {
      chat_id: chatId,
      text: html,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    });
  }

  /** Rewrites one of the bot's messages in place; "not modified" counts as done. */
  async editMessage(
    chatId: string,
    messageId: number,
    html: string,
    keyboard: Button[][],
  ): Promise<void> {
    try {
      await this.callRetrying("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: html,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: keyboard },
      });
    } catch (err) {
      if (err instanceof TelegramError && /not modified/i.test(err.message)) return;
      throw err;
    }
  }

  /** Ends a button's loading state, with a short popup when `text` is given. */
  async answerCallback(id: string, text?: string): Promise<void> {
    await this.call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) });
  }
}

// ---------------------------------------------------------------------------------------------
// Formatting

export { escapeHtml };

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

/** What a digest line links to: the assignment details page, and whether it can be re-checked. */
export interface AlertTarget {
  url: string;
  assignmentId: number;
  /** The assignment has turned-in work (`/recheck_<assignmentId>` makes sense). */
  recheck: boolean;
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
  /**
   * What each recent digest or card message shows (`<chatId>:<messageId>` → view), so a button
   * tap re-renders the same alerts with fresh state (#66). The newest `MAX_VIEWS` are kept.
   */
  views?: Record<string, ViewState>;
}

/** The alerts a sent message was built from; debts and upcoming work are always current. */
export interface ViewState {
  alerts: number[];
  /** Alerts that were new (not sent before) in this message: marked 🆕. */
  fresh?: number[];
  /** A digest: its title. */
  title?: DigestTitle;
  /** A digest: "closed automatically" count at send time. */
  closed?: number;
  /** A standalone card: the group it shows and its header. */
  card?: string;
  header?: "urgent" | "comment";
  /** ISO send time. */
  at: string;
}

export type DigestTitle = "digest" | "dailyDigest" | "freshDigest";

/** Messages whose buttons keep working; older taps get "out of date". */
export const MAX_VIEWS = 200;

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
  /** The `run` loop's hand login (#79); without it `/login` says it's unavailable. */
  login?: LoginControl;
}

/** What the bot needs of `LoginService` (#78). */
export interface LoginControl {
  readonly mode: "local" | "vnc";
  readonly active: LoginInfo | undefined;
  pending(): boolean;
  request(layout?: LoginLayout): void;
  finish(): boolean;
}

/** Default `refreshCooldownMin`. */
export const DEFAULT_REFRESH_COOLDOWN_MIN = 5;

/** The bot's commands, for `setMyCommands`. */
export const BOT_COMMANDS = ["status", "digest", "refresh", "recheck", "login", "help"] as const;

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
  /**
   * Waiting for a fresh digest after the next/current cycle: `/refresh` (a new message in that
   * chat) or the 🔄 button (that message is rewritten). Keyed by chat or `chat:message`.
   */
  private refreshWaiters = new Map<string, { chatId: string; messageId?: number }>();
  /** `/refresh` asked for a cycle that hasn't started yet. */
  private refreshQueued = false;
  /** `/recheck` requests not handed to a cycle yet: assignment id → chats to answer. */
  private rechecks = new Map<number, Set<string>>();
  /** Rechecks handed to the current cycle. */
  private recheckInFlight = new Map<number, Set<string>>();
  /** When the last manual cycle started (epoch ms). */
  private lastManualAt = Number.NEGATIVE_INFINITY;
  private bot: string | undefined;
  /** Login messages that follow the asked-for or open login (#79), keyed `chat:message`. */
  private loginMsgs = new Map<string, { chatId: string; messageId: number }>();

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
    for (const chunk of chunks) target = await this.sendOne(target, chunk);
  }

  /**
   * Sends one message to a chat, following a supergroup migration once; returns the chat id it
   * went to and the message id.
   */
  private async sendOne(chatId: string, html: string, keyboard?: Button[][]): Promise<string> {
    return (await this.sendOneMessage(chatId, html, keyboard)).chatId;
  }

  private async sendOneMessage(
    chatId: string,
    html: string,
    keyboard?: Button[][],
  ): Promise<{ chatId: string; messageId: number }> {
    try {
      const msg = await this.opts.api.sendMessage(chatId, html, keyboard);
      return { chatId, messageId: msg.message_id };
    } catch (err) {
      if (!(err instanceof TelegramError) || !err.migrateToChatId) throw err;
      this.migrateChat(chatId, err.migrateToChatId);
      const to = err.migrateToChatId;
      const msg = await this.opts.api.sendMessage(to, html, keyboard);
      return { chatId: to, messageId: msg.message_id };
    }
  }

  /** Sends a view with buttons and remembers what it shows. */
  private async sendView(chatId: string, view: View, state: Omit<ViewState, "at">): Promise<void> {
    const sent = await this.sendOneMessage(chatId, view.html, view.keyboard);
    this.rememberView(sent.chatId, sent.messageId, state);
  }

  private rememberView(chatId: string, messageId: number, state: Omit<ViewState, "at">): void {
    const views = { ...this.state.views };
    delete views[`${chatId}:${messageId}`];
    views[`${chatId}:${messageId}`] = { ...state, at: this.now().toISOString() };
    const keys = Object.keys(views);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_VIEWS))) delete views[k];
    this.state.views = views;
    this.saveState();
  }

  /** Sends a view to every allowed chat; throws only when no chat got it. */
  private async broadcastView(view: View, state: Omit<ViewState, "at">): Promise<void> {
    let delivered = 0;
    let lastError: unknown;
    for (const chatId of [...this.chatIds]) {
      try {
        await this.sendView(chatId, view, state);
        delivered++;
      } catch (err) {
        lastError = err;
        this.log(`telegram: sending to a chat failed: ${this.describe(err)}`);
      }
    }
    if (delivered === 0) throw lastError ?? new TelegramError("no chat configured");
  }

  private saveState(): void {
    mkdirSync(dirname(this.opts.statePath), { recursive: true });
    writeFileSync(this.opts.statePath, `${JSON.stringify(this.state, null, 2)}\n`);
  }

  private describe(err: unknown): string {
    return this.opts.api.redact(`${(err as Error).name}: ${(err as Error).message}`);
  }

  private get forgetDays(): number {
    return this.opts.backlogForgetDays ?? DEFAULT_BACKLOG_FORGET_DAYS;
  }

  /** Unmuted alerts created within `MAX_ALERT_AGE_MS`, optionally unsent only / of some levels. */
  private async recentAlerts() {
    const now = this.now();
    return this.opts.db.alert.findMany({
      where: {
        mutedAt: null,
        createdAt: { gte: new Date(now.getTime() - MAX_ALERT_AGE_MS) },
      },
      select: { id: true, key: true, level: true, sentAt: true },
      orderBy: { id: "asc" },
    });
  }

  /** The digest model for `alertIds` plus the current debts and upcoming work. */
  private async model(
    alertIds: readonly number[],
    opts: { autoClosedSince?: Date; fresh?: readonly number[] } = {},
  ): Promise<{ model: DigestModel; report: Report }> {
    const { autoClosedSince } = opts;
    const { db } = this.opts;
    const report = await buildReport(db, {
      now: this.now(),
      alertIds: [...new Set(alertIds)],
      ...(this.opts.watchedEmails ? { watchedEmails: this.opts.watchedEmails } : {}),
      backlog: { forgetDays: this.forgetDays },
      depthDays: this.forgetDays,
      upcoming: { days: this.opts.upcomingDays ?? DEFAULT_UPCOMING_DAYS },
      ...(autoClosedSince ? { autoClosedSince } : {}),
    });
    const alerts = [
      ...report.accounts.flatMap((a) => [...a.panics, ...a.alerts, ...a.checkByHand, ...a.info]),
      ...report.other,
    ];
    const targets = await alertLinks(db, alerts);
    const alertAssignments = new Map([...targets].map(([id, t]) => [id, t.assignmentId]));
    const urls = new Map([...targets.values()].map((t) => [t.assignmentId, t.url]));
    const input = await loadModelInput(db, report, alertAssignments, urls, this.loc);
    if (opts.fresh) input.fresh = new Set(opts.fresh);
    return { model: buildModel(input), report };
  }

  private titleHtml(title: DigestTitle | undefined): string {
    return messages(this.lang).telegram[title ?? "digest"];
  }

  /**
   * Sends the digest summary and marks its alerts sent. It shows every open alert (unmuted, last
   * 7 days; the unsent ones as 🆕) plus the open debts and upcoming work, so an item stays until
   * it's marked seen or resolved. `to` sends to that chat only, `always` sends even an empty digest (`/refresh`),
   * `edit` rewrites that message instead (🔄), keeping the alerts it showed. Returns what was sent.
   */
  private async sendDigestView(
    title: DigestTitle,
    target: { to?: string; always?: boolean; edit?: { chatId: string; messageId: number } } = {},
  ): Promise<Sent> {
    const now = this.now();
    const open = await this.recentAlerts();
    const ids = open.filter((a) => a.sentAt === null).map((a) => a.id);
    const edited = target.edit
      ? this.state.views?.[`${target.edit.chatId}:${target.edit.messageId}`]
      : undefined;
    const closedSince = this.state.lastDigestAt
      ? new Date(this.state.lastDigestAt)
      : new Date(now.getTime() - DAY_MS);
    const alerts = [...new Set([...(edited?.alerts ?? []), ...open.map((a) => a.id)])];
    const fresh = [...new Set([...(edited?.fresh ?? []), ...ids])];
    const { model, report } = await this.model(alerts, { autoClosedSince: closedSince, fresh });
    const debts = report.accounts.reduce((n, a) => n + a.backlog.length, 0);
    const upcoming = report.accounts.reduce((n, a) => n + a.upcoming.length, 0);
    const none = { alerts: 0, fresh: 0, debts: 0, closed: 0, upcoming: 0 };
    const empty = !reportHasAlerts(report) && !debts && !upcoming && !report.autoClosed;
    if (empty && !target.always && !target.edit) return none;
    const view = summaryView(model, this.titleHtml(title), this.loc);
    const state = {
      alerts,
      fresh,
      title,
      closed: report.autoClosed,
    };
    if (target.edit) {
      await this.opts.api.editMessage(
        target.edit.chatId,
        target.edit.messageId,
        view.html,
        view.keyboard,
      );
      this.rememberView(target.edit.chatId, target.edit.messageId, state);
    } else if (target.to) await this.sendView(target.to, view, state);
    else await this.broadcastView(view, state);
    await markAlertsSent(this.opts.db, ids, this.now());
    this.state.lastDigestAt = now.toISOString();
    this.saveState();
    return { alerts: alerts.length, fresh: ids.length, debts, closed: report.autoClosed, upcoming };
  }

  /**
   * Unsent panics (also during quiet hours) and fresh teacher comments (outside them), right
   * away: one standalone card per assignment, showing all its open problems. Returns the count
   * of alerts sent.
   */
  async sendCards(): Promise<number> {
    const now = this.now();
    const quiet = this.opts.quietHours
      ? inQuietHours(this.opts.quietHours, now, this.opts.timeZone)
      : false;
    const open = await this.recentAlerts();
    const fresh = open.filter(
      (a) => a.sentAt === null && (a.level === "panic" || (!quiet && a.key.startsWith("comment:"))),
    );
    if (fresh.length === 0) return 0;
    const ids = new Set(fresh.map((a) => a.id));
    const { model } = await this.model(
      open.map((a) => a.id),
      { fresh: [...ids] },
    );
    const t = messages(this.lang).telegram;
    for (const g of model.kids.flatMap((k) => k.groups)) {
      const mine = g.problems.filter((p) => p.alertId !== null && ids.has(p.alertId));
      if (mine.length === 0) continue;
      const header = mine.some((p) => p.rank === 0) ? "urgent" : "comment";
      const view = cardView(
        g,
        this.loc,
        undefined,
        header === "urgent" ? t.urgent : t.view.newComment,
      );
      const alerts = g.problems.flatMap((p) => (p.alertId === null ? [] : [p.alertId]));
      await this.broadcastView(view, { alerts, fresh: [...ids], card: g.ref, header });
    }
    await markAlertsSent(this.opts.db, [...ids], this.now());
    return ids.size;
  }

  /** Every unsent alert (any level) plus the open debts, as one digest. */
  sendDigest(title: DigestTitle = "digest"): Promise<Sent> {
    return this.sendDigestView(title);
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
    const none = { alerts: 0, fresh: 0, debts: 0, closed: 0, upcoming: 0 };
    if (!this.digestDue(now) || now.getTime() < this.digestRetryAt) return none;
    try {
      const sent = await this.sendDigest("dailyDigest");
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
        `telegram: digest with ${sent.alerts} open alert(s) (${sent.fresh} new), ${sent.debts} open debt(s), ${sent.upcoming} upcoming, ${sent.closed} auto-closed sent`,
      );
    }
  }

  /**
   * After a `run` cycle: panics at once, answers the rechecks, sends a fresh digest to every chat
   * that asked with `/refresh`, then the daily digest if it's due. Never throws.
   */
  async afterCycle(
    result: { rechecked?: readonly RecheckResult[]; newAlertIds?: readonly number[] } = {},
  ): Promise<void> {
    try {
      const n = await this.sendCards();
      if (n) this.log(`telegram: sent ${n} urgent alert(s) or comment(s) as cards`);
    } catch (err) {
      this.log(`telegram: sending cards failed: ${this.describe(err)}`);
    }
    try {
      await this.pushLostLogin(result.newAlertIds ?? []);
    } catch (err) {
      this.log(`telegram: lost-login message failed: ${this.describe(err)}`);
    }
    await this.answerRechecks(result.rechecked ?? []);
    const waiters = [...this.refreshWaiters.values()];
    this.refreshWaiters.clear();
    for (const w of waiters) {
      try {
        this.logDigest(
          await this.sendDigestView(
            "freshDigest",
            w.messageId === undefined
              ? { to: w.chatId, always: true }
              : { edit: { chatId: w.chatId, messageId: w.messageId } },
          ),
        );
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
        // A warn/panic alert already carries the summary.
        const summary =
          r.summary && r.content?.code !== "quality.review"
            ? `\n${escapeHtml(truncate(r.summary, LINE_CAP))}`
            : "";
        const alert = r.content
          ? `\n${escapeHtml(truncate(renderAlert(r.content, this.now(), this.loc), LINE_CAP))}`
          : "";
        html = `${t.recheckDone(item, verdicts[r.verdict])}${summary}${alert}`;
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
      depthDays: this.forgetDays,
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
    if (update.callback_query) {
      await this.handleCallback(update.callback_query);
      return;
    }
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
        const left = this.queueRefresh({ chatId });
        if (left === "busy") await this.reply(chatId, t.alreadyRunning);
        else if (left > 0) {
          const every = Math.round(this.cooldownMs / 60_000);
          await this.reply(chatId, t.cooldown(Math.ceil(left / 60_000), every));
        } else await this.reply(chatId, t.refreshing);
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
      case "login":
        if (!(await this.openLogin(chatId, {}))) await this.reply(chatId, t.login.unavailable);
        return;
      default:
        await this.reply(chatId, t.help);
    }
  }

  /**
   * Asks for a manual cycle whose digest goes to `waiter`. Returns 0 when queued, "busy" when a
   * cycle is running (the digest follows it), or the minutes of cooldown left (nothing queued).
   */
  private queueRefresh(waiter: { chatId: string; messageId?: number }): 0 | "busy" | number {
    const key =
      waiter.messageId === undefined ? waiter.chatId : `${waiter.chatId}:${waiter.messageId}`;
    if (this.busy) {
      this.refreshWaiters.set(key, waiter);
      return "busy";
    }
    const left = this.lastManualAt + this.cooldownMs - this.now().getTime();
    if (left > 0 && !this.refreshQueued) return left;
    this.refreshWaiters.set(key, waiter);
    this.refreshQueued = true;
    return 0;
  }

  /** The model a sent view shows now: its alerts (marked seen or not) plus current debts. */
  private async viewModel(view: ViewState): Promise<DigestModel> {
    const { model } = await this.model(view.alerts, { fresh: view.fresh ?? [] });
    return { ...model, autoClosed: view.closed ?? 0 };
  }

  /** Labels of watched accounts whose latest sync found no valid login. */
  private async lostLoginLabels(): Promise<string[]> {
    const accounts = await this.opts.db.account.findMany({
      where: { watched: true },
      orderBy: { id: "asc" },
      select: {
        email: true,
        displayName: true,
        syncRuns: { orderBy: [{ startedAt: "desc" }, { id: "desc" }], take: 1 },
      },
    });
    return accounts
      .filter((a) => /^session_/.test(a.syncRuns[0]?.status ?? ""))
      .map((a) => accountLabel(a));
  }

  /** Kid labels for emails (the account's label when it's in the DB). */
  private async labelsOf(emails: readonly string[]): Promise<string[]> {
    const rows = await this.opts.db.account.findMany({
      where: { email: { in: [...emails] } },
      select: { email: true, displayName: true },
    });
    const by = new Map(rows.map((r) => [r.email, accountLabel(r)]));
    return emails.map((e) => by.get(e) ?? accountLabel({ email: e, displayName: null }));
  }

  /** Sends `view`, or rewrites message `edit` with it; returns the message id. */
  private async showView(chatId: string, view: View, edit?: number): Promise<number> {
    if (edit !== undefined) {
      await this.opts.api.editMessage(chatId, edit, view.html, view.keyboard);
      return edit;
    }
    return (await this.opts.api.sendMessage(chatId, view.html, view.keyboard)).message_id;
  }

  /**
   * `/login` or 🔑 (#79): with noVNC and no layout yet, asks computer or phone; otherwise asks the
   * loop for a login (unless one is open) and shows it. The message then follows the login
   * (`onLoginState`). `edit` rewrites a login message instead of sending a new one. False when
   * no loop can open a login.
   */
  private async openLogin(
    chatId: string,
    opts: { layout?: LoginLayout; edit?: number },
  ): Promise<boolean> {
    const login = this.opts.login;
    if (!login) return false;
    if (!login.active && !opts.layout && login.mode === "vnc") {
      await this.showView(chatId, loginAskView(this.loc), opts.edit);
      return true;
    }
    if (!login.active) login.request(opts.layout ?? "desktop");
    const info = login.active;
    const view = info
      ? loginOpenView(info, await this.lostLoginLabels(), this.loc)
      : loginWaitView(this.loc);
    const messageId = await this.showView(chatId, view, opts.edit);
    this.loginMsgs.set(`${chatId}:${messageId}`, { chatId, messageId });
    return true;
  }

  /** 🔑 and ✅ Done taps; a 🔑 on a digest opens a new message, on a login message edits it. */
  private async handleLoginTap(
    queryId: string,
    chatId: string,
    messageId: number,
    action: Extract<Action, { kind: "login" | "loginDone" }>,
    onDigest: boolean,
  ): Promise<void> {
    const api = this.opts.api;
    const l = messages(this.lang).telegram.login;
    if (action.kind === "loginDone") {
      if (!this.opts.login?.finish()) {
        await api.answerCallback(queryId, l.toast.notOpen);
        return;
      }
      await api.answerCallback(queryId, l.toast.checking);
      const view = loginCheckingView(this.loc);
      for (const m of this.loginMsgs.values()) {
        await api.editMessage(m.chatId, m.messageId, view.html, view.keyboard);
      }
      return;
    }
    if (!this.opts.login) {
      await api.answerCallback(queryId, l.unavailable);
      return;
    }
    await api.answerCallback(queryId, l.toast.opening);
    await this.openLogin(chatId, {
      ...(action.layout ? { layout: action.layout } : {}),
      ...(onDigest ? {} : { edit: messageId }),
    });
  }

  /**
   * Called by `LoginService` on every change: the login messages show the open login (with its
   * link), then how it ended. Never throws.
   */
  async onLoginState(state: LoginState): Promise<void> {
    try {
      const view =
        state.status === "active"
          ? loginOpenView(state.info, await this.lostLoginLabels(), this.loc)
          : state.result
            ? loginResultView(state.result, await this.labelsOf(state.result.missing), this.loc)
            : null;
      if (!view) return;
      for (const m of this.loginMsgs.values()) {
        try {
          await this.opts.api.editMessage(m.chatId, m.messageId, view.html, view.keyboard);
        } catch (err) {
          this.log(`telegram: login message update failed: ${this.describe(err)}`);
        }
      }
      if (state.status === "done") this.loginMsgs.clear();
    } catch (err) {
      this.log(`telegram: login message update failed: ${this.describe(err)}`);
    }
  }

  /**
   * A cycle raised a lost-login alert (once per account and day): say so at once with 🔑, so
   * the fix doesn't wait for the daily digest. Not while a login is asked for or open.
   */
  private async pushLostLogin(newAlertIds: readonly number[]): Promise<void> {
    const login = this.opts.login;
    if (!login || login.active || login.pending() || !newAlertIds.length) return;
    const alerts = await this.opts.db.alert.findMany({
      where: { id: { in: [...newAlertIds] }, code: "sync.session", mutedAt: null },
      select: { key: true },
    });
    const ids = alerts.flatMap((a) => {
      const k = parseAlertKey(a.key);
      return k?.kind === "sync" ? [k.accountId] : [];
    });
    if (!ids.length) return;
    const accounts = await this.opts.db.account.findMany({
      where: { id: { in: ids } },
      orderBy: { id: "asc" },
      select: { email: true, displayName: true },
    });
    const view = loginLostView(
      accounts.map((a) => accountLabel(a)),
      this.loc,
    );
    for (const chatId of this.chatIds) {
      await this.opts.api.sendMessage(chatId, view.html, view.keyboard);
    }
    this.log(`telegram: lost login of ${accounts.length} account(s) announced`);
  }

  /**
   * A button tap (#66): answered with a short popup at most, and the message is rewritten in
   * place, so the chat never scrolls. Taps from other chats and on unknown messages are ignored.
   */
  private async handleCallback(q: TgCallbackQuery): Promise<void> {
    const api = this.opts.api;
    const msg = q.message;
    const chatId = msg ? String(msg.chat.id) : "";
    if (!msg || !this.chatIds.includes(chatId)) {
      await api.answerCallback(q.id);
      return;
    }
    const v = messages(this.lang).telegram.view;
    const action = decodeAction(q.data ?? "");
    const view = this.state.views?.[`${chatId}:${msg.message_id}`];
    if (action?.kind === "login" || action?.kind === "loginDone") {
      await this.handleLoginTap(q.id, chatId, msg.message_id, action, Boolean(view));
      return;
    }
    if (!action || !view) {
      await api.answerCallback(q.id, v.toast.stale);
      return;
    }
    switch (action.kind) {
      case "noop":
        await api.answerCallback(q.id);
        return;
      case "refresh": {
        const left = this.queueRefresh({ chatId, messageId: msg.message_id });
        const toast =
          left === "busy"
            ? v.toast.alreadyRunning
            : left > 0
              ? v.toast.cooldown(Math.ceil(left / 60_000))
              : v.toast.refreshing;
        await api.answerCallback(q.id, toast);
        return;
      }
      case "recheck": {
        const found = await findRecheckTarget(this.opts.db, String(action.assignmentId));
        if (!found?.turnedIn) {
          await api.answerCallback(q.id, v.toast.notTurnedIn);
          return;
        }
        const chats = this.rechecks.get(found.assignmentId) ?? new Set<string>();
        chats.add(chatId);
        this.rechecks.set(found.assignmentId, chats);
        await api.answerCallback(q.id, v.toast.recheckQueued);
        return;
      }
    }
    let model = await this.viewModel(view);
    let toast: string | undefined;
    if (action.kind === "seen" || action.kind === "seenCard") {
      const g = findGroup(model, action.ref);
      const muting = g?.problems.filter((p) => p.alertId !== null && !p.acked) ?? [];
      for (const p of muting)
        if (p.alertId !== null) await muteAlert(this.opts.db, p.alertId, this.now());
      toast = muting.some((p) => p.keepsDebt) ? v.toast.seenKeepsDebt : v.toast.seen;
      model = await this.viewModel(view);
    }
    const next = this.render(action, view, model);
    await api.answerCallback(q.id, next ? toast : v.toast.stale);
    if (next) await api.editMessage(chatId, msg.message_id, next.html, next.keyboard);
  }

  /** The view an action leads to; null when what it points at is gone. */
  private render(action: Action, view: ViewState, model: DigestModel): View | null {
    const loc = this.loc;
    const t = messages(this.lang).telegram;
    switch (action.kind) {
      case "home":
        return summaryView(model, this.titleHtml(view.title), loc);
      case "list":
      case "seen":
        return listView(model, action.kid, action.page, loc);
      case "card": {
        const g = findGroup(model, action.ref);
        return g
          ? cardView(g, loc, { kid: action.kid, page: action.page })
          : listView(model, action.kid, action.page, loc);
      }
      case "seenCard": {
        const g = findGroup(model, action.ref);
        const header = view.header === "comment" ? t.view.newComment : t.urgent;
        return g ? cardView(g, loc, undefined, header) : null;
      }
      case "upcoming":
        return upcomingView(model, loc);
      default:
        return null;
    }
  }

  /** One `getUpdates` long poll; handles what arrives and stores the new offset. */
  async pollOnce(timeoutSec: number, signal: AbortSignal): Promise<number> {
    const guard = AbortSignal.any([signal, AbortSignal.timeout((timeoutSec + 15) * 1000)]);
    const updates = await this.opts.api.getUpdates(
      {
        ...(this.state.updateOffset !== undefined ? { offset: this.state.updateOffset } : {}),
        timeout: timeoutSec,
        allowed_updates: ["message", "callback_query"],
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
