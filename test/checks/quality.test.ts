import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cachedImagePath, cachedTextReader } from "../../src/checks/evaluate-heuristics.ts";
import type { TurnedInInput, TurnedInResult } from "../../src/checks/heuristics.ts";
import {
  allocate,
  applyRedoFloor,
  buildReviewInput,
  DEFAULT_BUDGET,
  heuristicVerdict,
  mergeVerdict,
  openRedoRequest,
  pendingQualityVersions,
  REVIEW_PROMPT_VERSION,
  reviewPrompt,
  reviewSubmission,
  truncate,
  UNCHECKED_RETRIES,
} from "../../src/checks/quality.ts";
import type { PptxSummary } from "../../src/collector/office.ts";
import { FakeProvider, LlmError, type ReviewOutput } from "../../src/llm/index.ts";
import {
  type Db,
  listCheckResults,
  setAttachmentContent,
  syncAttachments,
  upsertAccount,
  upsertAssignment,
  upsertComment,
  upsertCourse,
  upsertSubmission,
} from "../../src/store/index.ts";
import { contentText, rowText } from "../alert-text.ts";
import { migratedTemplate } from "../store/helpers.ts";

const T0 = new Date("2026-10-01T08:00:00Z");
const NOW = new Date("2026-10-01T12:00:00Z");
const DOC = "application/vnd.google-apps.document";

const out = (o: Partial<ReviewOutput> = {}): ReviewOutput => ({
  verdict: "ok",
  addressesAssignment: true,
  missingParts: [],
  issues: [],
  summaryForParent: "Все виконано.",
  confidence: 0.9,
  unverifiable: [],
  ...o,
});

const snapshot = (over: Partial<TurnedInInput["submission"]> = {}): TurnedInInput => ({
  assignment: {
    kind: "assignment",
    title: "Вправа 5",
    instructions: "Виконай вправу 5 на с. 40 і надішли фото.",
    materials: [{ kind: "doc", title: "Аркуш", text: "м".repeat(10_000) }],
    courseName: "Укр. мова",
    dueAt: new Date("2026-10-02T06:00:00Z"),
  },
  submission: {
    state: "turned_in",
    turnedInAt: T0,
    attachments: [
      { kind: "image", title: "photo.jpg", imagePath: "/data/files/x/1.jpg" },
      { kind: "doc", title: "Робота", text: "Відповідь ".repeat(5_000) },
    ],
    ...over,
  },
});

