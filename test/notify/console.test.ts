import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  accountLabel,
  buildReport,
  formatIn,
  formatReport,
  parseAlertKey,
  reportHasAlerts,
} from "../../src/notify/console.ts";
import {
  addCheckResult,
  type Db,
  raiseAlert,
  upsertAccount,
  upsertAssignment,
  upsertCourse,
  upsertSubmission,
} from "../../src/store/index.ts";
import { migratedTemplate } from "../store/helpers.ts";

const NOW = new Date("2026-10-10T12:00:00Z");
const H = 3_600_000;
const ago = (h: number) => new Date(NOW.getTime() - h * H);
const TZ = "UTC";

let template: ReturnType<typeof migratedTemplate>;
let db: Db;

beforeAll(() => {
  template = migratedTemplate();
}, 60_000);
afterAll(() => template.cleanup());
beforeEach(async () => {
  db = await template.fresh();
});

async function seed() {
  const one = await upsertAccount(db, {
    email: "student-one@school.example",
    displayName: "Student One",
  });
  const two = await upsertAccount(db, { email: "student-two@school.example" });
  await db.account.update({ where: { id: one.id }, data: { watched: true } });
  const unwatched = await upsertAccount(db, { email: "parent@school.example" });
  const course = await upsertCourse(db, { accountId: one.id, classroomId: "c1", name: "Math" });
  const course2 = await upsertCourse(db, { accountId: two.id, classroomId: "c2", name: "Art" });
  const course3 = await upsertCourse(db, {
    accountId: unwatched.id,
    classroomId: "c3",
    name: "Other",
  });

  let n = 0;
  const assignment = async (
    accountId: number,
    courseId: number,
    title: string,
    extra: { dueAt?: Date; status?: string; kind?: "assignment" | "material" } = {},
  ) =>
    (
      await upsertAssignment(
        db,
        {
          accountId,
          courseId,
          classroomId: `a${n++}`,
          kind: extra.kind ?? "assignment",
          title,
          status: extra.status ?? "assigned",
          dueAt: extra.dueAt ?? null,
          hash: title,
          payload: {},
        },
        ago(72),
      )
    ).assignment;

  const late = await assignment(one.id, course.id, "Fractions", {
    dueAt: new Date(NOW.getTime() + 5 * H),
  });
  await assignment(one.id, course.id, "Geometry", { dueAt: new Date(NOW.getTime() + 3 * 24 * H) });
  await assignment(one.id, course.id, "Far away", { dueAt: new Date(NOW.getTime() + 9 * 24 * H) });
  await assignment(one.id, course.id, "Past", { dueAt: ago(5) });
  await assignment(one.id, course.id, "Reading", {
    kind: "material",
    dueAt: new Date(NOW.getTime() + 2 * H),
  });
  // Turned in but the assignment status still lags: excluded via the submission state.
  const lagging = await assignment(one.id, course.id, "Lagging", {
    dueAt: new Date(NOW.getTime() + 2 * H),
  });
  await upsertSubmission(
    db,
    { assignmentId: lagging.id, state: "turned_in", turnedInAt: ago(30), hash: "l", payload: {} },
    ago(30),
  );

  const turnedIn = async (title: string, at: Date, accountId = one.id, courseId = course.id) => {
    const a = await assignment(accountId, courseId, title, { status: "turned_in" });
    const { version } = await upsertSubmission(
      db,
      { assignmentId: a.id, state: "turned_in", turnedInAt: at, hash: title, payload: {} },
      at,
    );
    if (!version) throw new Error("seed failed");
    return version.id;
  };
  const reviewed = await turnedIn("Essay", ago(2));
  await addCheckResult(
    db,
    {
      submissionVersionId: reviewed,
      source: "heuristic",
      verdict: "ok",
      findings: { signals: [] },
    },
    ago(2),
  );
  await addCheckResult(
    db,
    {
      submissionVersionId: reviewed,
      source: "llm:fake",
      verdict: "warn",
      findings: { output: { summaryForParent: "Task 3 is missing." } },
    },
    ago(1),
  );
  const heuristicOnly = await turnedIn("Drawing", ago(3), two.id, course2.id);
  await addCheckResult(
    db,
    { submissionVersionId: heuristicOnly, source: "heuristic", verdict: "warn", findings: {} },
    ago(3),
  );
  await turnedIn("Poem", ago(4));
  await turnedIn("Old essay", ago(50));
  const otherVersion = await turnedIn("Unwatched work", ago(1), unwatched.id, course3.id);

  await raiseAlert(
    db,
    { key: `deadline:${late.id}:due_soon`, level: "panic", message: "Due in 5h: Fractions" },
    ago(1),
  );
  await raiseAlert(
    db,
    { key: `quality:${reviewed}`, level: "alert", message: "Take a look: Essay" },
    ago(1),
  );
  await raiseAlert(
    db,
    {
      key: `deadline:${late.id}:no_due_date:2026-W41`,
      level: "info",
      message: "No due date: Fractions",
    },
    ago(2),
  );
  const old = await raiseAlert(
    db,
    { key: `quality:${heuristicOnly}`, level: "alert", message: "Old sent alert" },
    ago(48),
  );
  await db.alert.update({ where: { id: old.alert.id }, data: { sentAt: ago(47) } });
  await raiseAlert(
    db,
    { key: `quality:${heuristicOnly}:llm-failed`, level: "alert", message: "Unsent old alert" },
    ago(100),
  );
  await raiseAlert(
    db,
    { key: "parse-drift:todo", level: "panic", message: "Parser drift" },
    ago(1),
  );
  await raiseAlert(
    db,
    { key: `quality:${otherVersion}`, level: "alert", message: "Unwatched alert" },
    ago(1),
  );
}

