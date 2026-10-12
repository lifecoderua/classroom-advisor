import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { autoAck, countAutoClosed, supersedeAlerts } from "../../src/checks/auto-ack.ts";
import { loadBacklog } from "../../src/checks/backlog.ts";
import { buildReport, formatReport } from "../../src/notify/console.ts";
import {
  addCheckResult,
  type Db,
  raiseAlert,
  upsertAccount,
  upsertAssignment,
  upsertComment,
  upsertCourse,
  upsertSubmission,
} from "../../src/store/index.ts";
import { migratedTemplate } from "../store/helpers.ts";

const NOW = new Date("2026-10-10T12:00:00Z");
const H = 3_600_000;
const ago = (h: number) => new Date(NOW.getTime() - h * H);

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
  const course = await upsertCourse(db, { accountId: kid.id, classroomId: "1", name: "Math" });
  let n = 0;
  const assignment = async (title: string, dueAt: Date | null = ago(30)) =>
    (
      await upsertAssignment(
        db,
        {
          accountId: kid.id,
          courseId: course.id,
          classroomId: String(100 + n++),
          kind: "assignment",
          title,
          status: "assigned",
          dueAt,
          hash: title,
          payload: {},
        },
        ago(100),
      )
    ).assignment;
  const alert = async (key: string, level: "panic" | "alert" | "info", at: Date) =>
    (await raiseAlert(db, { key, level, message: key }, at)).alert;
  const turnIn = async (
    assignmentId: number,
    at: Date,
    opts: { files?: number; state?: string; grade?: string; hash?: string } = {},
  ) => {
    await db.assignment.update({ where: { id: assignmentId }, data: { status: "turned_in" } });
    const { version } = await upsertSubmission(
      db,
      {
        assignmentId,
        state: opts.state ?? "turned_in",
        turnedInAt: at,
        grade: opts.grade ?? null,
        hash: opts.hash ?? `s${at.getTime()}`,
        payload: {
          turnedInAt: at.toISOString(),
          attachments: Array.from({ length: opts.files ?? 1 }, (_, i) => ({ title: `f${i}` })),
        },
      },
      at,
    );
    if (!version) throw new Error("seed failed");
    return version;
  };
  const review = (versionId: number, verdict: "ok" | "warn", at: Date) =>
    addCheckResult(
      db,
      { submissionVersionId: versionId, source: "llm:fake", verdict, findings: {} },
      at,
    );
  const state = async (id: number) =>
    db.alert.findUniqueOrThrow({
      where: { id },
      select: { mutedAt: true, muteReason: true, sentAt: true },
    });
  return { kid, assignment, alert, turnIn, review, state };
}

