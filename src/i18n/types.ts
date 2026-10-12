// The typed message catalog: every parent-facing string, per language (#49). No i18n library:
// one object per language implements `Messages`, so a missing string is a type error.

import type { RedoDue, UnreadableCause } from "../store/types.ts";

export const LANGS = ["uk", "ru", "en"] as const;
export type Lang = (typeof LANGS)[number];

/** Plural forms as `Intl.PluralRules` names them (`few`/`many` only matter for uk/ru). */
export interface PluralForms {
  one: string;
  few?: string;
  many?: string;
  other: string;
}

export type Debt = "redo" | "missing" | "unchecked";
export type VerdictMark = "ok" | "warn" | "panic" | "unchecked" | "pending";

export interface Messages {
  /** BCP 47 locale for `Intl` (dates, plural rules). */
  locale: string;
  /** Wraps a title in quotes: «…» or "…". */
  quote(text: string): string;

  time: {
    /** `in 45m` from minutes / hours / days (the unit is picked by the caller). */
    inMinutes(n: number): string;
    inHours(n: number): string;
    inDays(n: number): string;
    minutesAgo(n: number): string;
    hoursAgo(n: number): string;
    daysAgo(n: number): string;
    /** Age of a debt: `today` for 0, else `N day(s)`. */
    today: string;
    days: PluralForms;
  };

  alert: {
    missing(item: string): string;
    dueSoon(item: string, due: string, rel: string): string;
    untouched(item: string): string;
    noDueDate(item: string): string;
    teacherComment(item: string, text: string): string;
    redoDue: Record<RedoDue, string>;
    /** Head of a quality alert: `Check now` (panic) / `Take a look` (warn). */
    checkNow: string;
    takeALook: string;
    missingParts(list: string): string;
    templateUnchanged: string;
    heuristicBasis: Record<"unreadable" | "fallback", string>;
    /** Heuristic signal codes, as a reason. */
    signal: Record<string, string>;
    notChecked(list: string): string;
    checkByHand(item: string, list: string): string;
    llmFailed(item: string, failures: number, provider: string, error: string): string;
    session(account: string, state: "expired" | "missing"): string;
    drift(account: string, rpcid: string, error: string): string;
    empty: string;
  };

  unreadable(cause: UnreadableCause): string;

  report: {
    title: string;
    newAlerts: string;
    since(time: string): string;
    everything: string;
    noAccounts: string;
    panics: string;
    alerts: string;
    turnedIn: string;
    upcoming: string;
    checkByHand: string;
    debts: string;
    info: string;
    other: string;
    nothing: string;
    heuristicsOnly: string;
    partsNotChecked(n: number): string;
    verdict: Record<VerdictMark, string>;
    debt: Record<Debt, string>;
  };

  telegram: {
    urgent: string;
    digest: string;
    dailyDigest: string;
    status: string;
    open: string;
    checkByHand: string;
    debts: string;
    other: string;
    noAccounts: string;
    lastSync(text: string): string;
    never: string;
    syncStatus: Record<string, string>;
    openCounts(panic: number, alert: number, info: number, unsent: number): string;
    debtCount(n: number): string;
    statusFooter(digestTime: string, forgetDays: number): string;
    nothingPending: string;
    acked(id: number): string;
    noAlert(id: number): string;
    ackUsage: string;
    help: string;
    test: string;
  };
}
