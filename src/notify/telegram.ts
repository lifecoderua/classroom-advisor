import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { detailsUrl } from "../collector/classroom/todo.ts";
import { abortableSleep } from "../run/cycle.ts";
import { inQuietHours, type QuietHours } from "../run/schedule.ts";
import { type Db, markAlertsSent, muteAlert } from "../store/index.ts";
import type { AlertLevel } from "../store/types.ts";
import {
  buildReport,
  formatTime,
  parseAlertKey,
  type Report,
  type ReportAlert,
  reportHasAlerts,
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

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export class TelegramError extends Error {
  override name = "TelegramError";
  constructor(
    message: string,
    readonly code?: number,
    readonly retryAfterSec?: number,
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
      parameters?: { retry_after?: number };
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

function alertLine(a: ReportAlert, links: ReadonlyMap<number, string>): string {
  const url = links.get(a.id);
  const link = url ? ` · <a href="${escapeHtml(url)}">open</a>` : "";
  return `${LEVEL_ICON[a.level]} ${escapeHtml(truncate(a.message, LINE_CAP))}${link} · /ack_${a.id}`;
}

export interface TelegramFormatOptions {
  /** Header line, already HTML (e.g. `🚨 <b>Urgent</b>`). */
  title: string;
  timeZone?: string;
}

/** The alerts of a report, grouped per kid (panics, alerts, info), as Telegram HTML. */
export function formatAlertsHtml(
  report: Report,
  links: ReadonlyMap<number, string>,
  opts: TelegramFormatOptions,
): string {
  const out = [`${opts.title} · ${escapeHtml(formatTime(report.generatedAt, opts.timeZone))}`];
  for (const a of report.accounts) {
    const alerts = [...a.panics, ...a.alerts, ...a.info];
    if (alerts.length === 0) continue;
    out.push("", `👤 <b>${escapeHtml(a.label)}</b>`, ...alerts.map((x) => alertLine(x, links)));
  }
  if (report.other.length) {
    out.push("", "<b>Other</b>", ...report.other.map((x) => alertLine(x, links)));
  }
  return out.join("\n");
}

/**
 * Assignment details URL (with `authuser=<email>`) per alert, for alerts whose key points at an
 * assignment: `deadline:<assignmentId>`, `quality:<submissionVersionId>`, `comment:<commentId>`.
 */
export async function alertLinks(
  db: Db,
  alerts: readonly Pick<ReportAlert, "id" | "key">[],
): Promise<Map<number, string>> {
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
    },
  });
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
  const out = new Map<number, string>();
  for (const [alertId, assignmentId] of assignmentOf) {
    const url = urls.get(assignmentId);
    if (url) out.set(alertId, url);
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

/** `5m ago`, `3h ago`, `2d ago`. */
export function formatAgo(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export const HELP_TEXT = [
  "<b>classroom-advisor</b>",
  "/status – last sync and open alerts per kid",
  "/digest – send the pending digest now",
  "/ack &lt;id&gt; – mute an alert (or tap /ack_&lt;id&gt; under it)",
].join("\n");

// ---------------------------------------------------------------------------------------------
// Notifier

export interface TelegramState {
  /** Next `getUpdates` offset (last handled update id + 1). */
  updateOffset?: number;
  /** Local `YYYY-MM-DD` of the last scheduled digest. */
  lastDigestDay?: string;
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

/** Local calendar day `YYYY-MM-DD` (process time zone, like quiet hours). */
export function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
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
  /** Local `HH:MM` of the daily digest. */
  digestTime: string;
  quietHours?: QuietHours;
  /** JSON file for the update offset and the last digest day (`<dataDir>/telegram.json`). */
  statePath: string;
  watchedEmails?: readonly string[];
  now?: () => Date;
  log?: (line: string) => void;
  timeZone?: string;
  /** Resolves after `ms` or as soon as `signal` aborts (used after a polling error). */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Long-poll timeout per `getUpdates`, in seconds. */
  pollTimeoutSec?: number;
}

export class TelegramNotifier {
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private readonly digestMin: number;
  private readonly pollTimeoutSec: number;
  private state: TelegramState;
  /** After a failed scheduled digest, don't retry before this time. */
  private digestRetryAt = 0;

  constructor(private readonly opts: NotifierOptions) {
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? console.log;
    this.digestMin = parseClockTime(opts.digestTime);
    this.pollTimeoutSec = opts.pollTimeoutSec ?? 50;
    this.state = readState(opts.statePath);
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
    for (const chatId of this.opts.chatIds) {
      try {
        for (const chunk of chunks) await this.opts.api.sendMessage(chatId, chunk);
        delivered++;
      } catch (err) {
        lastError = err;
        this.log(`telegram: sending to a chat failed: ${this.describe(err)}`);
      }
    }
    if (delivered === 0) throw lastError ?? new TelegramError("no chat configured");
  }

  /** Sends unsent, unmuted alerts (recent ones only) and marks them sent. Returns the count. */
  private async sendAlerts(levels: readonly AlertLevel[] | null, title: string): Promise<number> {
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
    if (rows.length === 0) return 0;
    const ids = rows.map((r) => r.id);
    const report = await buildReport(this.opts.db, {
      now,
      alertIds: ids,
      ...(this.opts.watchedEmails ? { watchedEmails: this.opts.watchedEmails } : {}),
    });
    if (!reportHasAlerts(report)) return 0;
    const all = [...report.accounts.flatMap((a) => [...a.panics, ...a.alerts, ...a.info])];
    const links = await alertLinks(this.opts.db, [...all, ...report.other]);
    const html = formatAlertsHtml(report, links, {
      title,
      ...(this.opts.timeZone ? { timeZone: this.opts.timeZone } : {}),
    });
    await this.broadcast(html);
    await markAlertsSent(this.opts.db, ids, this.now());
    return ids.length;
  }

  /** Unsent panics, right away (also during quiet hours). */
  sendPanics(): Promise<number> {
    return this.sendAlerts(["panic"], "🚨 <b>Urgent</b>");
  }

  /** Every unsent alert (any level) as one digest. */
  sendDigest(title = "📋 <b>Digest</b>"): Promise<number> {
    return this.sendAlerts(null, title);
  }

  /** Scheduled digest: once a local day, from `digestTime` on, outside quiet hours. */
  digestDue(at: Date = this.now()): boolean {
    if (this.opts.quietHours && inQuietHours(this.opts.quietHours, at)) return false;
    if (at.getHours() * 60 + at.getMinutes() < this.digestMin) return false;
    return this.state.lastDigestDay !== localDay(at);
  }

  /** Sends the daily digest when due; failures are logged and retried after 5 minutes. */
  async maybeSendDigest(): Promise<number> {
    const now = this.now();
    if (!this.digestDue(now) || now.getTime() < this.digestRetryAt) return 0;
    try {
      const sent = await this.sendDigest("📋 <b>Daily digest</b>");
      this.state.lastDigestDay = localDay(now);
      this.saveState();
      return sent;
    } catch (err) {
      this.digestRetryAt = now.getTime() + 5 * 60_000;
      this.log(`telegram: digest failed: ${this.describe(err)}`);
      return 0;
    }
  }

  /** After a `run` cycle: panics at once, then the digest if it's due. Never throws. */
  async afterCycle(): Promise<void> {
    try {
      const n = await this.sendPanics();
      if (n) this.log(`telegram: sent ${n} panic(s)`);
    } catch (err) {
      this.log(`telegram: sending panics failed: ${this.describe(err)}`);
    }
    const n = await this.maybeSendDigest();
    if (n) this.log(`telegram: digest with ${n} alert(s) sent`);
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
    const tz = this.opts.timeZone;
    const counts = (alerts: readonly ReportAlert[]) => {
      const n = (l: AlertLevel) => alerts.filter((a) => a.level === l).length;
      const pending = alerts.filter((a) => a.sentAt === null).length;
      return `🔴 ${n("panic")} · 🟠 ${n("alert")} · ℹ️ ${n("info")} (unsent ${pending})`;
    };
    const out = [`📊 <b>Status</b> · ${escapeHtml(formatTime(now, tz))}`];
    if (report.accounts.length === 0) out.push("", "No watched accounts yet.");
    for (const a of report.accounts) {
      const run = lastRun.get(a.email);
      const at = run ? (run.finishedAt ?? run.startedAt) : undefined;
      const sync =
        run && at
          ? `${escapeHtml(run.status)} · ${escapeHtml(formatTime(at, tz))} (${formatAgo(now.getTime() - at.getTime())})`
          : "never";
      out.push(
        "",
        `👤 <b>${escapeHtml(a.label)}</b>`,
        `Last sync: ${sync}`,
        `Open: ${counts([...a.panics, ...a.alerts, ...a.info])}`,
      );
    }
    if (report.other.length) out.push("", `Other: ${counts(report.other)}`);
    out.push("", `Daily digest at ${escapeHtml(this.opts.digestTime)}. Open = not acked, 7 days.`);
    return out.join("\n");
  }

  private async reply(chatId: string, html: string): Promise<void> {
    for (const chunk of splitMessage(html)) await this.opts.api.sendMessage(chatId, chunk);
  }

  /** Handles one update: commands from allowed chats only; everything else is ignored. */
  async handleUpdate(update: TgUpdate): Promise<void> {
    const msg = update.message;
    if (!msg?.text) return;
    const chatId = String(msg.chat.id);
    if (!this.opts.chatIds.includes(chatId)) return;
    const cmd = parseCommand(msg.text);
    if (!cmd) return;
    switch (cmd.name) {
      case "status":
        await this.reply(chatId, await this.statusHtml());
        return;
      case "digest": {
        const n = await this.sendDigest();
        if (n === 0) await this.reply(chatId, "Nothing pending.");
        return;
      }
      case "ack": {
        const ids = cmd.args.map(Number).filter((n) => Number.isInteger(n) && n > 0);
        if (ids.length === 0) {
          await this.reply(chatId, "Usage: /ack &lt;id&gt; (the number after /ack_ in a message)");
          return;
        }
        const lines: string[] = [];
        for (const id of ids) {
          const alert = await muteAlert(this.opts.db, id, this.now());
          lines.push(alert ? `🔕 Muted #${id}` : `No alert #${id}`);
        }
        await this.reply(chatId, lines.join("\n"));
        return;
      }
      default:
        await this.reply(chatId, HELP_TEXT);
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
      const n = await this.maybeSendDigest();
      if (n) this.log(`telegram: digest with ${n} alert(s) sent`);
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
