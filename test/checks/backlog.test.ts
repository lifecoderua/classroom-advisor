import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ackKeepsDebt, debtAgeDays, loadBacklog } from "../../src/checks/backlog.ts";
import {
  type Db,
  muteAlert,
  raiseAlert,
  upsertAccount,
  upsertAssignment,
  upsertComment,
  upsertCourse,
  upsertSubmission,
} from "../../src/store/index.ts";
import { migratedTemplate } from "../store/helpers.ts";

const NOW = new Date("2026-10-10T12:00:00Z");
const DAY = 86_400_000;
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY);

let template: ReturnType<typeof migratedTemplate>;
let db: Db;

beforeAll(() => {
  template = migratedTemplate();
}, 60_000);
afterAll(() => template.cleanup());
beforeEach(async () => {
  db = await template.fresh();
});

async function setup() {
  const kid = await upsertAccount(db, { email: "student-one@school.example" });
  await db.account.update({ where: { id: kid.id }, data: { watched: true } });
  const other = await upsertAccount(db, { email: "parent@school.example" });
  const course = await upsertCourse(db, { accountId: kid.id, classroomId: "111", name: "Math" });
  const otherCourse = await upsertCourse(db, {
    accountId: other.id,
    classroomId: "999",
    name: "Other",
  });
  let n = 0;
  const assignment = async (
    title: string,
    extra: {
      dueAt?: Date | null;
      postedAt?: Date | null;
      status?: string;
      baseline?: boolean;
      kind?: "assignment" | "material";
      accountId?: number;
      courseId?: number;
    } = {},
  ) =>
    (
      await upsertAssignment(
        db,
        {
          accountId: extra.accountId ?? kid.id,
          courseId: extra.courseId ?? course.id,
          classroomId: String(200 + n++),
          kind: extra.kind ?? "assignment",
          title,
          status: extra.status ?? "assigned",
          dueAt: extra.dueAt ?? null,
          postedAt: extra.postedAt ?? null,
          baseline: extra.baseline ?? false,
          hash: title,
          payload: {},
        },
        daysAgo(30),
      )
    ).assignment;
  const missingAlert = async (assignmentId: number, at: Date) =>
    (
      await raiseAlert(
        db,
        { key: `deadline:${assignmentId}:missing`, level: "panic", message: "Missing" },
        at,
      )
    ).alert;
  const submit = async (assignmentId: number, at: Date, hash = "s") => {
    const { version } = await upsertSubmission(
      db,
      { assignmentId, state: "turned_in", turnedInAt: at, hash, payload: {} },
      at,
    );
    if (!version) throw new Error("seed failed");
    return version;
  };
  const teacherSays = async (assignmentId: number, text: string, at: Date, baseline = false) => {
    const { comment } = await upsertComment(
      db,
      {
        assignmentId,
        classroomId: `c${n++}`,
        authorRole: "teacher",
        text,
        postedAt: at,
        baseline,
      },
      at,
    );
    const { alert } = await raiseAlert(
      db,
      { key: `comment:${comment.id}`, level: "panic", message: text },
      at,
    );
    return alert;
  };
  return { kid, other, course, otherCourse, assignment, missingAlert, submit, teacherSays };
}

