import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { countAutoClosed, MUTE_NO_WORK } from "../../src/checks/auto-ack.ts";
import { evaluateDeadlines } from "../../src/checks/evaluate-deadlines.ts";
import {
  buildClassifierInput,
  classifyVersion,
  EXPECTS_WORK_BUDGET,
  expectsWorkPrompt,
  normalizeSkeleton,
  SKELETON_SOURCE,
  skeletonHash,
} from "../../src/checks/expects-work.ts";
import { FakeProvider, type JsonTask, LlmError } from "../../src/llm/index.ts";
import {
  type Db,
  raiseAlert,
  setWatchedAccounts,
  syncAttachments,
  upsertAccount,
  upsertAssignment,
  upsertCourse,
} from "../../src/store/index.ts";
import { migratedTemplate } from "../store/helpers.ts";

// Synthetic weekly lesson invites: only the time, topic, meeting id and passcode differ.
const invite = (o: { day: string; time: string; topic: string; id: string; pwd: string }) =>
  [
    "Teacher X is inviting you to a scheduled Zoom meeting.",
    "",
    `Topic: ${o.topic}`,
    `Time: ${o.day}, 2026 ${o.time} Kyiv`,
    "",
    "Join Zoom Meeting",
    `https://us02web.zoom.us/j/${o.id.replace(/ /g, "")}?pwd=${o.pwd}Qx7`,
    "",
    `Meeting ID: ${o.id}`,
    `Passcode: ${o.pwd}`,
  ].join("\n");

const WEEK1 = invite({
  day: "Oct 5",
  time: "10:35 AM",
  topic: "6A",
  id: "811 2345 6789",
  pwd: "k3Lm9",
});
const WEEK2 = invite({
  day: "Oct 12",
  time: "2:05 PM",
  topic: "6B",
  id: "822 9876 5432",
  pwd: "Zq81x",
});
const WEEK3 = invite({
  day: "Nov 2",
  time: "9:00 AM",
  topic: "6A",
  id: "833 1111 2222",
  pwd: "a1b2c",
});
const HOMEWORK = `${WEEK2}\n\nHomework: exercise 5 on page 45.`;

describe("normalizeSkeleton", () => {
  it("lowercases, masks urls (keeping the host), times, dates and numbers, collapses spaces", () => {
    expect(
      normalizeSkeleton(
        "Lesson  6A\tat 10:35 AM, Oct 5 2026:\n https://us02web.zoom.us/j/123?pwd=x  ID 811 2345",
      ),
    ).toBe("lesson <n> at <time>, <date> <n> <n>: <url:usNweb.zoom.us> id <n> <n>");
  });

  it("handles Ukrainian and Russian dates", () => {
    expect(normalizeSkeleton("Урок 12 жовтня, понеділок, 10.35")).toBe(
      "урок <n> <date>, <date>, <time>",
    );
    expect(normalizeSkeleton("Урок 12 октября, среда")).toBe("урок <n> <date>, <date>");
  });

  it("keeps words that carry the task", () => {
    expect(normalizeSkeleton("Вправа 5, ст. 45")).toBe("вправа <n>, ст. <n>");
  });

  it("weekly invites share one skeleton; homework or another host changes it", () => {
    const key = (description: string, attachments: string[] = []) =>
      skeletonHash({ title: "Technology 6A", description, attachments });
    expect(key(WEEK2)).toBe(key(WEEK1));
    expect(key(WEEK3)).toBe(key(WEEK1));
    expect(key(HOMEWORK)).not.toBe(key(WEEK1));
    expect(key(WEEK1.replace("us02web.zoom.us", "docs.example.test"))).not.toBe(key(WEEK1));
    expect(key(WEEK1, ["hash:abc"])).not.toBe(key(WEEK1));
    expect(key(WEEK1, ["id:b", "id:a"])).toBe(key(WEEK1, ["id:a", "id:b"]));
  });
});

