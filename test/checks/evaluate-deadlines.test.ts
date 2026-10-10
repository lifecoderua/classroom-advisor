import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { evaluateDeadlines, loadDeadlineInputs } from "../../src/checks/evaluate-deadlines.ts";
import {
  type AssignmentInput,
  type Db,
  listUnsentAlerts,
  setWatchedAccounts,
  syncAttachments,
  upsertAccount,
  upsertAssignment,
  upsertCourse,
  upsertSubmission,
} from "../../src/store/index.ts";
import { migratedTemplate } from "../store/helpers.ts";

const T0 = new Date("2026-10-01T08:00:00Z");
const NOW = new Date("2026-10-03T08:00:00Z");

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
  const account = await upsertAccount(db, { email: "student-one@school.example" });
  await setWatchedAccounts(db, [account.email]);
  const course = await upsertCourse(db, { accountId: account.id, classroomId: "c1", name: "Math" });
  const add = async (classroomId: string, extra: Partial<AssignmentInput> = {}) => {
    const input: AssignmentInput = {
      accountId: account.id,
      courseId: course.id,
      classroomId,
      kind: "assignment",
      title: classroomId,
      postedAt: T0,
      status: "assigned",
      hash: classroomId,
      payload: {},
      ...extra,
    };
    return (await upsertAssignment(db, input, T0)).assignment;
  };
  return { add };
}

describe("evaluateDeadlines", () => {
  it("raises deduped alerts for open assignments", async () => {
    const { add } = await seed();
    const untouched = await add("untouched", { dueAt: new Date("2026-10-08T00:00:00Z") });
    const soon = await add("soon", { dueAt: new Date("2026-10-03T20:00:00Z") });
    const worked = await add("worked", { dueAt: new Date("2026-10-08T00:00:00Z") });
    await add("material", { kind: "material", dueAt: new Date("2026-10-02T00:00:00Z") });
    await add("done", { status: "turned_in", dueAt: new Date("2026-10-02T00:00:00Z") });
    const { submission } = await upsertSubmission(
      db,
      { assignmentId: worked.id, state: "created", hash: "s", payload: {} },
      T0,
    );
    await syncAttachments(
      db,
      { owner: "submission", assignmentId: worked.id, submissionId: submission.id },
      [{ url: "https://example.test/doc", modifiedAt: new Date("2026-10-02T00:00:00Z") }],
      T0,
    );

    const inputs = await loadDeadlineInputs(db);
    expect(inputs.map((i) => i.assignment.title)).toEqual(["untouched", "soon", "worked"]);
    expect(inputs[0]?.assignment.courseName).toBe("Math");
    expect(inputs[2]?.submission?.studentWorkSignals).toEqual({
      attachmentCount: 1,
      lastStudentEditAt: new Date("2026-10-02T00:00:00Z"),
    });

    const created = await evaluateDeadlines(db, NOW);
    expect(created.map((d) => d.key)).toEqual([
      `deadline:${untouched.id}:untouched_24h`,
      `deadline:${soon.id}:due_soon`,
    ]);
    expect((await listUnsentAlerts(db)).map((a) => a.level)).toEqual(["alert", "panic"]);

    expect(await evaluateDeadlines(db, NOW)).toEqual([]);
    expect(await listUnsentAlerts(db)).toHaveLength(2);
  });

  it("skips unwatched accounts", async () => {
    const { add } = await seed();
    await add("late", { dueAt: new Date("2026-10-02T00:00:00Z") });
    await setWatchedAccounts(db, []);
    expect(await evaluateDeadlines(db, NOW)).toEqual([]);
  });
});
