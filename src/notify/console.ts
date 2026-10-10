import type { Db } from "../store/index.ts";
import type { AlertLevel, Verdict } from "../store/types.ts";

// Console digest: per watched account, panics, alerts, recently turned-in work with its merged
// verdict, upcoming deadlines and info items. Read-only: `Alert.sentAt` belongs to the Telegram
// notifier, the console only displays.

const DONE = ["turned_in", "returned"];
const DAY_MS = 86_400_000;

export interface ReportAlert {
  id: number;
  key: string;
  level: AlertLevel;
  message: string;
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
}

export interface UpcomingItem {
  title: string;
  courseName: string;
  dueAt: Date;
}

export interface AccountReport {
  email: string;
  label: string;
  panics: ReportAlert[];
  alerts: ReportAlert[];
  info: ReportAlert[];
  turnedIn: TurnedInItem[];
  upcoming: UpcomingItem[];
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
  /** Window start: alerts created since then (plus any unsent) and work turned in since then. */
  since?: Date | null;
  /** Config watch list; accounts marked watched in the DB are always included. */
  watchedEmails?: readonly string[];
  /** Report exactly these alerts and nothing else. */
  alertIds?: readonly number[];
  upcomingDays?: number;
}

/** Display name, else the email's local part. */
export function accountLabel(a: { email: string; displayName: string | null }): string {
  return a.displayName?.trim() || a.email.split("@")[0] || a.email;
}

/** `deadline:<assignmentId>:…` / `quality:<submissionVersionId>[:…]` → the referenced id. */
export function parseAlertKey(
  key: string,
): { kind: "deadline"; assignmentId: number } | { kind: "quality"; versionId: number } | null {
  const [kind, raw] = key.split(":");
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return null;
  if (kind === "deadline") return { kind, assignmentId: id };
  if (kind === "quality") return { kind, versionId: id };
  return null;
}

async function alertAccounts(db: Db, alerts: readonly ReportAlert[]): Promise<Map<number, number>> {
  const parsed = alerts.map((a) => [a.id, parseAlertKey(a.key)] as const);
  const assignmentIds = parsed.flatMap(([, p]) => (p?.kind === "deadline" ? [p.assignmentId] : []));
  const versionIds = parsed.flatMap(([, p]) => (p?.kind === "quality" ? [p.versionId] : []));
  const [assignments, versions] = await Promise.all([
    db.assignment.findMany({
      where: { id: { in: assignmentIds } },
      select: { id: true, accountId: true },
    }),
    db.submissionVersion.findMany({
      where: { id: { in: versionIds } },
      select: { id: true, submission: { select: { assignment: { select: { accountId: true } } } } },
    }),
  ]);
  const byAssignment = new Map(assignments.map((a) => [a.id, a.accountId]));
  const byVersion = new Map(versions.map((v) => [v.id, v.submission.assignment.accountId]));
  const out = new Map<number, number>();
  for (const [id, p] of parsed) {
    const accountId =
      p?.kind === "deadline"
        ? byAssignment.get(p.assignmentId)
        : p?.kind === "quality"
          ? byVersion.get(p.versionId)
          : undefined;
    if (accountId !== undefined) out.set(id, accountId);
  }
  return out;
}

interface StoredLlmFindings {
  output?: { summaryForParent?: string };
}

