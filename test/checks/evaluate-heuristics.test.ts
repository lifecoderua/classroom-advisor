import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cachedTextReader,
  evaluateTurnedIn,
  loadTurnedInInput,
} from "../../src/checks/evaluate-heuristics.ts";
import {
  type Db,
  setAttachmentContent,
  syncAttachments,
  upsertAccount,
  upsertAssignment,
  upsertCourse,
  upsertSubmission,
} from "../../src/store/index.ts";
import { migratedTemplate } from "../store/helpers.ts";

const T0 = new Date("2026-10-01T08:00:00Z");
const TEMPLATE = "Робочий аркуш. Дай відповіді на запитання про осінь у лісі. Відповідь: ____";
const DOC = "application/vnd.google-apps.document";

let template: ReturnType<typeof migratedTemplate>;
let db: Db;
let dataDir: string;

beforeAll(() => {
  template = migratedTemplate();
  dataDir = mkdtempSync(join(tmpdir(), "ca-heur-"));
  mkdirSync(join(dataDir, "files"));
  writeFileSync(join(dataDir, "files/tpl.txt"), TEMPLATE);
  writeFileSync(join(dataDir, "files/copy.txt"), `\n${TEMPLATE}\n`);
}, 60_000);
afterAll(async () => {
  await template.cleanup();
  rmSync(dataDir, { recursive: true, force: true });
});
beforeEach(async () => {
  db = await template.fresh();
});

async function seed() {
  const account = await upsertAccount(db, { email: "student-one@school.example" });
  const course = await upsertCourse(db, { accountId: account.id, classroomId: "c1", name: "Укр" });
  const { assignment } = await upsertAssignment(
    db,
    {
      accountId: account.id,
      courseId: course.id,
      classroomId: "a1",
      kind: "assignment",
      title: "Осінь",
      status: "turned_in",
      hash: "a",
      payload: { instructions: "Заповни аркуш і надішли." },
    },
    T0,
  );
  const { submission, version } = await upsertSubmission(
    db,
    { assignmentId: assignment.id, state: "turned_in", turnedInAt: T0, hash: "s", payload: {} },
    T0,
  );
  const [tpl] = await syncAttachments(
    db,
    { owner: "material", assignmentId: assignment.id },
    [{ url: "https://docs.example/tpl", title: "Аркуш", driveFileId: "d1", mime: DOC }],
    T0,
  );
  const [copy] = await syncAttachments(
    db,
    { owner: "submission", assignmentId: assignment.id, submissionId: submission.id },
    [{ url: "https://docs.example/copy", title: "Учень - Аркуш", driveFileId: "d2", mime: DOC }],
    T0,
  );
  if (!tpl || !copy || !version) throw new Error("seed failed");
  return { tpl, copy, versionId: version.id };
}

describe("evaluateTurnedIn", () => {
  it("loads the snapshot and panics on an untouched template copy", async () => {
    const { tpl, copy, versionId } = await seed();
    await setAttachmentContent(db, tpl.id, { contentPath: "files/tpl.txt", contentHash: "h1" });
    await setAttachmentContent(db, copy.id, { contentPath: "files/copy.txt", contentHash: "h2" });
    const read = cachedTextReader(dataDir);

    const input = await loadTurnedInInput(db, versionId, read);
    expect(input?.assignment).toMatchObject({
      kind: "assignment",
      instructions: "Заповни аркуш і надішли.",
      materials: [{ kind: "doc", title: "Аркуш", driveFileId: "d1", text: TEMPLATE }],
    });
    expect(input?.submission.attachments).toHaveLength(1);
    expect(input?.submission.state).toBe("turned_in");

    const res = await evaluateTurnedIn(db, versionId, read);
    expect(res?.signals.map((s) => s.code)).toEqual(["template_unchanged"]);
    expect(res?.directVerdict?.level).toBe("panic");
  });

  it("reports fetch_failed when the copy has no cached text", async () => {
    const { versionId } = await seed();
    const res = await evaluateTurnedIn(db, versionId, cachedTextReader(dataDir));
    expect(res?.signals.map((s) => s.code)).toEqual(["fetch_failed"]);
  });

  it("returns null for an unknown version", async () => {
    expect(await evaluateTurnedIn(db, 999, cachedTextReader(dataDir))).toBeNull();
  });
});