describe("pure helpers", () => {
  it("truncates with a marker within the limit", () => {
    const t = truncate("a".repeat(500), 100);
    expect(t.length).toBeLessThanOrEqual(100);
    expect(t).toContain("truncated");
    expect(truncate("short", 100)).toBe("short");
  });

  it("allocates a budget with water-filling", () => {
    expect(allocate([10, 1000, 1000], 210)).toEqual([10, 100, 100]);
    expect(allocate([5, 5], 100)).toEqual([5, 5]);
  });

  it("asks the LLM for the digest language, whatever the assignment's language", () => {
    const s = snapshot();
    expect(buildReviewInput(s, { signals: [] }, undefined, "ru").locale).toBe("ru");
    expect(buildReviewInput(s, { signals: [] }, undefined, "en").locale).toBe("en");
    expect(reviewPrompt()).toContain("given\nby `locale`");
  });

  it("builds the review input within budget, keeping image paths", () => {
    const s = snapshot();
    const input = buildReviewInput(s, { signals: [{ code: "kind_hint", confidence: 0.6 }] });
    expect(input.locale).toBe("uk");
    expect(input.assignment).toMatchObject({
      courseName: "Укр. мова",
      dueAt: "2026-10-02T06:00:00.000Z",
    });
    expect(input.submission.attachments[0]).toEqual({
      kind: "image",
      title: "photo.jpg",
      imagePath: "/data/files/x/1.jpg",
    });
    const texts = [
      input.assignment.instructions,
      ...input.materials.map((m) => m.text ?? ""),
      ...input.submission.attachments.map((a) => a.text ?? ""),
    ];
    expect(texts.reduce((n, t) => n + t.length, 0)).toBeLessThanOrEqual(24_000);
    // The student's work gets the larger share.
    expect(input.submission.attachments[1]?.text?.length).toBeGreaterThan(
      input.materials[0]?.text?.length ?? 0,
    );
    expect(input.submission.turnedInAt).toBe(T0.toISOString());
    expect(input.signals).toHaveLength(1);
    expect(input.comments).toBeUndefined();
  });

  it("adds the private comments within their own budget", () => {
    const s: TurnedInInput = {
      ...snapshot(),
      comments: [
        { authorRole: "teacher", postedAt: T0, text: "Переробити вправу 5, додай фото." },
        { authorRole: "student", postedAt: NOW, text: "д".repeat(10_000) },
      ],
    };
    const input = buildReviewInput(s, { signals: [] });
    expect(input.comments?.[0]).toEqual({
      author: "teacher",
      postedAt: T0.toISOString(),
      text: "Переробити вправу 5, додай фото.",
    });
    expect(input.comments?.[1]?.author).toBe("student");
    expect(input.comments?.[1]?.text).toContain("truncated");
    const total = (input.comments ?? []).reduce((n, c) => n + c.text.length, 0);
    expect(total).toBeLessThanOrEqual(DEFAULT_BUDGET.comments);
  });

  it("passes presentation structure and slide-labelled text to the LLM", () => {
    const office: PptxSummary = {
      format: "pptx",
      slides: [
        {
          index: 1,
          text: "Мій об'єкт",
          pictures: 1,
          shapes: 2,
          animations: 3,
          animationClasses: { entr: 2, emph: 1 },
          transition: "fade",
        },
      ],
    };
    const s = snapshot();
    const input = buildReviewInput(
      {
        ...s,
        assignment: { ...s.assignment, materials: [{ kind: "slides", title: "Шаблон" }] },
        submission: {
          ...s.submission,
          attachments: [{ kind: "slides", title: "Анімація", text: "Мій об'єкт", office }],
        },
        comments: [{ authorRole: "teacher", postedAt: T0, text: "Додай анімацію." }],
      },
      { signals: [] },
    );
    // Comments and structure travel together.
    expect(input.comments).toEqual([
      { author: "teacher", postedAt: T0.toISOString(), text: "Додай анімацію." },
    ]);
    expect(input.submission.attachments[0]).toEqual({
      kind: "slides",
      title: "Анімація",
      text: "[slide 1]\nМій об'єкт",
      structure: expect.stringContaining(
        "slide 1: 1 pictures, 2 shapes, 3 animations (entr 2, emph 1), transition fade",
      ),
    });
    expect(input.materials[0]).toEqual({ kind: "slides", title: "Шаблон" });
  });

  it("loads the versioned prompt", () => {
    expect(REVIEW_PROMPT_VERSION).toBe("review.v5");
    expect(reviewPrompt()).toContain("hints, not facts");
    expect(reviewPrompt()).toContain("`comments`");
    expect(reviewPrompt()).toContain("`structure`");
    expect(reviewPrompt()).toContain("`unverifiable`");
    expect(reviewPrompt()).toContain("`unreadable`");
  });
});

describe("mergeVerdict", () => {
  const none: TurnedInResult = { signals: [] };
  const direct: TurnedInResult = {
    signals: [{ code: "template_unchanged", confidence: 0.99 }],
    directVerdict: { level: "panic", reason: "Turned in the template without changes." },
  };

  it("uses the LLM verdict", () => {
    expect(mergeVerdict(none, { ok: true, output: out({ verdict: "warn" }) })).toMatchObject({
      verdict: "warn",
      basis: "llm",
    });
  });

  it("lets a direct heuristic panic win", () => {
    expect(mergeVerdict(direct, { ok: true, output: out() }).verdict).toBe("panic");
  });

  it("downgrades a low-confidence LLM panic", () => {
    const m = mergeVerdict(none, { ok: true, output: out({ verdict: "panic", confidence: 0.3 }) });
    expect(m.verdict).toBe("warn");
    expect(m.notes[0]).toContain("low LLM confidence");
  });

  it("falls back to heuristics when the provider fails", () => {
    expect(mergeVerdict(direct, { ok: false, error: "boom" })).toMatchObject({
      verdict: "panic",
      basis: "heuristic-fallback",
    });
    const weak: TurnedInResult = { signals: [{ code: "no_attachments", confidence: 0.3 }] };
    expect(heuristicVerdict(weak)).toBe("ok");
    expect(heuristicVerdict({ signals: [{ code: "no_attachments", confidence: 0.75 }] })).toBe(
      "warn",
    );
  });
});

