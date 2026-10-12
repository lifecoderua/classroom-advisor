import { type Debt, debtAgeDays, loadBacklog } from "../checks/backlog.ts";
import {
  DEFAULT_LANG,
  formatAge,
  formatIn,
  formatTime,
  itemLabel,
  type Lang,
  type Locale,
  messages,
  renderAlert,
} from "../i18n/index.ts";
import { alertContent, type Db, isUncheckedAlertKey } from "../store/index.ts";
import type { AlertContent, AlertLevel, Verdict } from "../store/types.ts";

// Console digest: per watched account, panics, alerts, recently turned-in work with its merged
// verdict, upcoming deadlines, "check by hand" items, open debts (#48) and info items. Read-only: `Alert.sentAt` belongs to the Telegram
// notifier, the console only displays.

const DONE = ["turned_in", "returned"];
const DAY_MS = 86_400_000;

export interface ReportAlert {
  id: number;
  key: string;
  level: AlertLevel;
  /** What it says; rendered per language with `alertText`. */
  content: AlertContent;
  createdAt: Date;
  sentAt: Date | null;
}

export interface TurnedInItem {
  title: string;
  courseName: string;
  turnedInAt: Date | null;
  /** Merged verdict: the latest LLM result, else the heuristics-only one, else `pending`. */
  verdict: Verdict | "pending";
  basis: "llm" | "heuristic" | "none";
  summary?: string;
  /** Parts not checked automatically (unreadable attachments, what the LLM couldn't verify). */
  unchecked?: number;
}

export interface UpcomingItem {
  title: string;
  courseName: string;
  dueAt: Date;
}

export interface AccountReport {
  id: number;
  email: string;
  label: string;
  panics: ReportAlert[];
  alerts: ReportAlert[];
  /** `quality:<id>:unchecked` info alerts: work not checked automatically, with the reason. */
  checkByHand: ReportAlert[];
  info: ReportAlert[];
  turnedIn: TurnedInItem[];
  upcoming: UpcomingItem[];
  /**
   * Open debts (#48), oldest first; empty unless `BuildReportOptions.backlog` is set. Debts whose
   * alert is listed in this report are left out (it's shown above already).
   */
  backlog: Debt[];
}

export interface Report {
  generatedAt: Date;
  /** Window start; `null` means everything (`--all`). */
  since: Date | null;
  /** Only the given alerts, without turned-in work or deadlines (the `run` digest). */
  alertsOnly: boolean;
  accounts: AccountReport[];
  /** Alerts whose key doesn't resolve to a reported account. */
  other: ReportAlert[];
}

export interface BuildReportOptions {
  now?: Date;
  /**
   * Window start: alerts created since then (plus any unsent; muted ones left out) and work
   * turned in since then.
   */
  since?: Date | null;
  /** Config watch list; accounts marked watched in the DB are always included. */
  watchedEmails?: readonly string[];
  /** Report exactly these alerts and nothing else. */
  alertIds?: readonly number[];
  upcomingDays?: number;
  /** Adds the open debts block, forgetting debts older than `forgetDays`. */
  backlog?: { forgetDays: number };
}

/** Display name, else the email's local part. */
export function accountLabel(a: { email: string; displayName: string | null }): string {
  return a.displayName?.trim() || a.email.split("@")[0] || a.email;
}

/**
 * `deadline:<assignmentId>:…` / `quality:<submissionVersionId>[:…]` / `sync:<accountId>:…` /
 * `comment:<commentId>` → the referenced id.
 */
export function parseAlertKey(
  key: string,
):
  | { kind: "deadline"; assignmentId: number }
  | { kind: "quality"; versionId: number }
  | { kind: "sync"; accountId: number }
  | { kind: "comment"; commentId: number }
  | null {
  const [kind, raw] = key.split(":");
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return null;
  if (kind === "deadline") return { kind, assignmentId: id };
  if (kind === "quality") return { kind, versionId: id };
  if (kind === "sync") return { kind, accountId: id };
  if (kind === "comment") return { kind, commentId: id };
  return null;
}

