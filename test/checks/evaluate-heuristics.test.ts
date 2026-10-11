import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cachedOfficeReader,
  cachedTextReader,
  evaluateTurnedIn,
  loadTurnedInInput,
} from "../../src/checks/evaluate-heuristics.ts";
import {
  type Db,
  setAttachmentContent,
  setAttachmentFetchError,
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

  it("marks a copy without cached text as unreadable, with the fetch error as the reason", async () => {
    const { copy, versionId } = await seed();
    const read = cachedTextReader(dataDir);
    let input = await loadTurnedInInput(db, versionId, read);
    expect(input?.submission.attachments[0]?.unreadable).toBe("the file hasn't been downloaded");
    expect((await evaluateTurnedIn(db, versionId, read))?.signals).toEqual([]);

    await setAttachmentFetchError(db, copy.id, "file too large (31457280 bytes > 26214400)");
    input = await loadTurnedInInput(db, versionId, read);
    expect(input?.submission.attachments[0]?.unreadable).toBe("file too large to download (30 MB)");
    // A readable copy has no reason.
    await setAttachmentContent(db, copy.id, { contentPath: "files/copy.txt", contentHash: "h2" });
    input = await loadTurnedInInput(db, versionId, read);
    expect(input?.submission.attachments[0]?.unreadable).toBeUndefined();
    expect((await db.attachment.findUniqueOrThrow({ where: { id: copy.id } })).fetchError).toBe(
      null,
    );
  });

  it("loads Office structure next to the cached text", async () => {
    const { tpl, copy, versionId } = await seed();
    const office = {
      format: "pptx",
      slides: [
        { index: 1, text: TEMPLATE, pictures: 0, shapes: 1, animations: 0, animationClasses: {} },
      ],
    };
    const own = {
      ...office,
      slides: [{ ...office.slides[0], animations: 2, animationClasses: { entr: 2 } }],
    };
    writeFileSync(join(dataDir, "files/tpl.office.json"), JSON.stringify(office));
    writeFileSync(join(dataDir, "files/copy.office.json"), JSON.stringify(own));
    await setAttachmentContent(db, tpl.id, { contentPath: "files/tpl.txt", contentHash: "h1" });
    await setAttachmentContent(db, copy.id, { contentPath: "files/copy.txt", contentHash: "h2" });
    const opts = { readOffice: cachedOfficeReader(dataDir) };

    const input = await loadTurnedInInput(db, versionId, cachedTextReader(dataDir), opts);
    expect(input?.submission.attachments[0]?.office).toEqual(own);
    expect(input?.assignment.materials[0]?.office).toEqual(office);
    // Same text, but animations were added: no direct panic.
    const res = await evaluateTurnedIn(db, versionId, cachedTextReader(dataDir), opts);
    expect(res?.directVerdict).toBeUndefined();
    expect(res?.signals[0]?.detail).toContain("+2 animation effects");
  });

  it("returns null for an unknown version", async () => {
    expect(await evaluateTurnedIn(db, 999, cachedTextReader(dataDir))).toBeNull();
  });
});
