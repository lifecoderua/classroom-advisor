// Parent-facing text in the configured language (`digestLang`) and time zone (`timeZone`), #49.

import type { AlertContent, UncheckedItem } from "../store/types.ts";
import { en } from "./en.ts";
import { plural } from "./plural.ts";
import { ru } from "./ru.ts";
import type { Lang, Messages } from "./types.ts";
import { uk } from "./uk.ts";

export { plural } from "./plural.ts";
export type { Lang, Messages } from "./types.ts";
export { LANGS } from "./types.ts";

const CATALOG: Record<Lang, Messages> = { uk, ru, en };

export function messages(lang: Lang): Messages {
  return CATALOG[lang];
}

/** Language + IANA time zone for rendering. No zone = the process's local zone. */
export interface Locale {
  lang: Lang;
  timeZone?: string | undefined;
}

export const DEFAULT_LANG: Lang = "uk";
export const DEFAULT_TIME_ZONE = "Europe/Kyiv";

export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** `Sat 10 Oct, 12:00` / `сб, 10 жовт., 12:00` in the locale's zone. */
export function formatTime(d: Date, loc: Locale): string {
  return new Intl.DateTimeFormat(messages(loc.lang).locale, {
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    ...(loc.timeZone ? { timeZone: loc.timeZone } : {}),
  }).format(d);
}

const units = (ms: number) => {
  const min = Math.max(0, Math.round(ms / 60_000));
  const h = Math.round(min / 60);
  return { min, h, d: Math.round(h / 24) };
};

/** `in 45m` / `через 5 год` / `через 3 дн.`. */
export function formatIn(ms: number, lang: Lang): string {
  const t = messages(lang).time;
  const { min, h, d } = units(ms);
  if (min < 60) return t.inMinutes(min);
  return h < 48 ? t.inHours(h) : t.inDays(d);
}

/** `5m ago` / `5 хв тому`. */
export function formatAgo(ms: number, lang: Lang): string {
  const t = messages(lang).time;
  const { min, h, d } = units(ms);
  if (min < 60) return t.minutesAgo(min);
  return h < 48 ? t.hoursAgo(h) : t.daysAgo(d);
}

/** `today` / `1 day` / `3 дні` / `5 днів`. */
export function formatAge(days: number, lang: Lang): string {
  const m = messages(lang);
  if (days <= 0) return m.time.today;
  return `${days} ${plural(m.locale, days, m.time.days)}`;
}

/** `"Title" (Course)` / `«Title» (Course)`. */
export function itemLabel(title: string, course: string, lang: Lang): string {
  const q = messages(lang).quote(title);
  return course ? `${q} (${course})` : q;
}

/** Hour and minute (as minutes after midnight) and the `YYYY-MM-DD` day of `at` in `timeZone`. */
export function zonedClock(at: Date, timeZone?: string): { minutes: number; day: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    ...(timeZone ? { timeZone } : {}),
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return {
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
    day: `${get("year")}-${get("month")}-${get("day")}`,
  };
}

/** Max characters of a teacher comment quoted in an alert. */
export const COMMENT_ALERT_CHARS = 600;

function uncheckedList(items: readonly UncheckedItem[], m: Messages): string {
  return items.map((i) => `${i.what}: ${i.cause ? m.unreadable(i.cause) : i.why}`).join("; ");
}

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** The alert's text in the locale's language (times in its zone). */
export function renderAlert(content: AlertContent, createdAt: Date, loc: Locale): string {
  const m = messages(loc.lang);
  const a = m.alert;
  const p = content.params as Record<string, unknown>;
  const item =
    typeof p.title === "string" ? itemLabel(p.title, String(p.course ?? ""), loc.lang) : "";
  switch (content.code) {
    case "text":
      return content.params.text;
    case "deadline.missing":
      return a.missing(item);
    case "deadline.due_soon": {
      const due = new Date(content.params.dueAt);
      return a.dueSoon(
        item,
        formatTime(due, loc),
        formatIn(due.getTime() - createdAt.getTime(), loc.lang),
      );
    }
    case "deadline.untouched_24h":
      return a.untouched(item);
    case "deadline.no_due_date":
      return a.noDueDate(item);
    case "comment.teacher": {
      const body = clip(content.params.text.trim().replace(/\s+/g, " "), COMMENT_ALERT_CHARS);
      const note = content.params.redoDue ? ` ${a.redoDue[content.params.redoDue]}` : "";
      return `${a.teacherComment(item, body || a.empty)}${note}`;
    }
    case "quality.review": {
      const q = content.params;
      const head = `${q.verdict === "panic" ? a.checkNow : a.takeALook}: ${item}: `;
      let body: string;
      if (q.heuristic) {
        const why = q.template
          ? a.templateUnchanged
          : q.heuristic.signals.map((s) => a.signal[s] ?? s).join("; ");
        body = `${why} [${a.heuristicBasis[q.heuristic.basis]}]`;
      } else {
        const missing = q.missing?.length ? ` ${a.missingParts(q.missing.join("; "))}` : "";
        const forced = q.template ? ` (${a.templateUnchanged})` : "";
        body = `${(q.summary ?? "").trim()}${missing}${forced}`;
      }
      const extra = [
        ...(q.unchecked?.length ? [a.notChecked(uncheckedList(q.unchecked, m))] : []),
        ...(q.redoDue ? [a.redoDue[q.redoDue]] : []),
      ];
      return [head + body, ...extra].join(" ");
    }
    case "quality.unchecked":
      return a.checkByHand(item, uncheckedList(content.params.items, m));
    case "quality.llm_failed": {
      const f = content.params;
      return a.llmFailed(item, f.failures, f.provider, f.error);
    }
    case "sync.session":
      return a.session(content.params.account, content.params.state);
    case "sync.drift":
      return a.drift(content.params.account, content.params.rpcid, content.params.error);
    default: {
      // An unknown code (e.g. from a newer version): show its params rather than nothing.
      const raw = content as { code: string; params: unknown };
      return `${raw.code} ${JSON.stringify(raw.params)}`;
    }
  }
}
