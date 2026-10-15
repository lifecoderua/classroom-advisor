// The navigable Telegram digest (#66): one message the parent moves through with inline buttons
// (summary → a kid's list → an assignment's card), plus standalone cards for urgent items. Each
// tap re-renders its view from the DB, so the model is built here from a `Report` and the views
// are pure functions of it. Alerts and debts are grouped per assignment: one list line, and the
// card shows every problem of that assignment.

import { ackKeepsDebt, debtAgeDays } from "../checks/backlog.ts";
import { formatAge, formatIn, formatTime, type Locale, messages } from "../i18n/index.ts";
import type { ProblemTag } from "../i18n/types.ts";
import type { Db } from "../store/index.ts";
import type { AlertContent, AlertLevel } from "../store/types.ts";
import {
  alertText,
  parseAlertKey,
  type Report,
  type ReportAlert,
  type UpcomingItem,
} from "./console.ts";

/** List lines per page. */
export const PAGE_SIZE = 5;
/** Telegram's limit is 4096 characters per message. */
const VIEW_LIMIT = 4000;
const QUOTE_CAP = 900;

/** 0 = urgent (🔴), 1 = attention (🟠), 2 = low-noise (🔵). */
export type Rank = 0 | 1 | 2;
const RANK_ICON = ["🔴", "🟠", "🔵"] as const;
const LEVEL_RANK: Record<AlertLevel, Rank> = { panic: 0, alert: 1, info: 2 };

export interface Problem {
  rank: Rank;
  tag: ProblemTag;
  /** Short inline detail, already HTML (a due time, a debt's age). */
  detail?: string;
  /** Longer text shown as a collapsible quote, plain (a teacher comment, review notes). */
  quote?: string;
  /** The alert behind it; null for a debt without one (can't be marked seen). */
  alertId: number | null;
  /** Marking it seen keeps the debt until the work is turned in (#63). */
  keepsDebt: boolean;
  acked: boolean;
  /** New in this message: not sent to Telegram before it. */
  fresh: boolean;
}

/** One assignment (or one alert that isn't about an assignment) with its problems. */
export interface Group {
  /** `a<assignmentId>` or `x<alertId>`: stable across re-renders, used in callback data. */
  ref: string;
  assignmentId: number | null;
  title: string;
  course: string;
  dueAt: Date | null;
  postedAt: Date | null;
  url?: string;
  /** Has turned-in work: a recheck makes sense. */
  recheck: boolean;
  problems: Problem[];
}

/** A sync alert (lost login, parser drift): a line at the top of the kid's views, not an item. */
export interface Banner {
  alertId: number;
  /** Plain text. */
  text: string;
  fresh: boolean;
}

export interface KidView {
  /** Account id; 0 for the kid-less "other" items. */
  id: number;
  label: string;
  /** Open sync alerts; muted ones are left out. */
  banners: Banner[];
  groups: Group[];
  upcoming: UpcomingItem[];
}

export interface DigestModel {
  generatedAt: Date;
  kids: KidView[];
  upcomingDays: number;
  autoClosed: number;
}

/** What a view needs to know about the assignments its alerts and debts point at. */
export interface AssignmentInfo {
  title: string;
  course: string;
  dueAt: Date | null;
  postedAt: Date | null;
  url: string;
  /** Has turned-in (or returned) work. */
  turnedIn: boolean;
}

export interface ModelInput {
  report: Report;
  /** Alert id → its assignment id (alerts about an assignment only). */
  alertAssignments: ReadonlyMap<number, number>;
  assignments: ReadonlyMap<number, AssignmentInfo>;
  /** Alerts that are new in the message (default: the ones not sent yet). */
  fresh?: ReadonlySet<number>;
  loc: Locale;
}

