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
/** Short problem label in the Telegram list and card (#66). */
export type ProblemTag =
  | "dueSoon"
  | "overdue"
  | "missing"
  | "untouched"
  | "noDueDate"
  | "comment"
  | "redo"
  | "incomplete"
  | "checkByHand"
  | "notChecked"
  | "sync"
  | "other";

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
    /** The green "upcoming" block header (#53). */
    upcoming(days: number): string;
    checkByHand: string;
    debts: string;
    info: string;
    other: string;
    nothing: string;
    heuristicsOnly: string;
    partsNotChecked(n: number): string;
    /** `✔️ Closed automatically: N` (#51). */
    autoClosed(n: number): string;
    /** Marker after a muted alert in `report --all`, by mute reason. */
    muted: Record<"manual" | "auto" | "superseded" | "no_work_expected", string>;
    verdict: Record<VerdictMark, string>;
    debt: Record<Debt, string>;
  };

  telegram: {
    urgent: string;
    digest: string;
    dailyDigest: string;
    status: string;
    other: string;
    noAccounts: string;
    lastSync(text: string): string;
    never: string;
    syncStatus: Record<string, string>;
    openCounts(panic: number, alert: number, info: number, unsent: number): string;
    debtCount(n: number): string;
    upcomingCount(n: number): string;
    statusFooter(digestTime: string, forgetDays: number): string;
    nothingPending: string;
    help: string;
    test: string;
    /** Bot menu (`setMyCommands`): command → short description. */
    commands: Record<"status" | "digest" | "refresh" | "recheck" | "login" | "help", string>;
    refreshing: string;
    alreadyRunning: string;
    cooldown(leftMin: number, everyMin: number): string;
    freshDigest: string;
    recheckQueued(item: string): string;
    recheckUsage: string;
    recheckNotTurnedIn(item: string): string;
    recheckDone(item: string, verdict: string): string;
    recheckFailed(item: string): string;
    /** Hand login from the chat (#79). HTML unless noted; `labels` are escaped kid labels. */
    login: {
      /** Buttons (plain). */
      button: string;
      retry: string;
      computer: string;
      phone: string;
      openPage: string;
      done: string;
      /** Pushed after a sync found a lost login. */
      lost(labels: string): string;
      ask: string;
      waiting: string;
      openVnc(until: string): string;
      openLocal(until: string): string;
      missingNow(labels: string): string;
      steps: string;
      checking: string;
      allBack(n: number): string;
      stillMissing(labels: string): string;
      timeout: string;
      stopped: string;
      failed(error: string): string;
      /** No loop that could open a login (e.g. `run --once`). */
      unavailable: string;
      /** Popups after a tap (plain). */
      toast: { opening: string; checking: string; notOpen: string };
    };
    /** The navigable digest and cards (#66). */
    view: {
      tag: Record<ProblemTag, string>;
      /** List line date: `due 13.10` / `from 08.10`. */
      dueShort(date: string): string;
      postedShort(date: string): string;
      /** Card meta: `due Tue 13 Oct, 23:59` / `posted 08.10`. */
      dueFull(time: string): string;
      postedFull(date: string): string;
      /** Summary counts per kid. */
      open(n: number): string;
      upcoming(n: number): string;
      /** Label of the kid-less items ("other"), plain text. */
      otherKid: string;
      page(page: number, pages: number): string;
      /** Footer of a card whose problems are all marked seen. */
      seen: string;
      /** Header of a pushed teacher comment card. */
      newComment: string;
      upcomingTitle(days: number): string;
      button: {
        classroom: string;
        seen: string;
        recheck: string;
        back: string;
        refresh: string;
        upcoming(n: number): string;
      };
      /** Short popups after a tap (plain text, ≤ 200 chars). */
      toast: {
        seen: string;
        seenKeepsDebt: string;
        stale: string;
        refreshing: string;
        alreadyRunning: string;
        cooldown(leftMin: number): string;
        recheckQueued: string;
        notTurnedIn: string;
      };
    };
  };
}
