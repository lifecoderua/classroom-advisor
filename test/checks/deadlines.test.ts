import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  type DeadlineInput,
  deadlineAlerts,
  HOUR_MS,
  isoWeek,
} from "../../src/checks/deadlines.ts";

const NOW = new Date("2026-10-10T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const ahead = (ms: number) => new Date(NOW.getTime() + ms);

type Over = {
  assignment?: Partial<DeadlineInput["assignment"]>;
  submission?: DeadlineInput["submission"];
};

function input(over: Over = {}): DeadlineInput {
  return {
    assignment: {
      id: 7,
      kind: "assignment",
      title: "Fractions",
      courseName: "Math",
      dueAt: ahead(3 * DAY_MS),
      postedAt: ago(HOUR_MS),
      firstSeenAt: ago(HOUR_MS),
      status: "assigned",
      ...over.assignment,
    },
    submission:
      over.submission === undefined
        ? { state: "created", studentWorkSignals: { attachmentCount: 0 } }
        : over.submission,
  };
}

const withWork = (attachmentCount: number, lastStudentEditAt?: Date) => ({
  state: "created",
  studentWorkSignals: lastStudentEditAt
    ? { attachmentCount, lastStudentEditAt }
    : { attachmentCount },
});

const cases: { name: string; in: DeadlineInput; codes: string[] }[] = [
  { name: "fresh assignment, nothing to report", in: input(), codes: [] },
  // untouched_24h
  {
    name: "posted exactly 24h ago: not yet untouched",
    in: input({ assignment: { postedAt: ago(DAY_MS) } }),
    codes: [],
  },
  {
    name: "posted 24h + 1ms ago, no work",
    in: input({ assignment: { postedAt: ago(DAY_MS + 1) } }),
    codes: ["untouched_24h"],
  },
  {
    name: "falls back to firstSeenAt without postedAt",
    in: input({ assignment: { postedAt: null, firstSeenAt: ago(2 * DAY_MS) } }),
    codes: ["untouched_24h"],
  },
  {
    name: "no submission row counts as no work",
    in: input({ assignment: { postedAt: ago(2 * DAY_MS) }, submission: null }),
    codes: ["untouched_24h"],
  },
  {
    name: "student attachment is a sign of work",
    in: input({ assignment: { postedAt: ago(2 * DAY_MS) }, submission: withWork(1) }),
    codes: [],
  },
  {
    name: "edit after posting is a sign of work",
    in: input({
      assignment: { postedAt: ago(2 * DAY_MS) },
      submission: withWork(0, ago(DAY_MS)),
    }),
    codes: [],
  },
  {
    name: "edit before posting is not work",
    in: input({
      assignment: { postedAt: ago(2 * DAY_MS) },
      submission: withWork(0, ago(3 * DAY_MS)),
    }),
    codes: ["untouched_24h"],
  },
  // due_soon
  {
    name: "due in exactly 24h: not due soon",
    in: input({ assignment: { dueAt: ahead(DAY_MS) } }),
    codes: [],
  },
  {
    name: "due in 24h - 1ms",
    in: input({ assignment: { dueAt: ahead(DAY_MS - 1) } }),
    codes: ["due_soon"],
  },
  {
    name: "due in 1ms",
    in: input({ assignment: { dueAt: ahead(1) } }),
    codes: ["due_soon"],
  },
  {
    name: "due soon suppresses untouched",
    in: input({ assignment: { dueAt: ahead(HOUR_MS), postedAt: ago(3 * DAY_MS) } }),
    codes: ["due_soon"],
  },
  // missing
  {
    name: "due exactly now: missing",
    in: input({ assignment: { dueAt: NOW } }),
    codes: ["missing"],
  },
  {
    name: "overdue, not turned in",
    in: input({ assignment: { dueAt: ago(HOUR_MS), postedAt: ago(3 * DAY_MS) } }),
    codes: ["missing"],
  },
  {
    name: "status missing even with a future due date",
    in: input({ assignment: { status: "missing" } }),
    codes: ["missing"],
  },
  {
    name: "returned without being turned in, missing bucket: missing",
    in: input({
      assignment: { dueAt: ago(DAY_MS), status: "missing", baseline: true },
      submission: { state: "returned", studentWorkSignals: { attachmentCount: 0 } },
    }),
    codes: ["missing"],
  },
  {
    name: "reclaimed submission after due: missing",
    in: input({
      assignment: { dueAt: ago(HOUR_MS), status: "turned_in" },
      submission: { state: "reclaimed", studentWorkSignals: { attachmentCount: 1 } },
    }),
    codes: ["missing"],
  },
  // no_due_date
  {
    name: "no due date, exactly 7 days old: no reminder yet",
    in: input({ assignment: { dueAt: null, postedAt: ago(7 * DAY_MS) }, submission: withWork(1) }),
    codes: [],
  },
  {
    name: "no due date, older than 7 days, with work",
    in: input({ assignment: { dueAt: null, postedAt: ago(8 * DAY_MS) }, submission: withWork(1) }),
    codes: ["no_due_date"],
  },
  {
    name: "no due date, older than 7 days, untouched",
    in: input({ assignment: { dueAt: null, postedAt: ago(8 * DAY_MS) } }),
    codes: ["untouched_24h", "no_due_date"],
  },
  // ignored
  {
    name: "material is ignored",
    in: input({ assignment: { kind: "material", dueAt: ago(HOUR_MS) } }),
    codes: [],
  },
  {
    name: "turned in is ignored",
    in: input({
      assignment: { dueAt: ahead(HOUR_MS), postedAt: ago(3 * DAY_MS) },
      submission: { state: "turned_in", studentWorkSignals: { attachmentCount: 0 } },
    }),
    codes: [],
  },
  {
    name: "returned is ignored",
    in: input({
      assignment: { dueAt: ago(HOUR_MS), status: "returned" },
      submission: { state: "returned", studentWorkSignals: { attachmentCount: 0 } },
    }),
    codes: [],
  },
  {
    name: "status turned_in without a submission row is ignored",
    in: input({ assignment: { dueAt: ago(HOUR_MS), status: "turned_in" }, submission: null }),
    codes: [],
  },
];

describe("deadlineAlerts", () => {
  it.each(cases)("$name", ({ in: i, codes }) => {
    expect(deadlineAlerts(i, NOW).map((d) => d.code)).toEqual(codes);
  });

  it("builds levels, keys and messages", () => {
    const [soon] = deadlineAlerts(input({ assignment: { dueAt: ahead(5 * HOUR_MS) } }), NOW);
    expect(soon).toEqual({
      key: "deadline:7:due_soon",
      level: "panic",
      code: "due_soon",
      content: {
        code: "deadline.due_soon",
        params: {
          title: "Fractions",
          course: "Math",
          dueAt: ahead(5 * HOUR_MS).toISOString(),
        },
      },
    });
    const drafts = deadlineAlerts(
      input({ assignment: { dueAt: null, postedAt: ago(8 * DAY_MS) } }),
      NOW,
    );
    expect(drafts.map((d) => [d.key, d.level])).toEqual([
      ["deadline:7:untouched_24h", "alert"],
      ["deadline:7:no_due_date:2026-W41", "info"],
    ]);
  });

  it("weekly key changes with the ISO week", () => {
    const i = input({
      assignment: { dueAt: null, postedAt: ago(8 * DAY_MS) },
      submission: withWork(1),
    });
    const key = (now: Date) => deadlineAlerts(i, now)[0]?.key;
    expect(key(new Date("2026-10-11T23:59:59Z"))).toBe("deadline:7:no_due_date:2026-W41");
    expect(key(new Date("2026-10-12T00:00:00Z"))).toBe("deadline:7:no_due_date:2026-W42");
  });

  it("uses UTC instants only (a local DST switch does not shift the 24h boundary)", () => {
    // 2026-10-25 is the EU DST switch; the gap is still exactly 24h of real time.
    const now = new Date("2026-10-25T03:30:00Z");
    const i = input({ assignment: { postedAt: new Date("2026-10-24T03:30:00Z"), dueAt: null } });
    expect(deadlineAlerts(i, now)).toEqual([]);
    expect(deadlineAlerts(i, new Date(now.getTime() + 1)).map((d) => d.code)).toEqual([
      "untouched_24h",
    ]);
  });
});

describe("baseline and lookback (alert-flood guard)", () => {
  const codes = (i: DeadlineInput, lookbackMs?: number) =>
    deadlineAlerts(i, NOW, lookbackMs === undefined ? {} : { lookbackMs }).map((d) => d.code);
  const old = { postedAt: ago(30 * DAY_MS), dueAt: null };

  it("baseline items get the panics only", () => {
    expect(codes(input({ assignment: { ...old, baseline: true } }))).toEqual([]);
    expect(codes(input({ assignment: { ...old, status: "missing", baseline: true } }))).toEqual([
      "missing",
    ]);
    const soon = { postedAt: ago(30 * DAY_MS), dueAt: ahead(2 * HOUR_MS), baseline: true };
    expect(codes(input({ assignment: soon }))).toEqual(["due_soon"]);
  });

  it("reminders only within the lookback window", () => {
    expect(codes(input({ assignment: old }))).toEqual(["untouched_24h", "no_due_date"]);
    expect(codes(input({ assignment: old }), 14 * DAY_MS)).toEqual([]);
    const recent = { postedAt: ago(10 * DAY_MS), dueAt: null };
    expect(codes(input({ assignment: recent }), 14 * DAY_MS)).toEqual([
      "untouched_24h",
      "no_due_date",
    ]);
  });

  it("excused items never alert", () => {
    expect(codes(input({ assignment: { ...old, status: "excused", dueAt: ago(DAY_MS) } }))).toEqual(
      [],
    );
  });
});

describe("isoWeek", () => {
  it.each([
    ["2026-10-10T12:00:00Z", "2026-W41"],
    ["2026-10-11T23:59:59Z", "2026-W41"], // Sunday
    ["2026-01-01T00:00:00Z", "2026-W01"], // Thursday
    ["2027-01-01T00:00:00Z", "2026-W53"], // Friday: previous year's last week
    ["2024-12-30T00:00:00Z", "2025-W01"], // Monday: next year's first week
  ])("%s -> %s", (iso, week) => {
    expect(isoWeek(new Date(iso))).toBe(week);
  });
});