export const isDone = (g: Group): boolean => g.problems.every((p) => p.acked);
/** Has a problem that is new in this message and not marked seen. */
export const isNew = (g: Group): boolean => g.problems.some((p) => p.fresh && !p.acked);
const NEW = "🆕";
const groupRank = (g: Group): Rank => Math.min(...g.problems.map((p) => p.rank)) as Rank;
const flat = (s: string) => s.replace(/\s+/g, " ").trim();
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function problemOf(a: ReportAlert, fresh: boolean, now: Date, loc: Locale): Problem {
  const base = {
    rank: LEVEL_RANK[a.level],
    alertId: a.id,
    keepsDebt: ackKeepsDebt(a.key),
    acked: Boolean(a.mutedAt),
    fresh,
  };
  const c: AlertContent = a.content;
  switch (c.code) {
    case "deadline.due_soon": {
      const due = new Date(c.params.dueAt);
      if (due <= now) return { ...base, tag: "overdue", detail: escapeHtml(formatTime(due, loc)) };
      const rel = formatIn(due.getTime() - now.getTime(), loc.lang);
      return { ...base, tag: "dueSoon", detail: escapeHtml(`${formatTime(due, loc)} (${rel})`) };
    }
    case "deadline.missing":
      return { ...base, tag: "missing" };
    case "deadline.untouched_24h":
      return { ...base, tag: "untouched" };
    case "deadline.no_due_date":
      return { ...base, tag: "noDueDate" };
    case "comment.teacher":
      return {
        ...base,
        tag: c.params.redoDue || a.level === "panic" ? "redo" : "comment",
        quote: c.params.text,
      };
    case "quality.review": {
      const p = c.params;
      const notes = [p.summary ?? "", ...(p.missing ?? []).map((x) => `– ${x}`)].filter(Boolean);
      return {
        ...base,
        tag: p.template || p.verdict === "panic" ? "redo" : "incomplete",
        quote: notes.length ? notes.join("\n") : alertText(a, loc),
      };
    }
    case "quality.unchecked":
      return {
        ...base,
        tag: "checkByHand",
        quote: c.params.items.map((x) => `– ${x.what}: ${x.why}`).join("\n"),
      };
    case "quality.llm_failed":
      return { ...base, tag: "notChecked" };
    case "sync.session":
    case "sync.drift":
      return { ...base, tag: "sync", quote: alertText(a, loc) };
    default:
      return { ...base, tag: legacyTag(a), quote: alertText(a, loc) };
  }
}

/**
 * The tag of a free-text alert (`code: "text"`, e.g. one from before #49), from its key:
 * `deadline:<id>:<code>[:…]`, `quality:<id>[:c<n>|:r<n>][:unchecked|:llm-failed]`, `comment:<id>`.
 */
export function legacyTag(a: Pick<ReportAlert, "key" | "level">): ProblemTag {
  const [kind, , ...rest] = a.key.split(":");
  const last = rest.at(-1);
  switch (kind) {
    case "deadline": {
      const code = rest[0];
      if (code === "missing") return "missing";
      if (code === "due_soon") return "dueSoon";
      if (code === "untouched_24h") return "untouched";
      if (code === "no_due_date") return "noDueDate";
      return "other";
    }
    case "quality":
      if (last === "unchecked") return "checkByHand";
      if (last === "llm-failed") return "notChecked";
      return a.level === "panic" ? "redo" : "incomplete";
    case "comment":
      return a.level === "panic" ? "redo" : "comment";
    case "sync":
      return "sync";
    default:
      return "other";
  }
}

const isSyncAlert = (a: ReportAlert) =>
  a.content.code.startsWith("sync.") || parseAlertKey(a.key)?.kind === "sync";

const DEBT_TAG = { redo: "redo", missing: "missing", unchecked: "checkByHand" } as const;
const DEBT_RANK = { redo: 0, missing: 1, unchecked: 2 } as const;

/**
 * Groups a report's alerts and debts per assignment. Within a kid: open groups first (most
 * urgent, then newest), the ones marked seen at the end.
 */
