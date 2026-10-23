import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { findRecheckTarget, parseClassroomLink } from "../../src/checks/recheck.ts";
import { detailsUrl } from "../../src/collector/classroom/todo.ts";
import { FakeProvider } from "../../src/llm/index.ts";
import { runCycle, type SyncFn } from "../../src/run/cycle.ts";
import {
  type Db,
  raiseAlert,
  upsertAccount,
  upsertAssignment,
  upsertCourse,
  upsertSubmission,
} from "../../src/store/index.ts";
import { migratedTemplate } from "../store/helpers.ts";

const NOW = new Date("2026-10-10T12:00:00Z");

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
  const kid = await upsertAccount(db, { email: "student-one@school.example" });
  await db.account.update({ where: { id: kid.id }, data: { watched: true } });
  const course = await upsertCourse(db, { accountId: kid.id, classroomId: "111", name: "Math" });
  const item = async (classroomId: string, title: string) =>
    (
      await upsertAssignment(db, {
        accountId: kid.id,
        courseId: course.id,
        classroomId,
        kind: "assignment",
        title,
        status: "assigned",
        hash: title,
        payload: { instructions: "Write an essay." },
      })
    ).assignment;
  const essay = await item("222", "Essay");
  const { version } = await upsertSubmission(
    db,
    {
      assignmentId: essay.id,
      state: "turned_in",
      turnedInAt: NOW,
      hash: "s",
      payload: { attachments: [{ title: "essay.docx" }] },
    },
    NOW,
  );
  if (!version) throw new Error("seed failed");
  const draft = await item("333", "Draft");
  return { essay, draft, versionId: version.id };
}

const warn = (summary: string) =>
  new FakeProvider({
    respond: {
      verdict: "warn",
      addressesAssignment: true,
      missingParts: [],
      issues: [],
      summaryForParent: summary,
      confidence: 0.8,
      unverifiable: [],
    },
  });

describe("recheck targets", () => {
  it("parses a Classroom details link back to its ids", () => {
    const url = detailsUrl("615478392011", "702233445566", "assignment", "kid@school.example");
    expect(parseClassroomLink(url)).toEqual({ courseId: "615478392011", itemId: "702233445566" });
    expect(parseClassroomLink(`see ${url.replace("https://", "")} please`)).not.toBeNull();
    expect(parseClassroomLink("https://example.com/c/abc")).toBeNull();
  });

  it("finds an assignment by id or link; tells whether there is work to check", async () => {
    const { essay, draft } = await seed();
    expect(await findRecheckTarget(db, String(essay.id))).toMatchObject({
      assignmentId: essay.id,
      title: "Essay",
      course: "Math",
      turnedIn: true,
    });
    const link = detailsUrl("111", "333", "assignment", "student-one@school.example");
    expect(await findRecheckTarget(db, link)).toMatchObject({
      assignmentId: draft.id,
      turnedIn: false,
    });
    expect(await findRecheckTarget(db, "99999")).toBeNull();
    expect(await findRecheckTarget(db, "hello")).toBeNull();
  });
});

describe("runCycle with rechecks", () => {
  it("re-fetches through sync, reviews again as a new result and supersedes the old alert", async () => {
    const { essay, versionId } = await seed();
    const old = await raiseAlert(
      db,
      { key: `quality:${versionId}`, level: "alert", message: "old warn" },
      NOW,
    );
    await db.checkResult.create({
      data: {
        submissionVersionId: versionId,
        source: "llm:fake",
        verdict: "warn",
        findings: "{}",
        createdAt: NOW,
      },
    });
    const forced: (readonly number[] | undefined)[] = [];
    const sync: SyncFn = async ({ force }) => {
      forced.push(force);
    };
    const provider = warn("Task 2 is still missing.");
    const later = new Date(NOW.getTime() + 3_600_000);
    const res = await runCycle({
      db,
      sync,
      provider,
      readText: async () => undefined,
      now: () => later,
      log: () => undefined,
      recheck: [essay.id, essay.id],
    });
    expect(forced).toEqual([[essay.id]]);
    expect(provider.calls).toHaveLength(1);
    expect(res.rechecked).toEqual([
      expect.objectContaining({
        assignmentId: essay.id,
        status: "reviewed",
        verdict: "warn",
        content: expect.objectContaining({ code: "quality.review" }),
      }),
    ]);
    expect(await db.checkResult.count({ where: { source: "llm:fake" } })).toBe(2);
    const alerts = await db.alert.findMany({ orderBy: { id: "asc" } });
    expect(alerts.map((a) => [a.key, a.muteReason])).toEqual([
      [old.alert.key, "superseded"],
      [`quality:${versionId}:r1`, null],
    ]);
    expect(res.newAlertIds).toEqual([alerts[1]?.id]);
  });

  it("returns the review summary with an ok verdict's check-by-hand alert", async () => {
    const { essay } = await seed();
    const provider = new FakeProvider({
      respond: {
        verdict: "ok",
        addressesAssignment: true,
        missingParts: [],
        issues: [],
        summaryForParent: "Part 3 is done: all questions answered.",
        confidence: 0.8,
        unverifiable: [{ what: "Part 1", why: "oral" }],
      },
    });
    const res = await runCycle({
      db,
      sync: async () => undefined,
      provider,
      readText: async () => "My essay text.",
      now: () => NOW,
      log: () => undefined,
      recheck: [essay.id],
    });
    expect(res.rechecked).toEqual([
      expect.objectContaining({
        status: "reviewed",
        verdict: "ok",
        content: expect.objectContaining({ code: "quality.unchecked" }),
        summary: "Part 3 is done: all questions answered.",
      }),
    ]);
  });

  it("answers 'not turned in' for an item without work", async () => {
    const { draft } = await seed();
    const res = await runCycle({
      db,
      sync: async () => undefined,
      provider: warn("x"),
      readText: async () => undefined,
      now: () => NOW,
      log: () => undefined,
      recheck: [draft.id],
    });
    expect(res.rechecked).toEqual([
      expect.objectContaining({ assignmentId: draft.id, status: "not_turned_in" }),
    ]);
  });
});