describe("reviewSubmission", () => {
  let template: ReturnType<typeof migratedTemplate>;
  let db: Db;
  let dataDir: string;

  beforeAll(() => {
    template = migratedTemplate();
    dataDir = mkdtempSync(join(tmpdir(), "ca-quality-"));
    mkdirSync(join(dataDir, "files"));
    writeFileSync(join(dataDir, "files/work.txt"), "1) 5 + 7 = 12\n2) 9 - 4 = 5");
  }, 60_000);
  afterAll(async () => {
    await template.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    db = await template.fresh();
  });

  async function seed(state = "turned_in") {
    const account = await upsertAccount(db, { email: "student-one@school.example" });
    await db.account.update({ where: { id: account.id }, data: { watched: true } });
    const course = await upsertCourse(db, {
      accountId: account.id,
      classroomId: "c1",
      name: "Математика",
    });
    const { assignment } = await upsertAssignment(
      db,
      {
        accountId: account.id,
        courseId: course.id,
        classroomId: "a1",
        kind: "assignment",
        title: "Приклади",
        status: "turned_in",
        hash: "a",
        payload: { instructions: "Розв'яжи приклади 1-3 і прикріпи роботу." },
      },
      T0,
    );
    const { submission, version } = await upsertSubmission(
      db,
      { assignmentId: assignment.id, state, turnedInAt: T0, hash: "s", payload: {} },
      T0,
    );
    const [work, photo] = await syncAttachments(
      db,
      { owner: "submission", assignmentId: assignment.id, submissionId: submission.id },
      [
        { url: "https://docs.example/w", title: "Робота", driveFileId: "d1", mime: DOC },
        { url: "https://drive.example/p", title: "фото", driveFileId: "d2", mime: "image/jpeg" },
      ],
      T0,
    );
    if (!work || !photo || !version) throw new Error("seed failed");
    await setAttachmentContent(db, work.id, { contentPath: "files/work.txt", contentHash: "h" });
    await setAttachmentContent(db, photo.id, { contentPath: "files/p.jpg", contentHash: "h2" });
    return version.id;
  }

  const run = (id: number, provider: FakeProvider) =>
    reviewSubmission(db, id, provider, cachedTextReader(dataDir), NOW, {
      imagePathOf: cachedImagePath(dataDir),
    });

  it("stores heuristic + llm results and raises a panic alert", async () => {
    const id = await seed();
    const provider = new FakeProvider({
      respond: out({
        verdict: "panic",
        addressesAssignment: true,
        missingParts: ["Приклад 3"],
        summaryForParent: "Приклад 3 не розв'язано.",
        confidence: 0.85,
      }),
    });

    const res = await run(id, provider);
    expect(res).toMatchObject({ status: "reviewed", verdict: "panic", alertCreated: true });

    const call = provider.calls[0];
    expect(call?.opts.instructions).toContain("review.v5");
    expect(call?.input.locale).toBe("uk");
    expect(call?.input.assignment.courseName).toBe("Математика");
    expect(call?.input.submission.attachments).toEqual([
      expect.objectContaining({ title: "Робота", text: expect.stringContaining("5 + 7 = 12") }),
      expect.objectContaining({ title: "фото", imagePath: join(dataDir, "files/p.jpg") }),
    ]);

    const results = await listCheckResults(db, id);
    expect(results.map((r) => [r.source, r.verdict])).toEqual([
      ["heuristic", "ok"],
      ["llm:fake", "panic"],
    ]);
    expect(JSON.parse(results[1]?.findings ?? "{}")).toMatchObject({
      promptVersion: "review.v5",
      output: { missingParts: ["Приклад 3"] },
    });

    const alert = await db.alert.findUnique({ where: { key: `quality:${id}` } });
    expect(alert?.level).toBe("panic");
    expect(rowText(alert)).toContain("Приклад 3 не розв'язано.");
    expect(rowText(alert)).toContain('"Приклади" (Математика)');
  });

  it("is idempotent per version and provider", async () => {
    const id = await seed();
    const provider = new FakeProvider({ respond: out({ verdict: "warn" }) });
    expect((await run(id, provider)).alertCreated).toBe(true);
    expect(await run(id, provider)).toEqual({ status: "already_reviewed" });
    expect(provider.calls).toHaveLength(1);
    expect(await listCheckResults(db, id)).toHaveLength(2);
    expect(await db.alert.count()).toBe(1);
    expect((await db.alert.findFirst())?.level).toBe("alert");
  });

  it("raises no alert for ok", async () => {
    const id = await seed();
    expect(await run(id, new FakeProvider())).toEqual({
      status: "reviewed",
      verdict: "ok",
      alertCreated: false,
    });
    expect(await db.alert.count()).toBe(0);
  });

  it("on provider failure raises nothing, retries, and alerts after 3 failures", async () => {
    const id = await seed();
    // No cached text for the doc: unreadable, but the photo is still reviewed by the LLM.
    await db.attachment.updateMany({ where: { mime: DOC }, data: { contentPath: null } });
    const failing = new FakeProvider({ respond: () => new LlmError("timed out") });

    for (const n of [1, 2]) {
      expect(await run(id, failing)).toEqual({ status: "fallback", llmFailures: n });
    }
    expect(await db.alert.count()).toBe(0);
    expect((await listCheckResults(db, id)).map((r) => r.source)).toEqual(["heuristic"]);
    expect(await pendingQualityVersions(db, "llm:fake")).toEqual([id]);

    expect(await run(id, failing)).toEqual({
      status: "fallback",
      llmFailures: 3,
      failureAlertCreated: true,
    });
    const alert = await db.alert.findUnique({ where: { key: `quality:${id}:llm-failed` } });
    expect(alert?.level).toBe("alert");
    expect(rowText(alert)).toContain("couldn't run");
    expect(await db.alert.count()).toBe(1);
    expect(await run(id, failing)).toMatchObject({ llmFailures: 4, failureAlertCreated: false });

    const heur = (await listCheckResults(db, id))[0];
    expect(JSON.parse(heur?.findings ?? "{}").llmFailures).toEqual({ "llm:fake": 4 });

    expect(await run(id, new FakeProvider())).toMatchObject({ status: "reviewed", verdict: "ok" });
    expect((await listCheckResults(db, id)).map((r) => r.source)).toEqual([
      "heuristic",
      "llm:fake",
    ]);
  });

  it("on provider failure still alerts a direct heuristic panic", async () => {
    const id = await seed();
    const tpl = "Робочий аркуш. Розв'яжи приклади один два три чотири п'ять.";
    writeFileSync(join(dataDir, "files/tpl.txt"), tpl);
    const a = await db.assignment.findFirstOrThrow();
    const [m] = await syncAttachments(
      db,
      { owner: "material", assignmentId: a.id },
      [{ url: "https://docs.example/tpl", title: "Аркуш", driveFileId: "d0", mime: DOC }],
      T0,
    );
    if (!m) throw new Error("seed failed");
    await setAttachmentContent(db, m.id, { contentPath: "files/tpl.txt", contentHash: "t" });
    await db.attachment.updateMany({
      where: { mime: DOC, owner: "submission" },
      data: { contentPath: "files/tpl.txt" },
    });
    await db.attachment.deleteMany({ where: { mime: "image/jpeg" } });

    const res = await run(id, new FakeProvider({ respond: () => new LlmError("down") }));
    expect(res).toMatchObject({
      status: "fallback",
      verdict: "panic",
      alertCreated: true,
      llmFailures: 1,
    });
    expect(contentText(res.content)).toContain("heuristics only");
    expect((await db.alert.findUnique({ where: { key: `quality:${id}` } }))?.level).toBe("panic");
  });

  const makeUnreadable = async () => {
    await db.attachment.updateMany({
      where: { mime: DOC },
      data: { contentPath: null, fetchError: "file too large (31457280 bytes > 26214400)" },
    });
    await db.attachment.updateMany({
      where: { mime: "image/jpeg" },
      data: { mime: "video/mp4", contentPath: null },
    });
  };

  it("doesn't call the LLM when nothing is readable: unchecked + a 'check by hand' alert", async () => {
    const id = await seed();
    await makeUnreadable();
    const provider = new FakeProvider();

    const res = await run(id, provider);
    expect(res).toMatchObject({
      status: "reviewed",
      verdict: "unchecked",
      uncheckedAlertCreated: true,
    });
    expect(provider.calls).toHaveLength(0);
    const results = await listCheckResults(db, id);
    expect(results.map((r) => [r.source, r.verdict])).toEqual([
      ["heuristic", "ok"],
      ["llm:fake", "unchecked"],
    ]);
    expect(JSON.parse(results[1]?.findings ?? "{}")).toMatchObject({
      merge: { verdict: "unchecked", basis: "unreadable" },
      unchecked: [
        { what: '"Робота"', why: "file too large to download (30 MB)" },
        { what: '"фото"', why: "video: needs watching" },
      ],
    });

    const alerts = await db.alert.findMany();
    expect(alerts.map((a) => [a.key, a.level])).toEqual([[`quality:${id}:unchecked`, "info"]]);
    expect(rowText(alerts[0])).toBe(
      'Check by hand: "Приклади" (Математика): "Робота": file too large to download (30 MB); "фото": video: needs watching',
    );
    expect(await pendingQualityVersions(db, "llm:fake")).toEqual([]);
    expect(await run(id, provider)).toEqual({ status: "already_reviewed" });
  });

  it("retries an unchecked version with only temporary causes, up to 3 times", async () => {
    const id = await seed();
    // Neither file downloaded yet (no fetch error): temporary.
    await db.attachment.updateMany({ data: { contentPath: null } });
    const provider = new FakeProvider();
    for (let i = 0; i < UNCHECKED_RETRIES; i++) {
      expect(await run(id, provider)).toMatchObject({
        status: "reviewed",
        verdict: "unchecked",
        retryPending: true,
      });
      expect(await pendingQualityVersions(db, "llm:fake")).toEqual([id]);
    }
    expect(await db.alert.count()).toBe(0);
    // Out of retries: kept as unchecked, with the check-by-hand alert.
    expect(await run(id, provider)).toMatchObject({
      verdict: "unchecked",
      uncheckedAlertCreated: true,
    });
    expect(await pendingQualityVersions(db, "llm:fake")).toEqual([]);
    expect(await run(id, provider)).toEqual({ status: "already_reviewed" });
    expect(provider.calls).toHaveLength(0);
    expect(await db.alert.count()).toBe(1);
  });

  it("a retry reviews the work once it became readable", async () => {
    const id = await seed();
    await db.attachment.updateMany({ data: { contentPath: null, fetchError: "HTTP 500" } });
    const provider = new FakeProvider();
    expect(await run(id, provider)).toMatchObject({ verdict: "unchecked", retryPending: true });
    await db.attachment.updateMany({
      where: { mime: DOC },
      data: { contentPath: "files/work.txt", fetchError: null },
    });
    expect(await run(id, provider)).toMatchObject({ status: "reviewed", verdict: "ok" });
    expect(provider.calls).toHaveLength(1);
    expect(await pendingQualityVersions(db, "llm:fake")).toEqual([]);
  });

  it("keeps a heuristics warn when nothing is readable, with the unchecked parts in it", async () => {
    const id = await seed();
    await makeUnreadable();
    const a = await db.assignment.findFirstOrThrow();
    await syncAttachments(
      db,
      { owner: "material", assignmentId: a.id },
      ["t1", "t2", "t3"].map((t) => ({
        url: `https://docs.example/${t}`,
        title: t,
        driveFileId: t,
        mime: DOC,
        isTemplate: true,
      })),
      T0,
    );

    const res = await run(id, new FakeProvider());
    expect(res).toMatchObject({ status: "reviewed", verdict: "warn", alertCreated: true });
    const alerts = await db.alert.findMany();
    expect(alerts.map((x) => [x.key, x.level])).toEqual([[`quality:${id}`, "alert"]]);
    expect(rowText(alerts[0])).toContain("fewer files than expected");
    expect(rowText(alerts[0])).toContain("[heuristics only, nothing readable]");
    expect(rowText(alerts[0])).toContain('Not checked automatically: "Робота": file too large');
  });

  it("reviews the readable part and lists the unreadable attachment", async () => {
    const id = await seed();
    await db.attachment.updateMany({
      where: { mime: "image/jpeg" },
      data: { mime: "audio/mpeg", contentPath: "files/p.bin" },
    });
    const provider = new FakeProvider();

    const res = await run(id, provider);
    expect(res).toMatchObject({
      status: "reviewed",
      verdict: "ok",
      alertCreated: false,
      uncheckedAlertCreated: true,
    });
    expect(provider.calls[0]?.input.submission.attachments).toEqual([
      expect.objectContaining({ title: "Робота", text: expect.stringContaining("5 + 7") }),
      { title: "фото", kind: "file", unreadable: "audio recording: needs listening" },
    ]);
    const alert = await db.alert.findUnique({ where: { key: `quality:${id}:unchecked` } });
    expect(alert?.level).toBe("info");
    expect(rowText(alert)).toContain('"фото": audio recording: needs listening');
  });

  it("surfaces what the LLM couldn't verify: 'check by hand' on ok, inside the alert on warn", async () => {
    const unverifiable = [{ what: "Тест на платформі", why: "результат лише на платформі" }];
    const id = await seed();
    expect(await run(id, new FakeProvider({ respond: out({ unverifiable }) }))).toMatchObject({
      verdict: "ok",
      uncheckedAlertCreated: true,
    });
    const alert = await db.alert.findUnique({ where: { key: `quality:${id}:unchecked` } });
    expect(rowText(alert)).toBe(
      'Check by hand: "Приклади" (Математика): Тест на платформі: результат лише на платформі',
    );

    db = await template.fresh();
    const id2 = await seed();
    const res = await run(
      id2,
      new FakeProvider({
        respond: out({ verdict: "warn", summaryForParent: "Перевір.", unverifiable }),
      }),
    );
    expect(res).toMatchObject({ verdict: "warn", alertCreated: true });
    expect(res.uncheckedAlertCreated).toBeUndefined();
    const alerts = await db.alert.findMany();
    expect(alerts.map((x) => x.key)).toEqual([`quality:${id2}`]);
    expect(rowText(alerts[0])).toBe(
      'Take a look: "Приклади" (Математика): Перевір. Not checked automatically: Тест на платформі: результат лише на платформі.',
    );
  });

  it("skips versions that are not turned in", async () => {
    const id = await seed("created");
    const provider = new FakeProvider();
    expect(await run(id, provider)).toEqual({ status: "not_applicable" });
    expect(provider.calls).toHaveLength(0);
    expect(await run(999, provider)).toEqual({ status: "not_found" });
  });

  it("lists pending turned-in versions without an LLM result", async () => {
    const id = await seed();
    expect(await pendingQualityVersions(db, "llm:fake")).toEqual([id]);
    await run(id, new FakeProvider());
    expect(await pendingQualityVersions(db, "llm:fake")).toEqual([]);
    expect(await pendingQualityVersions(db, "llm:claude-cli")).toEqual([id]);
  });
});