describe("buildClassifierInput", () => {
  it("truncates the description and the attachment texts", () => {
    const out = buildClassifierInput({
      title: "T",
      description: "d".repeat(10_000),
      attachments: [
        { title: "a", kind: "doc", text: "x".repeat(10_000) },
        { title: "b", kind: "doc", text: "short" },
        { title: "c", kind: "link" },
      ],
    });
    expect(out.description.length).toBe(EXPECTS_WORK_BUDGET.description);
    expect(out.attachments[1]?.text).toBe("short");
    expect(out.attachments[0]?.text?.length).toBeLessThanOrEqual(EXPECTS_WORK_BUDGET.attachments);
    expect(out.attachments[2]).toEqual({ title: "c", kind: "link" });
  });

  it("the prompt states the rules", () => {
    const p = expectsWorkPrompt();
    expect(p).toContain("call invite");
    expect(p).toMatch(/`unclear`/);
    expect(p).toMatch(/page or exercise numbers/);
  });
});

// ---------------------------------------------------------------------------------------------
// Store-backed

const T0 = new Date("2026-10-01T08:00:00Z");
const NOW = new Date("2026-10-10T08:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

let template: ReturnType<typeof migratedTemplate>;
let db: Db;

beforeAll(() => {
  template = migratedTemplate();
}, 60_000);
afterAll(() => template.cleanup());
beforeEach(async () => {
  db = await template.fresh();
});

/** Answers from the post description: homework words → yes, else no. */
function classifier(over: Partial<{ fail: boolean; verdict: string }> = {}) {
  return new FakeProvider({
    respondJson: (task: JsonTask<unknown>) => {
      if (over.fail) return new LlmError("boom");
      if (over.verdict) return { expectsWork: over.verdict, reason: "fixed" };
      const desc = (task.input as { description: string }).description;
      return /homework|exercise/i.test(desc)
        ? { expectsWork: "yes", reason: "asks for an exercise" }
        : { expectsWork: "no", reason: "only a call invite" };
    },
  });
}

async function seed(email = "student-one@school.example") {
  const account = await upsertAccount(db, { email });
  await setWatchedAccounts(db, [
    ...(await db.account.findMany({ where: { watched: true } })).map((a) => a.email),
    email,
  ]);
  const course = await upsertCourse(db, { accountId: account.id, classroomId: "c1", name: "Tech" });
  let n = 0;
  const add = async (
    description: string,
    over: {
      dueAt?: Date | null;
      postedAt?: Date;
      classroomId?: string;
      materials?: unknown[];
    } = {},
  ) => {
    const classroomId = over.classroomId ?? `w${++n}`;
    const payload = {
      title: "Technology 6A",
      instructions: description,
      materials: over.materials ?? [],
    };
    const res = await upsertAssignment(
      db,
      {
        accountId: account.id,
        courseId: course.id,
        classroomId,
        kind: "assignment",
        title: "Technology 6A",
        dueAt: over.dueAt ?? null,
        postedAt: over.postedAt ?? new Date(NOW.getTime() - 3 * DAY),
        status: "assigned",
        hash: JSON.stringify(payload),
        payload,
      },
      T0,
    );
    return { assignment: res.assignment, versionId: res.version?.id as number };
  };
  return { account, add };
}

const version = (id: number) => db.assignmentVersion.findUniqueOrThrow({ where: { id } });

describe("classifyVersion", () => {
  it("asks the LLM once, then reuses the verdict for the same skeleton (weekly invite)", async () => {
    const { add } = await seed();
    const w1 = await add(WEEK1);
    const w2 = await add(WEEK2);
    const w3 = await add(WEEK3);
    const provider = classifier();

    expect(await classifyVersion(db, w1.versionId, { provider, now: NOW })).toEqual({
      status: "llm",
      expectsWork: "no",
    });
    expect(await classifyVersion(db, w2.versionId, { provider, now: NOW })).toEqual({
      status: "skeleton",
      expectsWork: "no",
    });
    // The cache answers even when the run's LLM budget is used up.
    expect(
      await classifyVersion(db, w3.versionId, { provider, now: NOW, allowLlm: false }),
    ).toEqual({ status: "skeleton", expectsWork: "no" });
    expect(provider.jsonCalls).toHaveLength(1);

    const v1 = await version(w1.versionId);
    const v2 = await version(w2.versionId);
    expect(v1).toMatchObject({
      expectsWork: "no",
      expectsWorkReason: "only a call invite",
      expectsWorkSource: "llm:fake",
      expectsWorkAt: NOW,
    });
    expect(v2).toMatchObject({ expectsWork: "no", expectsWorkSource: SKELETON_SOURCE });
    expect(v2.skeletonHash).toBe(v1.skeletonHash);

    // Classified once: a second call does nothing.
    expect(await classifyVersion(db, w1.versionId, { provider })).toEqual({
      status: "cached",
      expectsWork: "no",
    });
    expect(provider.jsonCalls).toHaveLength(1);
  });

  it("sends title, description and attachments, and misses the cache on a different post", async () => {
    const { add } = await seed();
    const w1 = await add(WEEK1);
    const hw = await add(HOMEWORK, {
      materials: [{ title: "Worksheet", url: "https://docs.example.test/d/1", driveFileId: "f1" }],
    });
    const provider = classifier();
    await classifyVersion(db, w1.versionId, { provider });
    expect(await classifyVersion(db, hw.versionId, { provider })).toEqual({
      status: "llm",
      expectsWork: "yes",
    });
    const input = provider.jsonCalls[1]?.input;
    expect(input).toMatchObject({
      title: "Technology 6A",
      attachments: [{ title: "Worksheet", kind: "link" }],
    });
    expect((input as { description: string }).description).toContain("exercise 5");
  });

  it("folds attachment content into the skeleton and passes cached text", async () => {
    const { add } = await seed();
    const materials = [{ title: "Plan", url: "https://docs.example.test/d/2", driveFileId: "f2" }];
    const a = await add(WEEK1, { materials });
    await syncAttachments(
      db,
      { owner: "material", assignmentId: a.assignment.id },
      [{ url: "https://docs.example.test/d/2", driveFileId: "f2", title: "Plan" }],
      T0,
    );
    await db.attachment.updateMany({
      data: { contentPath: "files/f2/nomod.txt", contentHash: "c0ffee" },
    });
    const provider = classifier({ verdict: "unclear" });
    await classifyVersion(db, a.versionId, {
      provider,
      readText: async () => "Read chapter 3.",
    });
    expect(provider.jsonCalls[0]?.input).toMatchObject({
      attachments: [{ title: "Plan", text: "Read chapter 3." }],
    });
    const plain = await add(WEEK1);
    await classifyVersion(db, plain.versionId, { provider });
    const [va, vp] = [await version(a.versionId), await version(plain.versionId)];
    expect(va.skeletonHash).not.toBe(vp.skeletonHash);
  });

  it("never reuses `unclear`, a verdict of another account, or a failed call", async () => {
    const one = await seed();
    const two = await seed("student-two@school.example");
    const unclear = classifier({ verdict: "unclear" });
    const u1 = await one.add(WEEK1);
    const u2 = await one.add(WEEK2);
    await classifyVersion(db, u1.versionId, { provider: unclear });
    expect(await classifyVersion(db, u2.versionId, { provider: unclear })).toMatchObject({
      status: "llm",
    });

    const provider = classifier();
    const n1 = await one.add(WEEK3);
    await db.assignmentVersion.updateMany({ data: { expectsWork: null, expectsWorkSource: null } });
    await classifyVersion(db, n1.versionId, { provider });
    const other = await two.add(WEEK1);
    expect(await classifyVersion(db, other.versionId, { provider })).toMatchObject({
      status: "llm",
    });

    const failing = classifier({ fail: true });
    const f = await one.add(`${WEEK1}\nSee you!`);
    expect(await classifyVersion(db, f.versionId, { provider: failing })).toMatchObject({
      status: "failed",
    });
    expect(await version(f.versionId)).toMatchObject({ expectsWork: null });
    expect((await version(f.versionId)).skeletonHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await classifyVersion(db, f.versionId, { provider, allowLlm: false })).toEqual({
      status: "deferred",
    });
  });
});

describe("evaluateDeadlines with expects-work", () => {
  const opts = (provider: FakeProvider, maxPerRun = 20) => ({
    lookbackDays: 14,
    expectsWork: { provider, maxPerRun },
  });
  const openKeys = async () =>
    (await db.alert.findMany({ where: { mutedAt: null }, orderBy: { id: "asc" } })).map(
      (a) => a.key,
    );

  it("suppresses the reminders of a `no` post and keeps the panics", async () => {
    const { add } = await seed();
    const invitePost = await add(WEEK1);
    const homework = await add(HOMEWORK);
    const overdue = await add(WEEK2, { dueAt: new Date(NOW.getTime() - DAY) });
    const provider = classifier();

    const created = await evaluateDeadlines(db, NOW, opts(provider));
    expect(created.map((d) => d.key)).toEqual([
      `deadline:${homework.assignment.id}:untouched_24h`,
      `deadline:${overdue.assignment.id}:missing`,
    ]);
    // The overdue post's reminder can't fire (its panic covers it), so it isn't classified.
    expect(provider.jsonCalls).toHaveLength(2);
    expect(await version(invitePost.versionId)).toMatchObject({ expectsWork: "no" });
    expect(await version(overdue.versionId)).toMatchObject({ expectsWork: null });

    // A week later: `no_due_date` stays suppressed too, and nothing is asked again.
    await evaluateDeadlines(db, new Date(NOW.getTime() + 5 * DAY), opts(provider));
    expect(provider.jsonCalls).toHaveLength(2);
    expect(
      (await openKeys()).filter((k) => k.startsWith(`deadline:${invitePost.assignment.id}:`)),
    ).toEqual([]);
  });

  it("mutes already-open reminders silently when the post asks for no work", async () => {
    const { add } = await seed();
    const post = await add(WEEK1);
    const key = `deadline:${post.assignment.id}:untouched_24h`;
    await raiseAlert(db, { key, level: "alert", code: "text", params: { text: "x" } }, NOW);

    await evaluateDeadlines(db, NOW, opts(classifier()));
    const alert = await db.alert.findUniqueOrThrow({ where: { key } });
    expect(alert).toMatchObject({ mutedAt: NOW, muteReason: MUTE_NO_WORK, sentAt: NOW });
    // Silent: not counted as "closed automatically".
    expect(await countAutoClosed(db, new Date(NOW.getTime() - DAY))).toBe(0);
  });

  it("an edit (new version) is reclassified and a muted reminder comes back", async () => {
    const { add } = await seed();
    const first = await add(WEEK1, { classroomId: "lesson" });
    const key = `deadline:${first.assignment.id}:untouched_24h`;
    await raiseAlert(db, { key, level: "alert", code: "text", params: { text: "x" } }, T0);
    const provider = classifier();
    await evaluateDeadlines(db, NOW, opts(provider));
    expect(await openKeys()).toEqual([]);

    // The teacher adds homework to the post: a new content version.
    const edited = await add(HOMEWORK, { classroomId: "lesson" });
    expect(edited.versionId).not.toBe(first.versionId);
    const later = new Date(NOW.getTime() + 60_000);
    const created = await evaluateDeadlines(db, later, opts(provider));
    expect(provider.jsonCalls).toHaveLength(2);
    expect(await version(edited.versionId)).toMatchObject({ expectsWork: "yes" });
    expect(created.map((d) => d.key)).toEqual([key]);
    expect(await db.alert.findUniqueOrThrow({ where: { key } })).toMatchObject({
      mutedAt: null,
      muteReason: null,
      sentAt: null,
      createdAt: later,
    });
  });

  it("bounds the LLM calls per run; the rest keeps today's behavior until a later run", async () => {
    const { add } = await seed();
    const posts = [];
    for (const text of ["A homework", "B call", "C call", "D exercise"]) {
      posts.push(await add(text));
    }
    const provider = classifier();
    const created = await evaluateDeadlines(db, NOW, opts(provider, 2));
    expect(provider.jsonCalls).toHaveLength(2);
    // Unclassified posts still get their reminder.
    expect(created).toHaveLength(3);
    await evaluateDeadlines(db, NOW, opts(provider, 2));
    expect(provider.jsonCalls).toHaveLength(4);
    const verdicts = await Promise.all(posts.map((p) => version(p.versionId)));
    expect(verdicts.map((v) => v.expectsWork)).toEqual(["yes", "no", "no", "yes"]);
    // The `no` post that got a reminder in the first run is muted in the second.
    expect((await openKeys()).length).toBe(2);
  });

  it("an LLM failure keeps the reminder", async () => {
    const { add } = await seed();
    const post = await add(WEEK1);
    const created = await evaluateDeadlines(db, NOW, opts(classifier({ fail: true })));
    expect(created.map((d) => d.key)).toEqual([`deadline:${post.assignment.id}:untouched_24h`]);
  });
});