describe("loadBacklog", () => {
  it("lists missing work with its age, link and ack id; forgets old and baseline items", async () => {
    const s = await setup();
    const overdue = await s.assignment("Fractions", { dueAt: daysAgo(3) });
    const alert = await s.missingAlert(overdue.id, daysAgo(3));
    const old = await s.assignment("Old", { dueAt: daysAgo(20) });
    await s.missingAlert(old.id, daysAgo(20));
    // Baseline item marked missing without a due date, posted long ago: old news.
    await s.assignment("Baseline old", {
      status: "missing",
      postedAt: daysAgo(60),
      baseline: true,
    });
    // Baseline item that went past due recently: still a debt.
    const recentBaseline = await s.assignment("Baseline recent", {
      dueAt: daysAgo(2),
      baseline: true,
    });
    // Marked missing without a due date: counts from the alert.
    const flagged = await s.assignment("Flagged", { status: "missing" });
    await s.missingAlert(flagged.id, daysAgo(1));
    // Not debts: turned in late, excused, a material, due later, another account.
    const late = await s.assignment("Late", { dueAt: daysAgo(4) });
    await s.submit(late.id, daysAgo(1));
    await s.assignment("Excused", { dueAt: daysAgo(4), status: "excused" });
    await s.assignment("Reading", { dueAt: daysAgo(4), kind: "material" });
    await s.assignment("Later", { dueAt: new Date(NOW.getTime() + DAY) });
    await s.assignment("Theirs", {
      dueAt: daysAgo(1),
      accountId: s.other.id,
      courseId: s.otherCourse.id,
    });

    const debts = await loadBacklog(db, { now: NOW, forgetDays: 14 });
    expect(debts.map((d) => [d.kind, d.title])).toEqual([
      ["missing", "Fractions"],
      ["missing", "Baseline recent"],
      ["missing", "Flagged"],
    ]);
    const [first] = debts;
    expect(first).toMatchObject({
      accountId: s.kid.id,
      assignmentId: overdue.id,
      courseName: "Math",
      since: daysAgo(3),
      alertId: alert.id,
    });
    expect(first?.url).toContain("authuser=student-one%40school.example");
    expect(debtAgeDays(first as NonNullable<typeof first>, NOW)).toBe(3);
    expect(debts.find((d) => d.assignmentId === recentBaseline.id)?.alertId).toBeNull();

    // A wider window brings the old one back.
    const wide = await loadBacklog(db, { now: NOW, forgetDays: 30 });
    expect(wide.map((d) => d.title)).toContain("Old");
  });

  it("keeps a missing debt after its alert is acked, until the work is turned in", async () => {
    const s = await setup();
    const overdue = await s.assignment("Fractions", { dueAt: daysAgo(3) });
    const alert = await s.missingAlert(overdue.id, daysAgo(3));
    expect(await loadBacklog(db, { now: NOW, forgetDays: 14 })).toEqual([
      expect.objectContaining({ kind: "missing", alertId: alert.id, muted: false }),
    ]);
    await muteAlert(db, alert.id, NOW);
    expect(await loadBacklog(db, { now: NOW, forgetDays: 14 })).toEqual([
      expect.objectContaining({ kind: "missing", alertId: alert.id, muted: true }),
    ]);
    // Turned in: resolved by state.
    await s.submit(overdue.id, NOW);
    expect(await loadBacklog(db, { now: NOW, forgetDays: 14 })).toEqual([]);
  });

  it("keeps a redo debt after its alert is acked", async () => {
    const s = await setup();
    const essay = await s.assignment("Essay");
    await s.submit(essay.id, daysAgo(5));
    const ask = await s.teacherSays(essay.id, "Переробіть, будь ласка", daysAgo(4));
    await muteAlert(db, ask.id, NOW);
    expect(await loadBacklog(db, { now: NOW, forgetDays: 14 })).toEqual([
      expect.objectContaining({ kind: "redo", alertId: ask.id, muted: true }),
    ]);
    await s.submit(essay.id, daysAgo(0.5), "s2");
    expect(await loadBacklog(db, { now: NOW, forgetDays: 14 })).toEqual([]);
  });

  it("tells which acked alerts keep their debt", () => {
    expect(ackKeepsDebt("deadline:12:missing")).toBe(true);
    expect(ackKeepsDebt("comment:7")).toBe(true);
    expect(ackKeepsDebt("deadline:12:due_soon")).toBe(false);
    expect(ackKeepsDebt("quality:3:unchecked")).toBe(false);
  });

  it("keeps an open redo request until the work is turned in again", async () => {
    const s = await setup();
    const essay = await s.assignment("Essay", { dueAt: daysAgo(1) });
    await s.submit(essay.id, daysAgo(5));
    const ask = await s.teacherSays(essay.id, "Переробіть, будь ласка", daysAgo(4));
    // Also past due and "returned" by the teacher: one line, as a redo request.
    await db.submission.update({ where: { assignmentId: essay.id }, data: { state: "returned" } });
    await db.assignment.update({ where: { id: essay.id }, data: { status: "missing" } });
    await s.missingAlert(essay.id, daysAgo(1));

    let debts = await loadBacklog(db, { now: NOW, forgetDays: 14 });
    expect(debts).toEqual([
      expect.objectContaining({ kind: "redo", title: "Essay", since: daysAgo(4), alertId: ask.id }),
    ]);

    // Turned in again after the request: resolved (and no longer missing).
    await db.assignment.update({ where: { id: essay.id }, data: { status: "turned_in" } });
    await s.submit(essay.id, daysAgo(0.5), "s2");
    debts = await loadBacklog(db, { now: NOW, forgetDays: 14 });
    expect(debts).toEqual([]);
  });

  it("ignores redo requests superseded by a later teacher comment, baseline ones and old ones", async () => {
    const s = await setup();
    const a = await s.assignment("A");
    await s.teacherSays(a.id, "Додай фото", daysAgo(3));
    await s.teacherSays(a.id, "Дякую, зараховано", daysAgo(2));
    const b = await s.assignment("B");
    await s.teacherSays(b.id, "Redo task 2", daysAgo(3), true);
    const c = await s.assignment("C");
    await s.teacherSays(c.id, "Redo task 2", daysAgo(20));
    const d = await s.assignment("D");
    await s.teacherSays(d.id, "Redo task 2", daysAgo(2));
    const debts = await loadBacklog(db, { now: NOW, forgetDays: 14 });
    expect(debts.map((x) => [x.kind, x.title])).toEqual([["redo", "D"]]);
  });

  it("lists 'check by hand' items of the latest turned-in version until acked (ack drops them)", async () => {
    const s = await setup();
    const poem = await s.assignment("Poem");
    const v1 = await s.submit(poem.id, daysAgo(3));
    const byHand = await raiseAlert(
      db,
      { key: `quality:${v1.id}:unchecked`, level: "info", message: "Check by hand" },
      daysAgo(3),
    );
    const song = await s.assignment("Song");
    const v2 = await s.submit(song.id, daysAgo(3));
    await raiseAlert(
      db,
      { key: `quality:${v2.id}:unchecked`, level: "info", message: "Check by hand" },
      daysAgo(3),
    );
    // A newer version of Song supersedes its old item.
    await s.submit(song.id, daysAgo(1), "s2");

    let debts = await loadBacklog(db, { now: NOW, forgetDays: 14 });
    expect(debts).toEqual([
      expect.objectContaining({ kind: "unchecked", title: "Poem", alertId: byHand.alert.id }),
    ]);
    await muteAlert(db, byHand.alert.id, NOW);
    debts = await loadBacklog(db, { now: NOW, forgetDays: 14 });
    expect(debts).toEqual([]);
  });
});