describe("re-review on a new teacher comment (#44)", () => {
  let template: ReturnType<typeof migratedTemplate>;
  let db: Db;
  let dataDir: string;
  let n = 0;

  beforeAll(() => {
    template = migratedTemplate();
    dataDir = mkdtempSync(join(tmpdir(), "ca-rereview-"));
    mkdirSync(join(dataDir, "files"));
    writeFileSync(join(dataDir, "files/work.txt"), "1) 5 + 7 = 12\n2) 9 - 4 = 5");
  }, 60_000);
  afterAll(async () => {
    await template.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    db = await template.fresh();
  });

  async function seed(dueAt: Date | null = null) {
    const account = await upsertAccount(db, { email: "student-one@school.example" });
    await db.account.update({ where: { id: account.id }, data: { watched: true } });
    const course = await upsertCourse(db, {
      accountId: account.id,
      classroomId: "c1",
      name: "Математика",
    });
    const { assignment } = await upsertAssignment(
      db,
      {
        accountId: account.id,
        courseId: course.id,
        classroomId: "a1",
        kind: "assignment",
        title: "Приклади",
        status: "turned_in",
        dueAt,
        hash: "a",
        payload: { instructions: "Розв'яжи приклади 1-2." },
      },
      T0,
    );
    const { submission, version } = await upsertSubmission(
      db,
      { assignmentId: assignment.id, state: "turned_in", turnedInAt: T0, hash: "s", payload: {} },
      T0,
    );
    const [work] = await syncAttachments(
      db,
      { owner: "submission", assignmentId: assignment.id, submissionId: submission.id },
      [{ url: "https://docs.example/w", title: "Робота", driveFileId: "d1", mime: DOC }],
      T0,
    );
    if (!work || !version) throw new Error("seed failed");
    await setAttachmentContent(db, work.id, { contentPath: "files/work.txt", contentHash: "h" });
    return { versionId: version.id, assignmentId: assignment.id };
  }

  const comment = async (
    assignmentId: number,
    text: string,
    o: { role?: "teacher" | "student"; baseline?: boolean; at?: Date } = {},
  ) =>
    (
      await upsertComment(db, {
        assignmentId,
        classroomId: `cm${++n}`,
        authorRole: o.role ?? "teacher",
        text,
        postedAt: o.at ?? new Date(T0.getTime() + 60 * 60 * 1000),
        baseline: o.baseline ?? false,
      })
    ).comment.id;

  const run = (id: number, provider: FakeProvider, now = NOW) =>
    reviewSubmission(db, id, provider, cachedTextReader(dataDir), now);
  const pending = () => pendingQualityVersions(db, "llm:fake");

  it("re-reviews once per new teacher comment, with the comments in the input", async () => {
    const { versionId: id, assignmentId } = await seed();
    await comment(assignmentId, "lorem student note", { role: "student" });
    await run(id, new FakeProvider());
    expect(await pending()).toEqual([]);

    // Student and baseline teacher comments don't re-queue.
    await comment(assignmentId, "ipsum student", { role: "student" });
    await comment(assignmentId, "dolor old", { baseline: true });
    expect(await pending()).toEqual([]);

    const cid = await comment(assignmentId, "Молодець, гарно.");
    expect(await pending()).toEqual([id]);
    const provider = new FakeProvider();
    const res = await run(id, provider);
    expect(res).toEqual({
      status: "reviewed",
      verdict: "ok",
      alertCreated: false,
      triggerCommentId: cid,
    });
    expect(provider.calls[0]?.input.comments?.map((c) => c.text)).toEqual([
      "lorem student note",
      "ipsum student",
      "dolor old",
      "Молодець, гарно.",
    ]);
    const results = await listCheckResults(db, id);
    expect(results.map((r) => r.source)).toEqual(["heuristic", "llm:fake", "llm:fake"]);
    expect(results[2]?.throughCommentId).toBe(cid);
    expect(JSON.parse(results[2]?.findings ?? "{}").trigger).toEqual({ commentId: cid });

    expect(await pending()).toEqual([]);
    expect(await run(id, provider)).toEqual({ status: "already_reviewed" });
    expect(provider.calls).toHaveLength(1);
  });

  it("a re-review carries the unchecked parts; check-by-hand again only when they change", async () => {
    const { versionId: id, assignmentId } = await seed();
    const unverifiable = [{ what: "Тест на платформі", why: "результат лише на платформі" }];
    const p = new FakeProvider({ respond: out({ unverifiable }) });
    expect(await run(id, p)).toMatchObject({ verdict: "ok", uncheckedAlertCreated: true });

    // Same unchecked parts: stored on the re-review, no second check-by-hand alert.
    await comment(assignmentId, "Молодець.");
    expect(await run(id, p)).toMatchObject({ verdict: "ok", uncheckedAlertCreated: false });
    const results = await listCheckResults(db, id);
    expect(JSON.parse(results.at(-1)?.findings ?? "{}").unchecked).toEqual(unverifiable);
    expect((await db.alert.findMany()).map((a) => a.key)).toEqual([`quality:${id}:unchecked`]);

    // Worse verdict: the unchecked parts go into the re-review alert.
    const c2 = await comment(assignmentId, "Перевір ще раз.");
    const warn = new FakeProvider({
      respond: out({ verdict: "warn", summaryForParent: "Мало.", unverifiable }),
    });
    expect(await run(id, warn)).toMatchObject({ verdict: "warn", alertCreated: true });
    const alert = await db.alert.findUniqueOrThrow({ where: { key: `quality:${id}:c${c2}` } });
    expect(rowText(alert)).toContain("Not checked automatically: Тест на платформі");
  });

  it("a comment present at the first review doesn't trigger a re-review", async () => {
    const { versionId: id, assignmentId } = await seed();
    await comment(assignmentId, "Молодець.");
    expect(await pending()).toEqual([id]);
    expect(await run(id, new FakeProvider())).toMatchObject({ status: "reviewed" });
    expect(await pending()).toEqual([]);
  });

  it("alerts a re-review only when the verdict gets worse", async () => {
    const { versionId: id, assignmentId } = await seed();
    await run(id, new FakeProvider());
    const c1 = await comment(assignmentId, "Чому так мало?");
    const warn = new FakeProvider({ respond: out({ verdict: "warn", summaryForParent: "Мало." }) });
    expect(await run(id, warn)).toMatchObject({ verdict: "warn", alertCreated: true });
    const alert = await db.alert.findUniqueOrThrow({ where: { key: `quality:${id}:c${c1}` } });
    expect(alert.level).toBe("alert");
    expect(rowText(alert)).toContain("Мало.");

    // Same verdict again: stored, but no new alert.
    await comment(assignmentId, "Чекаю.");
    expect(await run(id, warn)).toMatchObject({ verdict: "warn", alertCreated: false });
    expect(await db.alert.count()).toBe(1);
  });

  it("an unaddressed redo request is at least warn, with a note when overdue", async () => {
    const due = new Date(T0.getTime() + 2 * 60 * 60 * 1000);
    const { versionId: id, assignmentId } = await seed(due);
    await run(id, new FakeProvider());
    const cid = await comment(assignmentId, "Переробіть, будь ласка, приклад 2.");
    const res = await run(id, new FakeProvider()); // the LLM says ok
    expect(res).toMatchObject({ verdict: "warn", alertCreated: true, triggerCommentId: cid });
    expect(contentText(res.content)).toContain("past due");
    const llm = (await listCheckResults(db, id)).at(-1);
    expect(JSON.parse(llm?.findings ?? "{}").merge.notes).toEqual([
      expect.stringContaining("Переробіть"),
    ]);
  });

  it("a re-review failure retries without repeating the first review's alerts", async () => {
    const { versionId: id, assignmentId } = await seed();
    await run(id, new FakeProvider());
    const cid = await comment(assignmentId, "Додай фото.");
    const failing = new FakeProvider({ respond: () => new LlmError("down") });
    expect(await run(id, failing)).toEqual({
      status: "fallback",
      llmFailures: 1,
      triggerCommentId: cid,
    });
    expect(await pending()).toEqual([id]);
    const heur = (await listCheckResults(db, id))[0];
    expect(JSON.parse(heur?.findings ?? "{}").llmFailures).toEqual({ [`llm:fake:c${cid}`]: 1 });
    expect(await db.alert.count()).toBe(0);
  });
});

