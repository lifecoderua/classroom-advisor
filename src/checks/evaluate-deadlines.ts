import type { LlmProvider } from "../llm/types.ts";
import { type Db, raiseAlert } from "../store/index.ts";
import { MUTE_NO_WORK, muteAlerts } from "./auto-ack.ts";
import {
  type AlertDraft,
  DAY_MS,
  type DeadlineInput,
  type DeadlineOptions,
  deadlineAlerts,
  EXPECTS_WORK,
  type ExpectsWork,
  evaluateDeadlineRules,
  REMINDER_CODES,
} from "./deadlines.ts";
import type { ReadText } from "./evaluate-heuristics.ts";
import { type ClassifyStatus, classifyVersion } from "./expects-work.ts";

interface DeadlineRow {
  input: DeadlineInput;
  /** Current (latest) content version, null when none is stored. */
  versionId: number | null;
}

async function loadDeadlineRows(db: Db): Promise<DeadlineRow[]> {
  const rows = await db.assignment.findMany({
    where: {
      account: { watched: true },
      kind: { not: "material" },
      status: { notIn: ["turned_in", "returned", "excused"] },
    },
    include: {
      course: { select: { name: true } },
      submission: { include: { attachments: { where: { owner: "submission" } } } },
      versions: {
        orderBy: [{ seenAt: "desc" }, { id: "desc" }],
        take: 1,
        select: { id: true, expectsWork: true },
      },
    },
    orderBy: { id: "asc" },
  });
  return rows.map((r) => {
    const s = r.submission;
    const edits = s?.attachments.flatMap((x) => (x.modifiedAt ? [x.modifiedAt.getTime()] : []));
    const v = r.versions[0];
    const expectsWork = (EXPECTS_WORK as readonly string[]).includes(v?.expectsWork ?? "")
      ? (v?.expectsWork as ExpectsWork)
      : null;
    return {
      versionId: v?.id ?? null,
      input: {
        assignment: {
          id: r.id,
          kind: r.kind,
          title: r.title,
          courseName: r.course.name,
          dueAt: r.dueAt,
          postedAt: r.postedAt,
          firstSeenAt: r.firstSeenAt,
          status: r.status,
          baseline: r.baseline,
          expectsWork,
        },
        submission: s && {
          state: s.state,
          turnedInAt: s.turnedInAt,
          studentWorkSignals: {
            attachmentCount: s.attachments.length,
            lastStudentEditAt: edits?.length ? new Date(Math.max(...edits)) : null,
          },
        },
      },
    };
  });
}

/** Loads open assignments of watched accounts as plain `DeadlineInput` snapshots. */
export async function loadDeadlineInputs(db: Db): Promise<DeadlineInput[]> {
  return (await loadDeadlineRows(db)).map((r) => r.input);
}

export interface ExpectsWorkOptions {
  provider: LlmProvider;
  /** At most this many LLM calls per run (`expectsWorkMaxPerRun`); the rest waits a run. */
  maxPerRun: number;
  /** Cached text of the teacher's attachments, when available. */
  readText?: ReadText | undefined;
  /** One operator line per run that classified or muted anything (no titles). */
  log?: ((line: string) => void) | undefined;
}

export interface EvaluateDeadlinesOptions {
  /** `config.alertLookbackDays`: reminders only for items posted within this many days. */
  lookbackDays?: number;
  /** `config.backlogForgetDays`: no alerts at all for items dated longer ago (#69). */
  depthDays?: number;
  /**
   * Classify the current version of assignments whose reminder would fire (#61). Without it,
   * only verdicts already stored are applied.
   */
  expectsWork?: ExpectsWorkOptions;
}

export type ExpectsWorkStats = Record<Exclude<ClassifyStatus, "cached" | "missing">, number> & {
  /** Open reminders muted because the post asks for no work. */
  muted: number;
  /** Reminders muted for a `no` verdict, raised again after an edit changed the verdict. */
  revived: number;
};

const isReminder = (d: AlertDraft) => REMINDER_CODES.has(d.code);

/**
 * Lazy expects-work step: for rows whose current version is unclassified and whose reminder
 * would fire now, classify the version (skeleton cache first, then the LLM within the run's
 * budget, most recently posted first) and put the verdict into the row's input.
 */
