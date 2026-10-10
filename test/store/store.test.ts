import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  addCheckResult,
  type Db,
  databasePath,
  findAssignment,
  latestSubmissionVersion,
  listAccounts,
  listAssignmentVersions,
  listAttachments,
  listCheckResults,
  listSubmissionVersions,
  listUnsentAlerts,
  markAlertsSent,
  raiseAlert,
  setAttachmentContent,
  setWatchedAccounts,
  syncAttachments,
  upsertAccount,
  upsertAssignment,
  upsertCourse,
  upsertSubmission,
} from "../../src/store/index.ts";
import { migratedTemplate } from "./helpers.ts";

const T0 = new Date("2026-10-01T08:00:00Z");
const T1 = new Date("2026-10-01T09:00:00Z");
const T2 = new Date("2026-10-01T10:00:00Z");

let template: ReturnType<typeof migratedTemplate>;
let db: Db;

beforeAll(() => {
  template = migratedTemplate();
}, 60_000);
afterAll(() => template.cleanup());
beforeEach(async () => {
  db = await template.fresh();
});

async function seedAssignment() {
  const account = await upsertAccount(db, { email: "student-one@school.example" });
  const course = await upsertCourse(db, { accountId: account.id, classroomId: "c1", name: "Math" });
  const base = {
    accountId: account.id,
    courseId: course.id,
    classroomId: "a1",
    kind: "assignment" as const,
    title: "Fractions",
    dueAt: new Date("2026-10-03T21:00:00Z"),
    status: "assigned",
  };
  const { assignment } = await upsertAssignment(db, { ...base, hash: "h1", payload: {} }, T0);
  return { account, course, base, assignment };
}

describe("databasePath", () => {
  it("is <dataDir>/app.db", () => {
    expect(databasePath({ dataDir: "/x/.data" })).toBe("/x/.data/app.db");
  });
});

describe("accounts", () => {
  it("upserts without touching watched, and sets the watch list", async () => {
    await upsertAccount(db, { email: "a@school.example", displayName: "A" });
    await setWatchedAccounts(db, ["a@school.example", "b@school.example"]);
    await upsertAccount(db, { email: "a@school.example", displayName: "A2", authuser: "1" });
    expect((await listAccounts(db, { watched: true })).map((a) => a.email)).toEqual([
      "a@school.example",
      "b@school.example",
    ]);

    await setWatchedAccounts(db, ["b@school.example"]);
    const all = await listAccounts(db);
    expect(all.map((a) => [a.email, a.watched, a.displayName])).toEqual([
      ["a@school.example", false, "A2"],
      ["b@school.example", true, null],
    ]);
  });

  it("upserts courses per account", async () => {
    const { id } = await upsertAccount(db, { email: "a@school.example" });
    const c1 = await upsertCourse(db, { accountId: id, classroomId: "c1", name: "Old" }, T0);
    const c2 = await upsertCourse(db, { accountId: id, classroomId: "c1", name: "New" }, T1);
    expect(c2.id).toBe(c1.id);
    expect(c2.name).toBe("New");
    expect(c2.firstSeenAt).toEqual(T0);
    expect(c2.lastSeenAt).toEqual(T1);
  });
});

describe("upsertAssignment", () => {
  it("creates, skips unchanged, and appends a version when the hash changes", async () => {
    const { account, base } = await seedAssignment();

    const same = await upsertAssignment(db, { ...base, hash: "h1", payload: {} }, T1);
    expect(same.change).toBe("unchanged");
    expect(same.version).toBeNull();
    expect(same.assignment.lastSeenAt).toEqual(T1);

    const moved = new Date("2026-10-05T21:00:00Z");
    const upd = await upsertAssignment(
      db,
      { ...base, dueAt: moved, hash: "h2", payload: { due: "moved" } },
      T2,
    );
    expect(upd.change).toBe("updated");
    expect(upd.assignment.dueAt).toEqual(moved);
    expect(upd.assignment.firstSeenAt).toEqual(T0);

    const found = await findAssignment(db, account.id, "a1");
    expect(found?.currentHash).toBe("h2");
    const versions = await listAssignmentVersions(db, upd.assignment.id);
    expect(versions.map((v) => [v.hash, JSON.parse(v.payload)])).toEqual([
      ["h1", {}],
      ["h2", { due: "moved" }],
    ]);
  });

  it("reports new on first sight", async () => {
    const account = await upsertAccount(db, { email: "a@school.example" });
    const course = await upsertCourse(db, { accountId: account.id, classroomId: "c", name: "X" });
    const res = await upsertAssignment(db, {
      accountId: account.id,
      courseId: course.id,
      classroomId: "a",
      kind: "material",
      title: "Notes",
      status: "assigned",
      hash: "h",
      payload: null,
    });
    expect(res.change).toBe("new");
    expect(res.assignment.dueAt).toBeNull();
    expect(res.version?.hash).toBe("h");
  });
});