async function alertAccounts(db: Db, alerts: readonly ReportAlert[]): Promise<Map<number, number>> {
  const parsed = alerts.map((a) => [a.id, parseAlertKey(a.key)] as const);
  const assignmentIds = parsed.flatMap(([, p]) => (p?.kind === "deadline" ? [p.assignmentId] : []));
  const versionIds = parsed.flatMap(([, p]) => (p?.kind === "quality" ? [p.versionId] : []));
  const commentIds = parsed.flatMap(([, p]) => (p?.kind === "comment" ? [p.commentId] : []));
  const [assignments, versions, comments] = await Promise.all([
    db.assignment.findMany({
      where: { id: { in: assignmentIds } },
      select: { id: true, accountId: true },
    }),
    db.submissionVersion.findMany({
      where: { id: { in: versionIds } },
      select: { id: true, submission: { select: { assignment: { select: { accountId: true } } } } },
    }),
    db.comment.findMany({
      where: { id: { in: commentIds } },
      select: { id: true, assignment: { select: { accountId: true } } },
    }),
  ]);
  const byAssignment = new Map(assignments.map((a) => [a.id, a.accountId]));
  const byVersion = new Map(versions.map((v) => [v.id, v.submission.assignment.accountId]));
  const byComment = new Map(comments.map((c) => [c.id, c.assignment.accountId]));
  const out = new Map<number, number>();
  for (const [id, p] of parsed) {
    const accountId =
      p?.kind === "deadline"
        ? byAssignment.get(p.assignmentId)
        : p?.kind === "quality"
          ? byVersion.get(p.versionId)
          : p?.kind === "comment"
            ? byComment.get(p.commentId)
            : p?.kind === "sync"
              ? p.accountId
              : undefined;
    if (accountId !== undefined) out.set(id, accountId);
  }
  return out;
}

interface StoredLlmFindings {
  output?: { summaryForParent?: string };
  unchecked?: unknown[];
}

function mergedResult(
  results: readonly { source: string; verdict: string; findings: string }[],
): Pick<TurnedInItem, "verdict" | "basis" | "summary"> {
  // `results` is newest first.
  const llm = results.find((r) => r.source.startsWith("llm:"));
  if (llm) {
    let summary: string | undefined;
    let unchecked = 0;
    try {
      const f = JSON.parse(llm.findings) as StoredLlmFindings;
      summary = f.output?.summaryForParent?.trim();
      unchecked = Array.isArray(f.unchecked) ? f.unchecked.length : 0;
    } catch {
      // Malformed findings: show the verdict alone.
    }
    return {
      verdict: llm.verdict as Verdict,
      basis: "llm",
      ...(summary ? { summary } : {}),
      ...(unchecked ? { unchecked } : {}),
    };
  }
  const heuristic = results.find((r) => r.source === "heuristic");
  if (heuristic) return { verdict: heuristic.verdict as Verdict, basis: "heuristic" };
  return { verdict: "pending", basis: "none" };
}