async function classifyPending(
  db: Db,
  rows: DeadlineRow[],
  now: Date,
  rules: DeadlineOptions,
  opts: ExpectsWorkOptions,
  stats: ExpectsWorkStats,
): Promise<void> {
  const posted = (r: DeadlineRow) =>
    (r.input.assignment.postedAt ?? r.input.assignment.firstSeenAt).getTime();
  const pending = rows
    .filter(
      (r) =>
        r.versionId !== null &&
        !r.input.assignment.expectsWork &&
        deadlineAlerts(r.input, now, rules).some(isReminder),
    )
    .sort((a, b) => posted(b) - posted(a));
  let calls = 0;
  for (const r of pending) {
    const res = await classifyVersion(db, r.versionId as number, {
      provider: opts.provider,
      readText: opts.readText,
      allowLlm: calls < opts.maxPerRun,
      now,
    });
    if (res.status === "llm" || res.status === "failed") calls++;
    if (res.status !== "cached" && res.status !== "missing") stats[res.status]++;
    if (res.expectsWork) r.input.assignment.expectsWork = res.expectsWork;
  }
}

/** Mutes the open reminders of assignments whose current version asks for no work. */
async function muteNoWorkReminders(db: Db, rows: DeadlineRow[], now: Date): Promise<number> {
  const noWork = new Set(
    rows.filter((r) => r.input.assignment.expectsWork === "no").map((r) => r.input.assignment.id),
  );
  if (noWork.size === 0) return 0;
  const open = await db.alert.findMany({
    where: {
      mutedAt: null,
      OR: [{ key: { contains: ":untouched_24h" } }, { key: { contains: ":no_due_date" } }],
      key: { startsWith: "deadline:" },
    },
    select: { id: true, key: true },
  });
  const ids = open
    .filter((a) => {
      const [, id, code] = a.key.split(":");
      return noWork.has(Number(id)) && (code === "untouched_24h" || code === "no_due_date");
    })
    .map((a) => a.id);
  if (ids.length) await muteAlerts(db, ids, MUTE_NO_WORK, now);
  return ids.length;
}

/**
 * A reminder that was muted for a `no` verdict fires again (the post was edited and now asks for
 * work, or its verdict is unknown): unmute it as a fresh, unsent alert.
 */
async function reviveReminders(db: Db, drafts: AlertDraft[], now: Date): Promise<AlertDraft[]> {
  const reminders = drafts.filter(isReminder);
  if (reminders.length === 0) return [];
  const muted = await db.alert.findMany({
    where: { key: { in: reminders.map((d) => d.key) }, muteReason: MUTE_NO_WORK },
    select: { id: true, key: true },
  });
  if (muted.length === 0) return [];
  await db.alert.updateMany({
    where: { id: { in: muted.map((a) => a.id) } },
    data: { mutedAt: null, muteReason: null, sentAt: null, createdAt: now },
  });
  const keys = new Set(muted.map((a) => a.key));
  return reminders.filter((d) => keys.has(d.key));
}

/** Runs the deadline rules over the store and raises (deduped) alerts. Returns new alerts only. */
export async function evaluateDeadlines(
  db: Db,
  now: Date = new Date(),
  options: EvaluateDeadlinesOptions = {},
): Promise<AlertDraft[]> {
  const rules: DeadlineOptions = {
    ...(options.lookbackDays === undefined ? {} : { lookbackMs: options.lookbackDays * DAY_MS }),
    ...(options.depthDays === undefined ? {} : { depthMs: options.depthDays * DAY_MS }),
  };
  const rows = await loadDeadlineRows(db);
  const stats: ExpectsWorkStats = {
    llm: 0,
    skeleton: 0,
    failed: 0,
    deferred: 0,
    awaiting: 0,
    muted: 0,
    revived: 0,
  };
  if (options.expectsWork) {
    await classifyPending(db, rows, now, rules, options.expectsWork, stats);
  }
  const drafts = evaluateDeadlineRules(
    rows.map((r) => r.input),
    now,
    rules,
  );
  const created = await reviveReminders(db, drafts, now);
  stats.revived = created.length;
  for (const d of drafts) {
    const res = await raiseAlert(db, { key: d.key, level: d.level, ...d.content }, now);
    if (res.created) created.push(d);
  }
  stats.muted = await muteNoWorkReminders(db, rows, now);
  const log = options.expectsWork?.log;
  if (log && Object.values(stats).some((n) => n > 0)) {
    log(
      `expects-work: ${stats.llm} llm, ${stats.skeleton} skeleton, ${stats.failed} failed, ${stats.deferred} deferred, ${stats.awaiting} awaiting files; ${stats.muted} reminder(s) muted, ${stats.revived} revived`,
    );
  }
  return created;
}