describe("redo helpers", () => {
  const snap = (comments: NonNullable<TurnedInInput["comments"]>): TurnedInInput => ({
    ...snapshot(),
    comments,
  });
  const at = (h: number) => new Date(T0.getTime() + h * 60 * 60 * 1000);

  it("finds an open redo request: the latest teacher comment, after the turn-in", () => {
    const redo = { authorRole: "teacher" as const, postedAt: at(1), text: "Виправ приклад 2" };
    expect(openRedoRequest(snap([redo]))).toBe(redo);
    expect(openRedoRequest(snap([{ ...redo, postedAt: at(-1) }]))).toBeUndefined();
    expect(
      openRedoRequest(
        snap([redo, { authorRole: "teacher", postedAt: at(2), text: "Тепер добре" }]),
      ),
    ).toBeUndefined();
    expect(
      openRedoRequest(snap([redo, { authorRole: "student", postedAt: at(2), text: "ок" }])),
    ).toBe(redo);
    expect(openRedoRequest(snap([{ ...redo, text: "Молодець" }]))).toBeUndefined();
  });

  it("raises an ok LLM verdict to warn only", () => {
    const redo = { authorRole: "teacher" as const, postedAt: at(1), text: "redo" };
    const ok = { verdict: "ok" as const, basis: "llm" as const, notes: [] };
    expect(applyRedoFloor(ok, redo).verdict).toBe("warn");
    expect(applyRedoFloor(ok, undefined)).toBe(ok);
    const panic = { ...ok, verdict: "panic" as const };
    expect(applyRedoFloor(panic, redo)).toBe(panic);
  });
});