describe("upsertSubmission", () => {
  it("versions state changes", async () => {
    const { assignment } = await seedAssignment();
    const input = { assignmentId: assignment.id, state: "created", hash: "s1", payload: {} };

    expect((await upsertSubmission(db, input, T0)).change).toBe("new");
    expect((await upsertSubmission(db, input, T1)).change).toBe("unchanged");
    const turned = await upsertSubmission(
      db,
      { ...input, state: "turned_in", turnedInAt: T2, hash: "s2" },
      T2,
    );
    expect(turned.change).toBe("updated");
    expect(turned.submission.turnedInAt).toEqual(T2);

    const versions = await listSubmissionVersions(db, turned.submission.id);
    expect(versions.map((v) => v.state)).toEqual(["created", "turned_in"]);
    expect((await latestSubmissionVersion(db, turned.submission.id))?.id).toBe(turned.version?.id);
  });
});

describe("syncAttachments", () => {
  it("upserts, deletes missing and invalidates cached content on file change", async () => {
    const { assignment } = await seedAssignment();
    const { submission } = await upsertSubmission(db, {
      assignmentId: assignment.id,
      state: "created",
      hash: "s",
      payload: {},
    });
    const scope = {
      owner: "submission" as const,
      assignmentId: assignment.id,
      submissionId: submission.id,
    };
    const doc = { url: "https://example.test/doc", driveFileId: "f1", modifiedAt: T0 };

    const [a] = await syncAttachments(db, scope, [doc, { url: "https://example.test/img" }]);
    await syncAttachments(db, { owner: "material", assignmentId: assignment.id }, [
      { url: "https://example.test/template" },
    ]);
    if (!a) throw new Error("expected attachment");
    await setAttachmentContent(db, a.id, { contentPath: "files/f1.txt", contentHash: "c1" });

    // Same file: cache kept; img dropped; material untouched.
    const kept = await syncAttachments(db, scope, [doc], T1);
    expect(kept[0]?.contentPath).toBe("files/f1.txt");
    expect((await listAttachments(db, assignment.id, "submission")).length).toBe(1);
    expect((await listAttachments(db, assignment.id, "material")).length).toBe(1);

    // Edited file: cache reset.
    const edited = await syncAttachments(db, scope, [{ ...doc, modifiedAt: T2 }], T2);
    expect(edited[0]?.id).toBe(a.id);
    expect(edited[0]?.contentPath).toBeNull();
    expect(edited[0]?.submissionId).toBe(submission.id);
  });
});

describe("check results and alerts", () => {
  it("stores check results per submission version", async () => {
    const { assignment } = await seedAssignment();
    const { version } = await upsertSubmission(db, {
      assignmentId: assignment.id,
      state: "turned_in",
      hash: "s",
      payload: {},
    });
    if (!version) throw new Error("expected version");
    await addCheckResult(db, {
      submissionVersionId: version.id,
      source: "heuristic",
      verdict: "warn",
      findings: [{ signal: "no_attachments", confidence: 0.4 }],
    });
    await addCheckResult(db, {
      submissionVersionId: version.id,
      source: "llm:fake",
      verdict: "ok",
      findings: {},
    });
    const results = await listCheckResults(db, version.id);
    expect(results.map((r) => r.source)).toEqual(["heuristic", "llm:fake"]);
    expect(JSON.parse(results[0]?.findings ?? "null")).toEqual([
      { signal: "no_attachments", confidence: 0.4 },
    ]);
  });

  it("dedupes alerts by key and tracks sending", async () => {
    const first = await raiseAlert(db, { key: "quality:1", level: "alert", message: "m" });
    expect(first.created).toBe(true);
    const again = await raiseAlert(db, { key: "quality:1", level: "panic", message: "other" });
    expect(again.created).toBe(false);
    expect(again.alert.id).toBe(first.alert.id);
    expect(again.alert.message).toBe("m");

    await raiseAlert(db, { key: "panic:2", level: "panic", message: "due soon" });
    expect((await listUnsentAlerts(db)).map((a) => a.key)).toEqual(["quality:1", "panic:2"]);
    await markAlertsSent(db, [first.alert.id], T1);
    expect((await listUnsentAlerts(db)).map((a) => a.key)).toEqual(["panic:2"]);
  });
});