function mergedResult(
  results: readonly { source: string; verdict: string; findings: string }[],
): Pick<TurnedInItem, "verdict" | "basis" | "summary"> {
  // `results` is newest first.
  const llm = results.find((r) => r.source.startsWith("llm:"));
  if (llm) {
    let summary: string | undefined;
    try {
      summary = (JSON.parse(llm.findings) as StoredLlmFindings).output?.summaryForParent?.trim();
    } catch {
      // Malformed findings: show the verdict alone.
    }
    return { verdict: llm.verdict as Verdict, basis: "llm", ...(summary ? { summary } : {}) };
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
        ? { OR: [{ sentAt: null }, { createdAt: { gte: since } }] }
        : {},
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const alerts: ReportAlert[] = alertRows.map((a) => ({ ...a, level: a.level as AlertLevel }));
  const owners = await alertAccounts(db, alerts);

  const reports = new Map<number, AccountReport>();
  for (const a of accounts) {
    reports.set(a.id, {
      email: a.email,
      label: accountLabel(a),
      panics: [],
      alerts: [],
      info: [],
      turnedIn: [],
      upcoming: [],
    });
  }
  const other: ReportAlert[] = [];
  for (const alert of alerts) {
    const owner = owners.get(alert.id);
    const r = owner === undefined ? undefined : reports.get(owner);
    if (!r) other.push(alert);
    else if (alert.level === "panic") r.panics.push(alert);
    else if (alert.level === "alert") r.alerts.push(alert);
    else r.info.push(alert);
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
        assignment: { select: { accountId: true, title: true, course: { select: { name: true } } } },
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

  return { generatedAt: now, since, alertsOnly, accounts: [...reports.values()], other };
}

// ---------------------------------------------------------------------------------------------
// Formatting

export interface FormatOptions {
  /** IANA time zone for timestamps; the process's local zone by default. */
  timeZone?: string;
}

export function formatTime(d: Date, timeZone?: string): string {
  return d.toLocaleString("en-GB", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    ...(timeZone ? { timeZone } : {}),
  });
}

/** `in 3h`, `in 2d`, `in 45m`. */
export function formatIn(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `in ${min}m`;
  const h = Math.round(min / 60);
  if (h < 48) return `in ${h}h`;
  return `in ${Math.round(h / 24)}d`;
}

const VERDICT_MARK: Record<TurnedInItem["verdict"], string> = {
  ok: "✅ ok",
  warn: "🟠 warn",
  panic: "🔴 panic",
  pending: "⏳ not reviewed yet",
};

const label = (title: string, course: string) => (course ? `"${title}" (${course})` : `"${title}"`);

function alertLines(alerts: readonly ReportAlert[], tz?: string): string[] {
  return alerts.map((a) => `  • ${a.message}  [${formatTime(a.createdAt, tz)}]`);
}

/** Plain-text report for a terminal. */
export function formatReport(report: Report, opts: FormatOptions = {}): string {
  const tz = opts.timeZone;
  const window = report.alertsOnly
    ? "new alerts"
    : report.since
      ? `since ${formatTime(report.since, tz)}`
      : "everything";
  const out: string[] = [`Classroom report · ${formatTime(report.generatedAt, tz)} · ${window}`];
  if (report.accounts.length === 0) {
    out.push("", "No watched accounts in the database yet (run a sync first).");
  }
  for (const a of report.accounts) {
    if (report.alertsOnly && a.panics.length + a.alerts.length + a.info.length === 0) continue;
    out.push("", `== ${a.label} ==`);
    const before = out.length;
    if (a.panics.length) out.push("🔴 Panics", ...alertLines(a.panics, tz));
    if (a.alerts.length) out.push("🟠 Alerts", ...alertLines(a.alerts, tz));
    if (a.turnedIn.length) {
      out.push("📥 Turned in");
      for (const t of a.turnedIn) {
        const when = t.turnedInAt ? ` · ${formatTime(t.turnedInAt, tz)}` : "";
        const basis = t.basis === "heuristic" ? " (heuristics only)" : "";
        out.push(`  • ${label(t.title, t.courseName)}${when} · ${VERDICT_MARK[t.verdict]}${basis}`);
        if (t.summary) out.push(`      ${t.summary}`);
      }
    }
    if (a.upcoming.length) {
      out.push("📅 Due in the next 7 days");
      for (const u of a.upcoming) {
        const ms = u.dueAt.getTime() - report.generatedAt.getTime();
        out.push(
          `  • ${formatTime(u.dueAt, tz)} (${formatIn(ms)})  ${label(u.title, u.courseName)}`,
        );
      }
    }
    if (a.info.length) out.push("ℹ️  Info", ...alertLines(a.info, tz));
    if (out.length === before) out.push("  Nothing to report.");
  }
  if (report.other.length) {
    out.push("", "== Other ==", ...alertLines(report.other, tz));
  }
  return out.join("\n");
}

/** Whether the report has any alert at all (for the `run` digest). */
export function reportHasAlerts(report: Report): boolean {
  return (
    report.other.length > 0 ||
    report.accounts.some((a) => a.panics.length + a.alerts.length + a.info.length > 0)
  );
}
