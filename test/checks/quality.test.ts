import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cachedImagePath, cachedTextReader } from "../../src/checks/evaluate-heuristics.ts";
import type { TurnedInInput, TurnedInResult } from "../../src/checks/heuristics.ts";
import {
  allocate,
  buildReviewInput,
  DEFAULT_BUDGET,
  detectLocale,
  heuristicVerdict,
  mergeVerdict,
  pendingQualityVersions,
  REVIEW_PROMPT_VERSION,
  reviewPrompt,
  reviewSubmission,
  truncate,
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
  upsertCourse,
  upsertSubmission,
} from "../../src/store/index.ts";
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

  it("detects the locale", () => {
    expect(detectLocale("Виконай вправу 5")).toBe("uk");
    expect(detectLocale("Do exercise 5")).toBe("en");
    expect(detectLocale("123")).toBeUndefined();
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
    expect(REVIEW_PROMPT_VERSION).toBe("review.v2");
    expect(reviewPrompt()).toContain("hints, not facts");
    expect(reviewPrompt()).toContain("`comments`");
    expect(reviewPrompt()).toContain("`structure`");
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
    expect(call?.opts.instructions).toContain("review.v2");
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
      promptVersion: "review.v2",
      output: { missingParts: ["Приклад 3"] },
    });

    const alert = await db.alert.findUnique({ where: { key: `quality:${id}` } });
    expect(alert?.level).toBe("panic");
    expect(alert?.message).toContain("Приклад 3 не розв'язано.");
    expect(alert?.message).toContain('"Приклади" (Математика)');
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
    // No cached text for the doc → fetch_failed (0.9): a heuristics warn, but no direct verdict.
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
    expect(alert?.message).toContain("couldn't run");
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
    expect(res.message).toContain("heuristics only");
    expect((await db.alert.findUnique({ where: { key: `quality:${id}` } }))?.level).toBe("panic");
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