describe("helpers", () => {
  it("labels accounts without real data", () => {
    expect(accountLabel({ email: "kid@school.example", displayName: "Kid" })).toBe("Kid");
    expect(accountLabel({ email: "kid@school.example", displayName: "  " })).toBe("kid");
    expect(accountLabel({ email: "kid@school.example", displayName: null })).toBe("kid");
  });

  it("parses alert keys", () => {
    expect(parseAlertKey("deadline:12:due_soon")).toEqual({ kind: "deadline", assignmentId: 12 });
    expect(parseAlertKey("quality:7:llm-failed")).toEqual({ kind: "quality", versionId: 7 });
    expect(parseAlertKey("comment:5")).toEqual({ kind: "comment", commentId: 5 });
    expect(parseAlertKey("quality:x")).toBeNull();
    expect(parseAlertKey("parse-drift:1")).toBeNull();
  });

  it("formats relative times", () => {
    expect(formatIn(45 * 60_000)).toBe("in 45m");
    expect(formatIn(5 * H)).toBe("in 5h");
    expect(formatIn(72 * H)).toBe("in 3d");
  });
});

describe("report", () => {
  it("groups the last 24h per watched account", async () => {
    await seed();
    const report = await buildReport(db, {
      now: NOW,
      watchedEmails: ["student-two@school.example"],
    });
    expect(report.accounts.map((a) => a.label)).toEqual(["Student One", "student-two"]);
    const [one, two] = report.accounts;

    expect(one?.panics.map((a) => a.message)).toEqual(["Due in 5h: Fractions"]);
    expect(one?.alerts.map((a) => a.message)).toEqual(["Take a look: Essay"]);
    expect(one?.info.map((a) => a.message)).toEqual(["No due date: Fractions"]);
    expect(one?.turnedIn).toEqual([
      expect.objectContaining({
        title: "Essay",
        verdict: "warn",
        basis: "llm",
        summary: "Task 3 is missing.",
      }),
      expect.objectContaining({ title: "Poem", verdict: "pending", basis: "none" }),
    ]);
    expect(one?.upcoming.map((u) => u.title)).toEqual(["Fractions", "Geometry"]);

    // Old sent alert is out of the window; an unsent one stays until Telegram sends it.
    expect(two?.alerts.map((a) => a.message)).toEqual(["Unsent old alert"]);
    expect(two?.turnedIn).toEqual([
      expect.objectContaining({ title: "Drawing", verdict: "warn", basis: "heuristic" }),
    ]);
    expect(report.other.map((a) => a.message)).toEqual(["Parser drift", "Unwatched alert"]);

    const text = formatReport(report, { timeZone: TZ });
    expect(text).toMatchInlineSnapshot(`
      "Classroom report · Sat 10 Oct, 12:00 · since Fri 09 Oct, 12:00

      == Student One ==
      🔴 Panics
        • Due in 5h: Fractions  [Sat 10 Oct, 11:00]
      🟠 Alerts
        • Take a look: Essay  [Sat 10 Oct, 11:00]
      📥 Turned in
        • "Essay" (Math) · Sat 10 Oct, 10:00 · 🟠 warn
            Task 3 is missing.
        • "Poem" (Math) · Sat 10 Oct, 08:00 · ⏳ not reviewed yet
      📅 Due in the next 7 days
        • Sat 10 Oct, 17:00 (in 5h)  "Fractions" (Math)
        • Tue 13 Oct, 12:00 (in 3d)  "Geometry" (Math)
      ℹ️  Info
        • No due date: Fractions  [Sat 10 Oct, 10:00]

      == student-two ==
      🟠 Alerts
        • Unsent old alert  [Tue 06 Oct, 08:00]
      📥 Turned in
        • "Drawing" (Art) · Sat 10 Oct, 09:00 · 🟠 warn (heuristics only)

      == Other ==
        • Parser drift  [Sat 10 Oct, 11:00]
        • Unwatched alert  [Sat 10 Oct, 11:00]"
    `);
  });

  it("shows everything with --all and a custom window", async () => {
    await seed();
    const all = await buildReport(db, { now: NOW, since: null });
    const one = all.accounts.find((a) => a.label === "Student One");
    expect(one?.turnedIn.map((t) => t.title)).toEqual(["Essay", "Poem", "Lagging", "Old essay"]);
    expect(all.other.map((a) => a.message)).toContain("Old sent alert");
    expect(formatReport(all, { timeZone: TZ })).toContain("· everything");

    const narrow = await buildReport(db, { now: NOW, since: ago(2.5) });
    expect(narrow.accounts[0]?.turnedIn.map((t) => t.title)).toEqual(["Essay"]);
  });

  it("restricts to given alerts for the run digest", async () => {
    await seed();
    const ids = (await db.alert.findMany({ where: { level: "panic" } })).map((a) => a.id);
    const report = await buildReport(db, { now: NOW, alertIds: ids });
    const text = formatReport(report, { timeZone: TZ });
    expect(text).toContain("· new alerts");
    expect(text).toContain("Due in 5h: Fractions");
    expect(text).toContain("Parser drift");
    expect(text).not.toContain("Turned in");
    expect(text).not.toContain("Take a look");
  });

  it("lists 'check by hand' items in their own section, once per version", async () => {
    await seed();
    const versionOf = async (title: string) =>
      (
        await db.submissionVersion.findFirstOrThrow({
          where: { submission: { assignment: { title } } },
        })
      ).id;
    const poem = await versionOf("Poem");
    const essay = await versionOf("Essay");
    const item = { what: '"reading.mp3"', why: "audio recording: needs listening" };
    await addCheckResult(
      db,
      {
        submissionVersionId: poem,
        source: "llm:fake",
        verdict: "unchecked",
        findings: { unchecked: [item] },
      },
      ago(0.5),
    );
    await raiseAlert(
      db,
      {
        key: `quality:${poem}:unchecked`,
        level: "info",
        message: 'Check by hand: "Poem" (Math): "reading.mp3": audio recording: needs listening',
      },
      ago(0.5),
    );
    // Essay already has a warn alert: its unchecked parts are listed there, not again here.
    await raiseAlert(
      db,
      { key: `quality:${essay}:unchecked`, level: "info", message: "Check by hand: Essay" },
      ago(0.5),
    );
    await addCheckResult(
      db,
      {
        submissionVersionId: essay,
        source: "llm:fake",
        verdict: "ok",
        findings: { output: { summaryForParent: "Done." }, unchecked: [item, item] },
      },
      ago(0.5),
    );

    const report = await buildReport(db, { now: NOW });
    const one = report.accounts[0];
    expect(one?.checkByHand.map((a) => a.message)).toEqual([
      'Check by hand: "Poem" (Math): "reading.mp3": audio recording: needs listening',
    ]);
    expect(one?.info.map((a) => a.message)).toEqual(["No due date: Fractions"]);
    expect(one?.turnedIn).toEqual([
      expect.objectContaining({ title: "Essay", verdict: "ok", unchecked: 2 }),
      expect.objectContaining({ title: "Poem", verdict: "unchecked", unchecked: 1 }),
    ]);
    const text = formatReport(report, { timeZone: TZ });
    expect(text).toContain(
      '"Essay" (Math) · Sat 10 Oct, 10:00 · ✅ ok · 🔍 2 parts not checked automatically',
    );
    expect(text).toContain('"Poem" (Math) · Sat 10 Oct, 08:00 · 🔍 not checked automatically\n');
    expect(text).toContain(
      '🔍 Check by hand\n  • Check by hand: "Poem" (Math): "reading.mp3": audio recording: needs listening',
    );
    expect(text).not.toContain("Check by hand: Essay");

    const ids = (await db.alert.findMany({ where: { key: `quality:${poem}:unchecked` } })).map(
      (a) => a.id,
    );
    const digest = await buildReport(db, { now: NOW, alertIds: ids });
    expect(reportHasAlerts(digest)).toBe(true);
    expect(formatReport(digest, { timeZone: TZ })).toContain("🔍 Check by hand");
  });

  it("adds an open debts block, leaving out debts whose alert is already listed", async () => {
    await seed();
    const past = await db.assignment.findFirstOrThrow({ where: { title: "Past" } });
    const fractions = await db.assignment.findFirstOrThrow({ where: { title: "Fractions" } });
    // "Past" went missing 5h ago: a debt; its panic was sent and is out of a 1h window.
    const missing = await raiseAlert(
      db,
      { key: `deadline:${past.id}:missing`, level: "panic", message: "Missing: Past" },
      ago(5),
    );
    await db.alert.update({ where: { id: missing.alert.id }, data: { sentAt: ago(5) } });
    // An old overdue item (posted before the forget window) is forgotten.
    await db.assignment.update({
      where: { id: fractions.id },
      data: { dueAt: new Date(NOW.getTime() - 20 * 24 * H) },
    });

    const report = await buildReport(db, { now: NOW, since: ago(1), backlog: { forgetDays: 14 } });
    const one = report.accounts[0];
    expect(one?.backlog.map((d) => [d.kind, d.title, d.alertId])).toEqual([
      ["missing", "Past", missing.alert.id],
    ]);
    const text = formatReport(report, { timeZone: TZ });
    expect(text).toContain(
      `📌 Open debts\n  • ⏰ not turned in: "Past" (Math) · today · #${missing.alert.id}\n      https://classroom.google.com/c/`,
    );

    // In a wider window the panic itself is listed, so the debt isn't repeated.
    const wide = await buildReport(db, { now: NOW, since: ago(24), backlog: { forgetDays: 14 } });
    expect(wide.accounts[0]?.panics.map((a) => a.message)).toContain("Missing: Past");
    expect(wide.accounts[0]?.backlog).toEqual([]);
    // Without the option there's no backlog at all.
    expect((await buildReport(db, { now: NOW, since: ago(1) })).accounts[0]?.backlog).toEqual([]);
  });

  it("says so when nothing is watched", async () => {
    const text = formatReport(await buildReport(db, { now: NOW }), { timeZone: TZ });
    expect(text).toContain("No watched accounts");
  });
});