export function buildModel(input: ModelInput): DigestModel {
  const { report, loc } = input;
  const now = report.generatedAt;
  const kid = (id: number, label: string, upcoming: UpcomingItem[], all: ReportAlert[]) => {
    const groups = new Map<string, Group>();
    const fresh = (a: ReportAlert) => (input.fresh ? input.fresh.has(a.id) : a.sentAt === null);
    const banners = all
      .filter((a) => isSyncAlert(a) && !a.mutedAt)
      .map((a) => ({ alertId: a.id, text: flat(alertText(a, loc)), fresh: fresh(a) }));
    const alerts = all.filter((a) => !isSyncAlert(a));
    const group = (assignmentId: number | undefined, fallback: () => string, alertId: number) => {
      const ref = assignmentId !== undefined ? `a${assignmentId}` : `x${alertId}`;
      let g = groups.get(ref);
      if (!g) {
        const a = assignmentId !== undefined ? input.assignments.get(assignmentId) : undefined;
        g = {
          ref,
          assignmentId: assignmentId ?? null,
          title: a?.title ?? fallback(),
          course: a?.course ?? "",
          dueAt: a?.dueAt ?? null,
          postedAt: a?.postedAt ?? null,
          ...(a ? { url: a.url } : {}),
          recheck: a?.turnedIn ?? false,
          problems: [],
        };
        groups.set(ref, g);
      }
      return g;
    };
    for (const a of alerts) {
      const fallback = () => flat(alertText(a, loc));
      group(input.alertAssignments.get(a.id), fallback, a.id).problems.push(
        problemOf(a, fresh(a), now, loc),
      );
    }
    const account = report.accounts.find((x) => x.id === id);
    for (const d of account?.backlog ?? []) {
      group(d.assignmentId, () => d.title, 0).problems.push({
        rank: DEBT_RANK[d.kind],
        tag: DEBT_TAG[d.kind],
        detail: escapeHtml(formatAge(debtAgeDays(d, now), loc.lang)),
        alertId: d.alertId,
        keepsDebt: d.kind !== "unchecked",
        acked: d.muted,
        fresh: false,
      });
    }
    const list = [...groups.values()];
    for (const g of list) {
      g.problems.sort((a, b) => a.rank - b.rank);
      // A missing alert stands in for its debt (the report leaves the debt out): show its age too.
      for (const p of g.problems) {
        if (p.tag === "missing" && !p.detail && g.dueAt) {
          const days = Math.floor((now.getTime() - g.dueAt.getTime()) / 86_400_000);
          p.detail = escapeHtml(formatAge(days, loc.lang));
        }
      }
    }
    const when = (g: Group) => (g.dueAt ?? g.postedAt ?? now).getTime();
    list.sort(
      (a, b) =>
        Number(isDone(a)) - Number(isDone(b)) ||
        groupRank(a) - groupRank(b) ||
        when(b) - when(a) ||
        a.ref.localeCompare(b.ref),
    );
    return { id, label, banners, groups: list, upcoming };
  };
  const kids = report.accounts.map((a) =>
    kid(a.id, a.label, a.upcoming, [...a.panics, ...a.alerts, ...a.checkByHand, ...a.info]),
  );
  if (report.other.length) {
    kids.push(kid(0, messages(loc.lang).telegram.view.otherKid, [], report.other));
  }
  return {
    generatedAt: now,
    kids: kids.filter((k) => k.banners.length || k.groups.length || k.upcoming.length),
    upcomingDays: report.upcomingDays,
    autoClosed: report.autoClosed,
  };
}

/**
 * What the model needs from the DB beyond the report: each alert's assignment and the
 * assignments' titles, dates, links and whether work is turned in.
 */
export async function loadModelInput(
  db: Db,
  report: Report,
  alertAssignments: ReadonlyMap<number, number>,
  urls: ReadonlyMap<number, string>,
  loc: Locale,
): Promise<ModelInput> {
  const ids = new Set(alertAssignments.values());
  for (const a of report.accounts) for (const d of a.backlog) ids.add(d.assignmentId);
  const rows = await db.assignment.findMany({
    where: { id: { in: [...ids] } },
    select: {
      id: true,
      title: true,
      dueAt: true,
      postedAt: true,
      course: { select: { name: true } },
      submission: { select: { state: true } },
    },
  });
  const debtUrls = new Map(
    report.accounts.flatMap((a) => a.backlog.map((d) => [d.assignmentId, d.url])),
  );
  const assignments = new Map<number, AssignmentInfo>();
  for (const r of rows) {
    assignments.set(r.id, {
      title: r.title,
      course: r.course.name,
      dueAt: r.dueAt,
      postedAt: r.postedAt,
      url: urls.get(r.id) ?? debtUrls.get(r.id) ?? "",
      turnedIn: ["turned_in", "returned"].includes(r.submission?.state ?? ""),
    });
  }
  return { report, alertAssignments, assignments, loc };
}

// ---------------------------------------------------------------------------------------------
// Callback data (≤ 64 bytes): what a button asks for.

export type Action =
  /** The summary. */
  | { kind: "home" }
  /** A kid's list page. */
  | { kind: "list"; kid: number; page: number }
  /** A card opened from a list (back returns to that page). */
  | { kind: "card"; kid: number; page: number; ref: string }
  /** Mark a group seen from its card, then back to the list page. */
  | { kind: "seen"; kid: number; page: number; ref: string }
  /** Mark a standalone card's group seen (edited in place). */
  | { kind: "seenCard"; ref: string }
  | { kind: "recheck"; assignmentId: number }
  | { kind: "upcoming" }
  | { kind: "refresh" }
  /** A label button (page counter). */
  | { kind: "noop" };