/** Collects the report data from the store. */
export async function buildReport(db: Db, opts: BuildReportOptions = {}): Promise<Report> {
  const now = opts.now ?? new Date();
  const since = opts.since === undefined ? new Date(now.getTime() - DAY_MS) : opts.since;
  const alertsOnly = opts.alertIds !== undefined;

  const accounts = await db.account.findMany({
    where: { OR: [{ watched: true }, { email: { in: [...(opts.watchedEmails ?? [])] } }] },
    orderBy: { email: "asc" },
  });

  const alertRows = await db.alert.findMany({
    where: alertsOnly
      ? { id: { in: [...(opts.alertIds ?? [])] } }
      : since
        ? { mutedAt: null, OR: [{ sentAt: null }, { createdAt: { gte: since } }] }
        : {},
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const alerts: ReportAlert[] = alertRows.map((a) => ({
    id: a.id,
    key: a.key,
    level: a.level as AlertLevel,
    content: alertContent(a),
    createdAt: a.createdAt,
    sentAt: a.sentAt,
  }));
  const owners = await alertAccounts(db, alerts);

  const reports = new Map<number, AccountReport>();
  for (const a of accounts) {
    reports.set(a.id, {
      id: a.id,
      email: a.email,
      label: accountLabel(a),
      panics: [],
      alerts: [],
      checkByHand: [],
      info: [],
      turnedIn: [],
      upcoming: [],
      backlog: [],
    });
  }
  // A version with a warn/panic alert already lists its unchecked parts there.
  const versionOf = (key: string) => /^quality:(\d+)/.exec(key)?.[1];
  const flagged = new Set(
    alerts.flatMap((a) =>
      a.level !== "info" && /^quality:\d+(?::c\d+)?$/.test(a.key) ? [versionOf(a.key)] : [],
    ),
  );
  const other: ReportAlert[] = [];
  for (const alert of alerts) {
    const owner = owners.get(alert.id);
    const r = owner === undefined ? undefined : reports.get(owner);
    if (!r) other.push(alert);
    else if (alert.level === "panic") r.panics.push(alert);
    else if (alert.level === "alert") r.alerts.push(alert);
    else if (isUncheckedAlertKey(alert.key)) {
      if (!flagged.has(versionOf(alert.key))) r.checkByHand.push(alert);
    } else r.info.push(alert);
  }

  if (!alertsOnly) {
    const accountIds = accounts.map((a) => a.id);
    const submissions = await db.submission.findMany({
      where: {
        state: { in: DONE },
        assignment: { accountId: { in: accountIds }, kind: { not: "material" } },
        ...(since ? { turnedInAt: { gte: since } } : {}),
      },
      include: {
        assignment: {
          select: { accountId: true, title: true, course: { select: { name: true } } },
        },
        versions: {
          orderBy: [{ seenAt: "desc" }, { id: "desc" }],
          take: 1,
          include: { checkResults: { orderBy: [{ createdAt: "desc" }, { id: "desc" }] } },
        },
      },
      orderBy: [{ turnedInAt: "desc" }, { id: "desc" }],
    });
    for (const s of submissions) {
      reports.get(s.assignment.accountId)?.turnedIn.push({
        title: s.assignment.title,
        courseName: s.assignment.course.name,
        turnedInAt: s.turnedInAt,
        ...mergedResult(s.versions[0]?.checkResults ?? []),
      });
    }

    const until = new Date(now.getTime() + (opts.upcomingDays ?? 7) * DAY_MS);
    const upcoming = await db.assignment.findMany({
      where: {
        accountId: { in: accountIds },
        kind: { not: "material" },
        status: { notIn: DONE },
        dueAt: { gte: now, lte: until },
        OR: [{ submission: { is: null } }, { submission: { is: { state: { notIn: DONE } } } }],
      },
      include: { course: { select: { name: true } } },
      orderBy: [{ dueAt: "asc" }, { id: "asc" }],
    });
    for (const a of upcoming) {
      if (!a.dueAt) continue;
      reports
        .get(a.accountId)
        ?.upcoming.push({ title: a.title, courseName: a.course.name, dueAt: a.dueAt });
    }
  }

  if (opts.backlog) {
    const shown = new Set(alerts.map((a) => a.id));
    const debts = await loadBacklog(db, {
      now,
      forgetDays: opts.backlog.forgetDays,
      accountIds: accounts.map((a) => a.id),
    });
    for (const d of debts) {
      if (d.alertId !== null && shown.has(d.alertId)) continue;
      reports.get(d.accountId)?.backlog.push(d);
    }
  }

  return { generatedAt: now, since, alertsOnly, accounts: [...reports.values()], other };
}

// ---------------------------------------------------------------------------------------------
// Formatting

/** Language and time zone of the printed report (`digestLang`, `timeZone`). */
export type FormatOptions = Locale;

/** An alert's text in the report's language. */
export function alertText(a: Pick<ReportAlert, "content" | "createdAt">, loc: Locale): string {
  return renderAlert(a.content, a.createdAt, loc);
}

function debtLines(debts: readonly Debt[], now: Date, lang: Lang): string[] {
  const m = messages(lang);
  return debts.flatMap((d) => [
    `  • ${m.report.debt[d.kind]}: ${itemLabel(d.title, d.courseName, lang)} · ${formatAge(
      debtAgeDays(d, now),
      lang,
    )}${d.alertId === null ? "" : ` · #${d.alertId}`}`,
    `      ${d.url}`,
  ]);
}

function alertLines(alerts: readonly ReportAlert[], loc: Locale): string[] {
  return alerts.map((a) => `  • ${alertText(a, loc)}  [${formatTime(a.createdAt, loc)}]`);
}

/** Plain-text report for a terminal, in `opts.lang` (default Ukrainian). */
export function formatReport(report: Report, opts: Partial<FormatOptions> = {}): string {
  const loc: Locale = { lang: opts.lang ?? DEFAULT_LANG, timeZone: opts.timeZone };
  const { lang } = loc;
  const r = messages(lang).report;
  const window = report.alertsOnly
    ? r.newAlerts
    : report.since
      ? r.since(formatTime(report.since, loc))
      : r.everything;
  const out: string[] = [`${r.title} · ${formatTime(report.generatedAt, loc)} · ${window}`];
  if (report.accounts.length === 0) out.push("", r.noAccounts);
  for (const a of report.accounts) {
    if (report.alertsOnly && alertCount(a) + a.backlog.length === 0) continue;
    out.push("", `== ${a.label} ==`);
    const before = out.length;
    if (a.panics.length) out.push(r.panics, ...alertLines(a.panics, loc));
    if (a.alerts.length) out.push(r.alerts, ...alertLines(a.alerts, loc));
    if (a.turnedIn.length) {
      out.push(r.turnedIn);
      for (const t of a.turnedIn) {
        const when = t.turnedInAt ? ` · ${formatTime(t.turnedInAt, loc)}` : "";
        const basis = t.basis === "heuristic" ? ` ${r.heuristicsOnly}` : "";
        const partly =
          t.unchecked && t.verdict !== "unchecked" ? ` · ${r.partsNotChecked(t.unchecked)}` : "";
        out.push(
          `  • ${itemLabel(t.title, t.courseName, lang)}${when} · ${r.verdict[t.verdict]}${basis}${partly}`,
        );
        if (t.summary) out.push(`      ${t.summary}`);
      }
    }
    if (a.upcoming.length) {
      out.push(r.upcoming);
      for (const u of a.upcoming) {
        const ms = u.dueAt.getTime() - report.generatedAt.getTime();
        out.push(
          `  • ${formatTime(u.dueAt, loc)} (${formatIn(ms, lang)})  ${itemLabel(u.title, u.courseName, lang)}`,
        );
      }
    }
    if (a.checkByHand.length) out.push(r.checkByHand, ...alertLines(a.checkByHand, loc));
    if (a.backlog.length) out.push(r.debts, ...debtLines(a.backlog, report.generatedAt, lang));
    if (a.info.length) out.push(r.info, ...alertLines(a.info, loc));
    if (out.length === before) out.push(`  ${r.nothing}`);
  }
  if (report.other.length) {
    out.push("", `== ${r.other} ==`, ...alertLines(report.other, loc));
  }
  return out.join("\n");
}

function alertCount(a: AccountReport): number {
  return a.panics.length + a.alerts.length + a.checkByHand.length + a.info.length;
}

/** Whether the report has any open debt. */
export function reportHasBacklog(report: Report): boolean {
  return report.accounts.some((a) => a.backlog.length > 0);
}

/** Whether the report has any alert at all (for the `run` digest). */
export function reportHasAlerts(report: Report): boolean {
  return report.other.length > 0 || report.accounts.some((a) => alertCount(a) > 0);
}