describe("autoAck", () => {
  it("closes deadline alerts once the work is turned in with files and reviewed ok", async () => {
    const s = await setup();
    const a = await s.assignment("Fractions");
    const missing = await s.alert(`deadline:${a.id}:missing`, "panic", ago(30));
    const untouched = await s.alert(`deadline:${a.id}:untouched_24h`, "alert", ago(40));
    await db.alert.update({ where: { id: untouched.id }, data: { sentAt: ago(30) } });
    expect(await loadBacklog(db, { now: NOW, forgetDays: 14 })).toHaveLength(1);

    const v = await s.turnIn(a.id, ago(5));
    expect(await autoAck(db, NOW)).toEqual([]); // turned in, not reviewed yet
    await s.review(v.id, "ok", ago(4));
    expect((await autoAck(db, NOW)).sort()).toEqual([missing.id, untouched.id].sort());
    expect(await s.state(missing.id)).toEqual({ mutedAt: NOW, muteReason: "auto", sentAt: NOW });
    // Unsent ones never go out; already-sent ones keep their sentAt.
    expect((await s.state(untouched.id)).sentAt).toEqual(ago(30));
    expect(await loadBacklog(db, { now: NOW, forgetDays: 14 })).toEqual([]);
    expect(await autoAck(db, NOW)).toEqual([]); // idempotent
  });

  it("leaves alerts alone for a warn, for no files, and never mutes a newer alert", async () => {
    const s = await setup();
    const warned = await s.assignment("Warned");
    const w = await s.alert(`deadline:${warned.id}:missing`, "panic", ago(30));
    await s.review((await s.turnIn(warned.id, ago(5))).id, "warn", ago(4));

    const empty = await s.assignment("Empty");
    const e = await s.alert(`deadline:${empty.id}:missing`, "panic", ago(30));
    await s.review((await s.turnIn(empty.id, ago(5), { files: 0 })).id, "ok", ago(4));

    const late = await s.assignment("Late alert");
    await s.review((await s.turnIn(late.id, ago(5))).id, "ok", ago(4));
    const newer = await s.alert(`deadline:${late.id}:no_due_date:2026-W41`, "info", ago(1));

    expect(await autoAck(db, NOW)).toEqual([]);
    for (const id of [w.id, e.id, newer.id]) expect((await s.state(id)).mutedAt).toBeNull();
  });

  it("treats returned or graded work as resolved", async () => {
    const s = await setup();
    const returned = await s.assignment("Returned");
    const r = await s.alert(`deadline:${returned.id}:missing`, "panic", ago(30));
    await s.turnIn(returned.id, ago(5), { state: "returned", files: 0 });
    const graded = await s.assignment("Graded");
    const g = await s.alert(`deadline:${graded.id}:untouched_24h`, "alert", ago(30));
    await s.turnIn(graded.id, ago(5), { grade: "10", files: 0 });
    expect((await autoAck(db, NOW)).sort()).toEqual([r.id, g.id].sort());
  });

  it("closes a redo request redone and reviewed ok, and older versions' quality alerts", async () => {
    const s = await setup();
    const a = await s.assignment("Essay", null);
    const v1 = await s.turnIn(a.id, ago(50));
    await s.review(v1.id, "warn", ago(49));
    const warn = await s.alert(`quality:${v1.id}`, "alert", ago(49));
    const { comment } = await upsertComment(
      db,
      {
        assignmentId: a.id,
        classroomId: "c1",
        authorRole: "teacher",
        text: "Переробіть",
        postedAt: ago(40),
        baseline: false,
      },
      ago(40),
    );
    const redo = await s.alert(`comment:${comment.id}`, "panic", ago(40));
    const v2 = await s.turnIn(a.id, ago(10), { hash: "v2" });
    const byHand = await s.alert(`quality:${v2.id}:unchecked`, "info", ago(9));
    await s.review(v2.id, "ok", ago(9));
    // A teacher comment after the new turn-in is news, not a resolved request.
    const { comment: later } = await upsertComment(
      db,
      {
        assignmentId: a.id,
        classroomId: "c2",
        authorRole: "teacher",
        text: "Дякую",
        postedAt: ago(2),
        baseline: false,
      },
      ago(2),
    );
    const thanks = await s.alert(`comment:${later.id}`, "alert", ago(2));

    expect((await autoAck(db, NOW)).sort()).toEqual([warn.id, redo.id].sort());
    expect((await s.state(byHand.id)).mutedAt).toBeNull(); // the latest version's own item
    expect((await s.state(thanks.id)).mutedAt).toBeNull();
  });

  it("supersedes every alert of a replaced turn-in, but not after a grade-only change", async () => {
    const s = await setup();
    const a = await s.assignment("Essay", null);
    const v1 = await s.turnIn(a.id, ago(50), { hash: "v1" });
    const warn = await s.alert(`quality:${v1.id}`, "alert", ago(49));
    const byHand = await s.alert(`quality:${v1.id}:c3:unchecked`, "info", ago(48));
    const v2 = await s.turnIn(a.id, ago(10), { hash: "v2" });
    const latest = await s.alert(`quality:${v2.id}`, "alert", ago(9));
    expect((await supersedeAlerts(db, NOW)).sort()).toEqual([warn.id, byHand.id].sort());
    expect(await s.state(warn.id)).toMatchObject({ muteReason: "superseded", sentAt: NOW });
    expect((await s.state(latest.id)).mutedAt).toBeNull();

    // Same turn-in, only graded afterwards: a new version, but nothing to supersede.
    const b = await s.assignment("Poem", null);
    const w1 = await s.turnIn(b.id, ago(20), { hash: "p1" });
    const poemWarn = await s.alert(`quality:${w1.id}`, "alert", ago(19));
    await s.turnIn(b.id, ago(20), { hash: "p2", grade: "9" });
    expect(await supersedeAlerts(db, NOW)).toEqual([]);
    expect((await s.state(poemWarn.id)).mutedAt).toBeNull();
  });

  it("counts closed alerts in the report and the digest", async () => {
    const s = await setup();
    const a = await s.assignment("Fractions");
    await s.alert(`deadline:${a.id}:missing`, "panic", ago(30));
    await s.review((await s.turnIn(a.id, ago(5))).id, "ok", ago(4));
    await autoAck(db, NOW);
    expect(await countAutoClosed(db, ago(1))).toBe(1);

    const report = await buildReport(db, { now: NOW, since: ago(24), autoClosedSince: ago(24) });
    expect(report.autoClosed).toBe(1);
    const text = formatReport(report, { lang: "en", timeZone: "UTC" });
    expect(text).toContain("✔️ Closed automatically: 1");
    expect(formatReport(report, { lang: "uk", timeZone: "UTC" })).toContain(
      "✔️ Закрито автоматично: 1",
    );
    const all = formatReport(await buildReport(db, { now: NOW, since: null }), {
      lang: "en",
      timeZone: "UTC",
    });
    expect(all).toContain(`deadline:${a.id}:missing (closed automatically)`);
  });
});