const REF = /^[ax]\d+$/;

export function encodeAction(a: Action): string {
  switch (a.kind) {
    case "home":
      return "h";
    case "list":
      return `l:${a.kid}:${a.page}`;
    case "card":
      return `c:${a.kid}:${a.page}:${a.ref}`;
    case "seen":
      return `s:${a.kid}:${a.page}:${a.ref}`;
    case "seenCard":
      return `S:${a.ref}`;
    case "recheck":
      return `r:${a.assignmentId}`;
    case "upcoming":
      return "u";
    case "refresh":
      return "f";
    case "noop":
      return "n";
  }
}

export function decodeAction(data: string): Action | null {
  const [k, ...rest] = data.split(":");
  const num = (s: string | undefined) => (s !== undefined && /^\d+$/.test(s) ? Number(s) : NaN);
  const [x, y, ref] = rest;
  switch (k) {
    case "h":
      return { kind: "home" };
    case "u":
      return { kind: "upcoming" };
    case "f":
      return { kind: "refresh" };
    case "n":
      return { kind: "noop" };
    case "l":
      return Number.isInteger(num(x)) && Number.isInteger(num(y))
        ? { kind: "list", kid: num(x), page: num(y) }
        : null;
    case "c":
    case "s":
      if (!Number.isInteger(num(x)) || !Number.isInteger(num(y)) || !ref || !REF.test(ref)) {
        return null;
      }
      return { kind: k === "c" ? "card" : "seen", kid: num(x), page: num(y), ref };
    case "S":
      return x && REF.test(x) ? { kind: "seenCard", ref: x } : null;
    case "r":
      return Number.isInteger(num(x)) ? { kind: "recheck", assignmentId: num(x) } : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Views

export interface Button {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface View {
  html: string;
  keyboard: Button[][];
}

const btn = (text: string, action: Action): Button => ({
  text,
  callback_data: encodeAction(action),
});

const dayMonth = (d: Date, loc: Locale) =>
  new Intl.DateTimeFormat(messages(loc.lang).locale, {
    day: "2-digit",
    month: "2-digit",
    ...(loc.timeZone ? { timeZone: loc.timeZone } : {}),
  }).format(d);

const DATE = String.raw`\d{1,2}\.\d{1,2}(?:\.\d{2,4})?`;
const LEADING_DATE = new RegExp(String.raw`^${DATE}(?:\s*[-–—]\s*${DATE})?\.?[\s\-–—:,.]*`);
const TRAILING_DATE = new RegExp(String.raw`[\s\-–—:,]+${DATE}\.?$`);
const MAX_TITLE = 42;

/**
 * "13.10 Геометрія. Тематична…" → "Геометрія. Тематична…": the list line shows a date anyway.
 * Separators the date leaves behind ("08.10.2026-географія") go too.
 */
export function shortTitle(title: string, max = MAX_TITLE): string {
  const full = flat(title);
  const t = full.replace(LEADING_DATE, "").replace(TRAILING_DATE, "").trim();
  return cut(t || full, max);
}

/**
 * `shortTitle` of each, except where two different titles would come out the same
 * ("English. 09.10.2026" and "English. 12.10.2026" → "English."): those keep their date.
 */
export function shortTitles(titles: readonly string[], max = MAX_TITLE): string[] {
  const short = titles.map((t) => shortTitle(t, max));
  const fulls = new Map<string, Set<string>>();
  for (const [i, s] of short.entries()) {
    fulls.set(s, (fulls.get(s) ?? new Set()).add(flat(titles[i] ?? "")));
  }
  return short.map((s, i) => ((fulls.get(s)?.size ?? 0) > 1 ? cut(flat(titles[i] ?? ""), max) : s));
}

const icon = (g: Group) => (isDone(g) ? "✅" : RANK_ICON[groupRank(g)]);

function tags(g: Group, loc: Locale): string {
  const t = messages(loc.lang).telegram.view.tag;
  return [...new Set(g.problems.map((p) => t[p.tag]))].join(", ");
}

export function openGroups(k: KidView): number {
  return k.groups.filter((g) => !isDone(g)).length;
}

/** Level 1: counts per kid, a button per kid. */
export function summaryView(model: DigestModel, title: string, loc: Locale): View {
  const t = messages(loc.lang);
  const v = t.telegram.view;
  const lines = [`${title} · ${escapeHtml(formatTime(model.generatedAt, loc))}`];
  for (const k of model.kids) {
    const open = k.groups.filter((g) => !isDone(g));
    const urgent = open.filter((g) => groupRank(g) === 0).length;
    const fresh = open.filter(isNew).length;
    const parts = [
      ...(urgent ? [`🔴 ${urgent}`] : []),
      ...(fresh ? [`${NEW} ${fresh}`] : []),
      v.open(open.length),
      ...(k.groups.length > open.length ? [`✅ ${k.groups.length - open.length}`] : []),
      ...(k.upcoming.length ? [v.upcoming(k.upcoming.length)] : []),
    ];
    lines.push(`👤 <b>${escapeHtml(k.label)}</b> — ${parts.join(" · ")}`);
    lines.push(...k.banners.map(bannerLine));
  }
  if (model.autoClosed) lines.push("", t.report.autoClosed(model.autoClosed));
  if (!model.kids.some((k) => k.groups.length || k.banners.length)) {
    lines.push("", t.telegram.nothingPending);
  }
  const kids = model.kids
    .filter((k) => k.groups.length)
    .map((k) => btn(`👤 ${k.label} (${openGroups(k)})`, { kind: "list", kid: k.id, page: 0 }));
  const keyboard: Button[][] = [];
  for (let i = 0; i < kids.length; i += 2) keyboard.push(kids.slice(i, i + 2));
  const upcoming = model.kids.reduce((n, k) => n + k.upcoming.length, 0);
  keyboard.push([
    ...(upcoming ? [btn(v.button.upcoming(upcoming), { kind: "upcoming" })] : []),
    btn(v.button.refresh, { kind: "refresh" }),
  ]);
  return { html: lines.join("\n"), keyboard };
}

function bannerLine(b: Banner): string {
  return `⚠️${b.fresh ? NEW : ""} <i>${escapeHtml(cut(b.text, 300))}</i>`;
}

function listLine(g: Group, short: string, n: number, loc: Locale): string {
  const v = messages(loc.lang).telegram.view;
  const name = escapeHtml(short);
  const when = g.dueAt
    ? v.dueShort(dayMonth(g.dueAt, loc))
    : g.postedAt
      ? v.postedShort(dayMonth(g.postedAt, loc))
      : "";
  const meta = `<i>${escapeHtml([when, tags(g, loc)].filter(Boolean).join(" · "))}</i>`;
  if (isDone(g)) return `${n}. ✅ <s>${name}</s>\n      ${meta}`;
  const title = g.url ? `<a href="${escapeHtml(g.url)}">${name}</a>` : name;
  return `${n}. ${icon(g)}${isNew(g) ? NEW : ""} ${title}\n      ${meta}`;
}

/** Level 2: a kid's assignments, one line each; the title links to Classroom, a number opens the card. */
export function listView(model: DigestModel, kidId: number, page: number, loc: Locale): View {
  const k = model.kids.find((x) => x.id === kidId);
  if (!k) return summaryView(model, messages(loc.lang).telegram.digest, loc);
  const v = messages(loc.lang).telegram.view;
  const pages = Math.max(1, Math.ceil(k.groups.length / PAGE_SIZE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const slice = k.groups.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE);
  const lines = [`👤 <b>${escapeHtml(k.label)}</b> · ${v.page(p + 1, pages)}`];
  if (k.banners.length) lines.push(k.banners.map(bannerLine).join("\n"));
  // Over the whole list, so a title reads the same on every page.
  const names = shortTitles(k.groups.map((g) => g.title));
  for (const [i, g] of slice.entries()) {
    const n = p * PAGE_SIZE + i;
    lines.push(listLine(g, names[n] ?? g.title, n + 1, loc));
  }
  const keyboard: Button[][] = [
    slice.map((g, i) =>
      btn(`${isDone(g) ? "✅" : ""}${p * PAGE_SIZE + i + 1}`, {
        kind: "card",
        kid: k.id,
        page: p,
        ref: g.ref,
      }),
    ),
  ];
  if (pages > 1) {
    keyboard.push([
      btn(p > 0 ? "◀" : "·", p > 0 ? { kind: "list", kid: k.id, page: p - 1 } : { kind: "noop" }),
      btn(`${p + 1}/${pages}`, { kind: "noop" }),
      btn(
        p < pages - 1 ? "▶" : "·",
        p < pages - 1 ? { kind: "list", kid: k.id, page: p + 1 } : { kind: "noop" },
      ),
    ]);
  }
  keyboard.push([btn(v.button.back, { kind: "home" })]);
  return { html: lines.join("\n\n"), keyboard };
}

export function findGroup(model: DigestModel, ref: string): Group | undefined {
  for (const k of model.kids) {
    const g = k.groups.find((x) => x.ref === ref);
    if (g) return g;
  }
  return undefined;
}

function cardHtml(g: Group, header: string | undefined, loc: Locale, quoteCap: number): string {
  const t = messages(loc.lang).telegram;
  const v = t.view;
  const name = escapeHtml(flat(g.title));
  const lines = header ? [header] : [];
  lines.push(`${icon(g)} <b>${g.url ? `<a href="${escapeHtml(g.url)}">${name}</a>` : name}</b>`);
  const when = g.dueAt
    ? v.dueFull(formatTime(g.dueAt, loc))
    : g.postedAt
      ? v.postedFull(dayMonth(g.postedAt, loc))
      : "";
  const meta = [g.course, when].filter(Boolean).join(" · ");
  if (meta) lines.push(`<i>${escapeHtml(meta)}</i>`);
  for (const p of g.problems) {
    const mark = p.acked ? "✅" : RANK_ICON[p.rank];
    const fresh = p.fresh && !p.acked ? ` ${NEW}` : "";
    lines.push(
      "",
      `${mark} <b>${escapeHtml(v.tag[p.tag])}</b>${fresh}${p.detail ? ` — ${p.detail}` : ""}`,
    );
    if (p.quote) {
      lines.push(
        `<blockquote expandable>${escapeHtml(cut(p.quote.trim(), quoteCap))}</blockquote>`,
      );
    }
  }
  if (isDone(g)) lines.push("", `<i>${v.seen}</i>`);
  return lines.join("\n");
}

/**
 * Level 3: every problem of one assignment. `from` = the list page it was opened from (back and
 * "seen" return there); without it the card is a standalone message, edited in place.
 */
export function cardView(
  g: Group,
  loc: Locale,
  from?: { kid: number; page: number },
  header?: string,
): View {
  const v = messages(loc.lang).telegram.view;
  let html = cardHtml(g, header, loc, QUOTE_CAP);
  if (html.length > VIEW_LIMIT) html = cardHtml(g, header, loc, 200);
  if (html.length > VIEW_LIMIT) html = `${html.slice(0, VIEW_LIMIT - 1)}…`.replace(/<[^>]*$/, "");
  const row: Button[] = [];
  if (g.url) row.push({ text: v.button.classroom, url: g.url });
  if (g.problems.some((p) => p.alertId !== null && !p.acked)) {
    row.push(
      btn(
        v.button.seen,
        from ? { kind: "seen", ...from, ref: g.ref } : { kind: "seenCard", ref: g.ref },
      ),
    );
  }
  if (g.recheck && g.assignmentId !== null) {
    row.push(btn(v.button.recheck, { kind: "recheck", assignmentId: g.assignmentId }));
  }
  const keyboard = row.length ? [row] : [];
  if (from) keyboard.push([btn(v.button.back, { kind: "list", ...from })]);
  return { html, keyboard };
}

/** Work due later (beyond a day, within the horizon), per kid, collapsed. */
export function upcomingView(model: DigestModel, loc: Locale): View {
  const v = messages(loc.lang).telegram.view;
  const lines = [v.upcomingTitle(model.upcomingDays)];
  for (const k of model.kids) {
    if (!k.upcoming.length) continue;
    const names = shortTitles(k.upcoming.map((u) => u.title));
    const rows = k.upcoming.map((u, i) => {
      const rel = formatIn(u.dueAt.getTime() - model.generatedAt.getTime(), loc.lang);
      const when = escapeHtml(`${v.dueFull(formatTime(u.dueAt, loc))} (${rel})`);
      return `<a href="${escapeHtml(u.url)}">${escapeHtml(names[i] ?? u.title)}</a>\n<i>${when}</i>`;
    });
    lines.push(
      "",
      `👤 <b>${escapeHtml(k.label)}</b>`,
      `<blockquote expandable>${rows.join("\n")}</blockquote>`,
    );
  }
  return { html: lines.join("\n"), keyboard: [[btn(v.button.back, { kind: "home" })]] };
}
