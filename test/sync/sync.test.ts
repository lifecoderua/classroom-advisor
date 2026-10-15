import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { frame } from "../../scripts/anonymize.ts";
import { evaluateDeadlines } from "../../src/checks/evaluate-deadlines.ts";
import { loadTurnedInInput } from "../../src/checks/evaluate-heuristics.ts";
import { pendingQualityVersions } from "../../src/checks/quality.ts";
import type { ClassroomSession, Transport } from "../../src/collector/classroom/rpc.ts";
import type { AssignmentSummary } from "../../src/collector/classroom/todo.ts";
import { type HttpGet, SessionExpiredError } from "../../src/collector/files.ts";
import { buildReport } from "../../src/notify/console.ts";
import {
  type Account,
  type Db,
  listEvents,
  setWatchedAccounts,
  upsertAccount,
} from "../../src/store/index.ts";
import {
  diffAssignment,
  MAX_FULL_REFRESH_PER_SYNC,
  pickItems,
  statusOf,
  summaryHash,
  syncAccount,
  syncWatchList,
} from "../../src/sync/index.ts";
import { rowText } from "../alert-text.ts";
import { migratedTemplate } from "../store/helpers.ts";

const DIR = join(import.meta.dirname, "..", "..", "fixtures", "classroom");
// biome-ignore lint/suspicious/noExplicitAny: positional protobuf-JSON arrays
type J = any;
const fixture = (name: string): J => JSON.parse(readFileSync(join(DIR, name), "utf8")).response;

const STUDENT = "831760658545";
const COURSE = "342275451769";
const TEACHER = "744240834250";
const H = 3_600_000;
const NOW = new Date("2025-10-16T12:00:00Z");

const SESSION: ClassroomSession = {
  authuser: "user1@school.example",
  basePath: "/u/1",
  sourcePath: "/u/1/a/not-turned-in/all",
  at: "AT",
  fsid: "1",
  bl: "BL",
  hl: "en",
  userId: STUDENT,
};

/** In-memory Classroom built from the anonymized fixtures; tests mutate it between syncs. */
class FakeClassroom {
  items: J[] = structuredClone(fixture("todo.pONvgf.json")[2]);
  subs = new Map<string, J[]>(
    (fixture("submissions.Zj93ge.json")[2] as J[]).map((s) => [s[0][1][0], structuredClone(s)]),
  );
  atts = new Map<string, J[]>();
  /** Private comments per item id (`sLc6hf` rows). */
  comments = new Map<string, J[]>();
  calls: string[] = [];
  failWith: Error | undefined;
  /** Makes `sLc6hf` answer this payload instead (e.g. a drifted one). */
  commentsPayload: unknown;
  /** More submission keys than this in one `sLc6hf` call answer "has more". */
  commentsMaxKeys = Number.POSITIVE_INFINITY;

  readonly transport: Transport = async (url, body) => {
    const rpcid = new URL(url, "https://classroom.google.com").searchParams.get("rpcids") ?? "";
    this.calls.push(rpcid);
    if (this.failWith) throw this.failWith;
    const freq = JSON.parse(new URLSearchParams(body).get("f.req") ?? "");
    const args = JSON.parse(freq[0][0][1]);
    const payload = this.answer(rpcid, args);
    return frame([[["wrb.fr", rpcid, JSON.stringify(payload), null, null, null, "generic"]]]);
  };

  private answer(rpcid: string, args: J): unknown {
    switch (rpcid) {
      case "gXtzob":
        return fixture("courses.gXtzob.json");
      case "pONvgf":
        return ["hrsi.qr", [false], this.items];
      case "Zj93ge": {
        const ids = (args[2][2] as J[]).map((k) => String(k[1][0]));
        const attachmentsMask = JSON.stringify(args[1]) === "[null,1,null,1]";
        const rows = ids.flatMap((id) => {
          const s = this.subs.get(id);
          if (!s) return [];
          return [attachmentsMask ? [s[0], null, null, null, this.atts.get(id) ?? null] : s];
        });
        return ["hrq.sub", [false], rows];
      }
      case "t51ITc": {
        const [itemId, [courseId]] = args[1][0];
        const res = structuredClone(fixture("detail-materials.t51ITc.json"));
        for (const row of res[1]) row[2][0] = [String(itemId), [String(courseId)]];
        return res;
      }
      case "sLc6hf": {
        if (this.commentsPayload !== undefined) return this.commentsPayload;
        const ids = (args[2][3] as J[]).map((k) => String(k[1][0]));
        const rows = ids.flatMap((id) => this.comments.get(id) ?? []);
        // Pretend a page holds fewer comments: answer "more" with a partial page.
        if (ids.length > this.commentsMaxKeys) return ["hrq.cmt", [true], rows.slice(0, 1)];
        return ["hrq.cmt", [false], rows];
      }
      default:
        throw new Error(`unexpected rpc ${rpcid}`);
    }
  }

  item(id: string): J {
    const it = this.items.find((i) => i[1][0][0][0] === id);
    if (!it) throw new Error(`no item ${id}`);
    return it;
  }

  /** Adds a copy of item 0 under a new id, posted at `posted`, with a submission row. */
  addItem(id: string, posted: Date, opts: { dueAt?: Date; bucket?: number } = {}): void {
    const it = structuredClone(this.items[0]);
    it[1][0][0] = [id, [COURSE]];
    it[1][0][1] = posted.getTime();
    it[1][0][2] = posted.getTime();
    it[1][1][0] = opts.dueAt ? opts.dueAt.getTime() : null;
    this.items.unshift(it);
    const sub = structuredClone(this.subs.get("200322958360") as J[]);
    sub[0] = [STUDENT, [id, [COURSE]]];
    sub[5] = 4; // new
    sub[20] = opts.bucket ?? 1;
    sub[21] = null;
    this.subs.set(id, sub);
  }

  /** Adds a private comment (synthetic) on the student's submission of `itemId`. */
  addComment(itemId: string, id: string, by: "teacher" | "student", at: Date, text: string): void {
    const key = [STUDENT, [itemId, [COURSE]]];
    const row = [
      [id, null, key, 3],
      at.getTime(),
      at.getTime(),
      at.getTime(),
      [by === "teacher" ? TEACHER : STUDENT],
      null,
      null,
      2,
      [1],
      `c:${COURSE}:s:${itemId}:su:${STUDENT}:co:${id}`,
      null,
      ["edu.rt", text, null, null, [null, `<div>${text}</div>`]],
    ];
    this.comments.set(itemId, [...(this.comments.get(itemId) ?? []), row]);
  }

  /** Sets submission state `[5]`, bucket `[20]` and bumps `[2]`/`[21]`. */
  setSubmission(id: string, state: number, bucket: number, at: Date, grade?: number): void {
    const s = this.subs.get(id) as J[];
    s[5] = state;
    s[20] = bucket;
    s[2] = at.getTime();
    s[21] = at.getTime();
    if (grade !== undefined) s[8] = grade;
  }
}

/** A student photo attachment (origin 2), from the anonymized detail fixture. */
const PHOTO: J = fixture("detail-attachments.Zj93ge.json")[2][0][4][0];

const fakeGet =
  (calls: string[]): HttpGet =>
  async (url) => {
    calls.push(url);
    return {
      status: 200,
      url,
      headers: { "content-type": "image/jpeg" },
      body: Buffer.from("fake jpeg bytes"),
    };
  };

let template: ReturnType<typeof migratedTemplate>;
let db: Db;
let dataDir: string;

beforeAll(() => {
  template = migratedTemplate();
}, 60_000);
afterAll(() => template.cleanup());
beforeEach(async () => {
  db = await template.fresh();
  dataDir = mkdtempSync(join(tmpdir(), "ca-sync-"));
  return () => rmSync(dataDir, { recursive: true, force: true });
});

async function watchedAccount(): Promise<Account> {
  await setWatchedAccounts(db, [SESSION.authuser]);
  return upsertAccount(db, { email: SESSION.authuser });
}

async function sync(cr: FakeClassroom, now: Date, httpCalls: string[] = []) {
  const account = await db.account.findUniqueOrThrow({ where: { email: SESSION.authuser } });
  return syncAccount(
    db,
    account,
    { transport: cr.transport, session: SESSION, httpGet: fakeGet(httpCalls) },
    { now, dataDir, fullRefreshDays: 7 },
  );
}

const eventTypes = async () => (await listEvents(db)).map((e) => e.type).sort();

describe("syncAccount: baseline", () => {
  it("stores everything, emits no events and raises only the panics", async () => {
    await watchedAccount();
    const cr = new FakeClassroom();
    const files: string[] = [];
    const res = await sync(cr, NOW, files);

    expect(res.status).toBe("ok");
    expect(res.stats.baseline).toBe(true);
    expect(res.stats.items).toBe(12);
    expect(res.stats.details).toBe(12);
    expect(res.stats.assignments.new).toBe(12);
    expect(await db.assignment.count({ where: { baseline: true } })).toBe(12);
    expect(await db.submissionVersion.count({ where: { baseline: true } })).toBe(12);
    expect(await listEvents(db)).toEqual([]);
    expect(files).toEqual([]); // baseline work is never reviewed, so not downloaded
    const account = await db.account.findUniqueOrThrow({ where: { email: SESSION.authuser } });
    expect(account.baselineAt).toEqual(NOW);
    const runs = await db.syncRun.findMany();
    expect(runs.map((r) => [r.status, r.baseline])).toEqual([["ok", true]]);

    // Only the missing item panics; old open items get no reminders.
    const drafts = await evaluateDeadlines(db, NOW, { lookbackDays: 14 });
    expect(drafts.map((d) => d.code)).toEqual(["missing"]);
    // A day later every open item is untouched for > 24h: still no reminders, only the
    // item now due within 24h panics.
    const later = await evaluateDeadlines(db, new Date(NOW.getTime() + 24 * H), {
      lookbackDays: 14,
    });
    expect(later.map((d) => d.code)).toEqual(["due_soon"]);
    expect(await pendingQualityVersions(db, "llm:fake")).toEqual([]);
    // Slow on CI runners: one full baseline sync plus two rule passes.
  }, 20_000);

  it("maps buckets to statuses and stores instructions in the version payload", async () => {
    await watchedAccount();
    await sync(new FakeClassroom(), NOW);
    const rows = await db.assignment.findMany({ orderBy: { classroomId: "asc" } });
    const status = Object.fromEntries(rows.map((r) => [r.classroomId, r.status]));
    expect(status["535241786656"]).toBe("missing");
    expect(status["233229031112"]).toBe("excused");
    expect(status["978938961705"]).toBe("returned");
    expect(status["550213121836"]).toBe("turned_in");
    const a = rows.find((r) => r.classroomId === "200322958360") as { id: number };
    const v = await db.assignmentVersion.findFirstOrThrow({ where: { assignmentId: a.id } });
    expect(JSON.parse(v.payload).instructions.length).toBeGreaterThan(0);
  });

  it("is idempotent: a second identical sync writes no versions", async () => {
    await watchedAccount();
    const cr = new FakeClassroom();
    await sync(cr, NOW);
    const before = await db.assignmentVersion.count();
    const res = await sync(cr, new Date(NOW.getTime() + H));
    expect(res.stats.baseline).toBe(false);
    expect(res.stats.assignments.new + res.stats.assignments.updated).toBe(0);
    expect(res.stats.submissionVersions).toBe(0);
    // Only the open item due within 48h is re-fetched.
    expect(res.stats.picked).toEqual({ new: 0, changed: 0, due_soon: 1, refresh: 0 });
    expect(await db.assignmentVersion.count()).toBe(before);
    expect(await listEvents(db)).toEqual([]);
  });
});

describe("syncAccount: after the baseline", () => {
  it("emits each domain event once and fetches turned-in files", async () => {
    await watchedAccount();
    const cr = new FakeClassroom();
    await sync(cr, NOW);

    const t1 = new Date(NOW.getTime() + 2 * H);
    // Turned in with a photo.
    cr.setSubmission("200322958360", 2, 3, t1);
    cr.atts.set("200322958360", [PHOTO]);
    // Returned with a grade.
    cr.setSubmission("664328137076", 3, 8, t1, 10);
    // Unsubmitted.
    cr.setSubmission("609101298200", 5, 1, t1);
    // Teacher moved a deadline.
    const moved = cr.item("441339928087");
    moved[1][1][0] = new Date("2025-10-20T20:59:00Z").getTime();
    moved[1][0][2] = t1.getTime();
    // A new item, and a new one that is already missing.
    cr.addItem("999999999901", new Date(t1.getTime() - H));
    cr.addItem("999999999902", new Date(t1.getTime() - 48 * H), {
      dueAt: new Date(t1.getTime() - H),
      bucket: 2,
    });

    const files: string[] = [];
    const res = await sync(cr, t1, files);
    expect(res.error).toBeUndefined();
    expect(res.status).toBe("ok");
    expect(await eventTypes()).toEqual([
      "assignment.missing",
      "assignment.new",
      "assignment.new",
      "assignment.updated",
      "submission.returned",
      "submission.turned_in",
      "submission.unsubmitted",
    ]);
    const updated = (await listEvents(db)).find((e) => e.type === "assignment.updated");
    expect(Object.keys(JSON.parse(updated?.payload ?? "{}").changes)).toEqual(["dueAt"]);
    expect(files).toHaveLength(1);
    expect(res.stats.files.fetched).toBe(1);

    // The turned-in photo is cached and reviewable; baseline versions stay out of review.
    const pending = await pendingQualityVersions(db, "llm:fake");
    expect(pending).toHaveLength(2);
    const turnedIn = await db.assignment.findFirstOrThrow({
      where: { classroomId: "200322958360" },
      include: { attachments: true },
    });
    expect(turnedIn.attachments.filter((a) => a.owner === "submission")).toHaveLength(1);
    expect(turnedIn.attachments[0]?.contentPath).toMatch(/^files\//);

    // Rerun: nothing new.
    const again = await sync(cr, new Date(t1.getTime() + H), files);
    expect(again.stats.submissionVersions).toBe(0);
    expect(again.stats.events).toEqual({});
    expect(await listEvents(db)).toHaveLength(7);
    expect(files).toHaveLength(1);
  });

  it("applies reminders only to new items within the lookback", async () => {
    await watchedAccount();
    const cr = new FakeClassroom();
    await sync(cr, NOW);
    const t1 = new Date(NOW.getTime() + H);
    cr.addItem("999999999901", new Date(t1.getTime() - H));
    await sync(cr, t1);
    const later = new Date(t1.getTime() + 26 * H);
    const drafts = await evaluateDeadlines(db, later, { lookbackDays: 14 });
    // The baseline items get panics only (missing, due_soon); the new one its reminder.
    expect(drafts.map((d) => d.code).sort()).toEqual(["due_soon", "missing", "untouched_24h"]);
    const untouched = drafts.find((d) => d.code === "untouched_24h");
    const a = await db.assignment.findFirstOrThrow({ where: { classroomId: "999999999901" } });
    expect(untouched?.key).toBe(`deadline:${a.id}:untouched_24h`);
  });
});

describe("syncAccount: errors", () => {
  it("stops the account on an expired session, logs the run and alerts once a day", async () => {
    await watchedAccount();
    const cr = new FakeClassroom();
    cr.failWith = new SessionExpiredError("batchexecute pONvgf");
    const res = await sync(cr, NOW);
    expect(res.status).toBe("session_expired");
    await sync(cr, new Date(NOW.getTime() + H));
    const alerts = await db.alert.findMany();
    expect(alerts.map((a) => a.key)).toEqual([expect.stringMatching(/^sync:\d+:session_expired:/)]);
    const runs = await db.syncRun.findMany();
    expect(runs.map((r) => r.status)).toEqual(["session_expired", "session_expired"]);
    // Still baseline: the next good sync is the baseline.
    const account = await db.account.findUniqueOrThrow({ where: { email: SESSION.authuser } });
    expect(account.baselineAt).toBeNull();
    expect(cr.calls).not.toContain("t51ITc");
  });

  it("closes the lost-login and drift alerts once a sync of the account succeeds", async () => {
    await watchedAccount();
    const cr = new FakeClassroom();
    cr.failWith = new SessionExpiredError("batchexecute pONvgf");
    await sync(cr, NOW);
    cr.failWith = undefined;
    // An item drifts: the run is ok, the session alert closes, the drift alert stays.
    cr.subs.delete("441339928087");
    await sync(cr, new Date(NOW.getTime() + H));
    const open = async () =>
      (await db.alert.findMany({ where: { mutedAt: null } })).map((a) => a.key);
    expect(await open()).toEqual([expect.stringMatching(/^sync:\d+:drift:Zj93ge:/)]);
    const closed = await db.alert.findFirstOrThrow({ where: { key: { contains: "session" } } });
    expect(closed.muteReason).toBe("auto");
    // A clean run closes the drift alert too.
    cr.subs = new FakeClassroom().subs;
    await sync(cr, new Date(NOW.getTime() + 2 * H));
    expect(await open()).toEqual([]);
  });

  it("keeps going when one item's details fail", async () => {
    await watchedAccount();
    const cr = new FakeClassroom();
    // An item whose submission is gone from the detail call: that item drifts.
    cr.subs.delete("441339928087");
    const res = await sync(cr, NOW);
    expect(res.status).toBe("ok");
    expect(res.stats.detailErrors).toBe(1);
    expect(res.stats.details).toBe(11);
    expect((await db.alert.findMany()).map((a) => a.key)).toEqual([
      expect.stringMatching(/^sync:\d+:drift:Zj93ge:/),
    ]);
  });

  it("skips a drifted listed item, alerts once and syncs the rest (#68)", async () => {
    await watchedAccount();
    const cr = new FakeClassroom();
    cr.item("441339928087")[1][0][5] = 42; // title is not a string
    const res = await sync(cr, NOW);
    expect(res.status).toBe("ok");
    expect(res.stats.items).toBe(11);
    expect(res.stats.skippedItems).toBe(1);
    expect(res.stats.details).toBe(11);
    expect(await db.assignment.count()).toBe(11);
    expect((await db.alert.findMany()).map((a) => a.key)).toEqual([
      expect.stringMatching(/^sync:\d+:drift:pONvgf:/),
    ]);
  });
});

describe("syncAccount: private comments", () => {
  const at = (h: number) => new Date(NOW.getTime() + h * H);
  const commentAlerts = () =>
    db.alert.findMany({ where: { key: { startsWith: "comment:" } }, orderBy: { id: "asc" } });

  it("baseline stores comments silently; later only fresh ones raise events and alerts", async () => {
    await watchedAccount();
    const cr = new FakeClassroom();
    cr.addComment("200322958360", "111111111101", "teacher", at(-48), "lorem old note");
    const res = await sync(cr, NOW);
    expect(res.stats.comments).toEqual({
      fetched: 1,
      new: 0,
      teacherAlerts: 0,
      skipped: 0,
      errors: 0,
    });
    expect(cr.calls.filter((c) => c === "sLc6hf")).toHaveLength(1); // one batch for 12 items
    expect(await db.comment.count({ where: { baseline: true } })).toBe(1);
    expect(await listEvents(db)).toEqual([]);
    expect(await commentAlerts()).toEqual([]);

    const t1 = at(3);
    cr.addComment(
      "200322958360",
      "111111111102",
      "teacher",
      at(1),
      "redo exercise 3, attach photo",
    );
    cr.addComment("200322958360", "111111111103", "student", at(2), "ipsum ok");
    // Shows up only now but was posted before the baseline: old news.
    cr.addComment("664328137076", "111111111104", "teacher", at(-24), "lorem older");
    // A new item: its comments are fresh whatever their time.
    cr.addItem("999999999901", at(-1));
    cr.addComment("999999999901", "111111111105", "teacher", at(-0.5), "dolor new item");
    const r2 = await sync(cr, t1);
    expect(r2.stats.comments).toMatchObject({ fetched: 5, new: 3, teacherAlerts: 2, errors: 0 });
    expect(r2.stats.events["comment.new"]).toBe(3);
    const roles = await db.comment.findMany({
      where: { baseline: false },
      orderBy: { classroomId: "asc" },
    });
    expect(roles.map((c) => [c.classroomId, c.authorRole])).toEqual([
      ["111111111102", "teacher"],
      ["111111111103", "student"],
      ["111111111105", "teacher"],
    ]);
    const alerts = await commentAlerts();
    // A request to redo/attach is a panic; other teacher comments stay alerts.
    expect(alerts.map((a) => [a.level, rowText(a).includes("redo")]).sort()).toEqual([
      ["alert", false],
      ["panic", true],
    ]);
    expect(alerts.map((x) => rowText(x))).toContainEqual(
      expect.stringMatching(/^Teacher comment on ".+" \(.+\): redo exercise 3, attach photo$/),
    );

    // Rerun, with one comment edited: no new events or alerts, the text follows the edit.
    (cr.comments.get("200322958360") as J[])[1][11][1] = "redo exercise 4";
    const r3 = await sync(cr, at(4));
    expect(r3.stats.comments.new).toBe(0);
    expect(r3.stats.events).toEqual({});
    expect(await commentAlerts()).toHaveLength(2);
    const edited = await db.comment.findFirstOrThrow({ where: { classroomId: "111111111102" } });
    expect(edited.text).toBe("redo exercise 4");

    // The digest files the alerts under the account.
    const report = await buildReport(db, { now: at(4), watchedEmails: [SESSION.authuser] });
    expect(report.other).toEqual([]);
    const filed = [...(report.accounts[0]?.alerts ?? []), ...(report.accounts[0]?.panics ?? [])];
    expect(filed.map((a) => a.key)).toEqual(expect.arrayContaining(alerts.map((a) => a.key)));

    // The review snapshot carries the comments, oldest first.
    const a = await db.assignment.findFirstOrThrow({
      where: { classroomId: "200322958360" },
      include: { submission: { include: { versions: true } } },
    });
    const vid = a.submission?.versions[0]?.id as number;
    const snapshot = await loadTurnedInInput(db, vid, async () => undefined);
    expect(snapshot?.comments?.map((c) => [c.authorRole, c.text])).toEqual([
      ["teacher", "lorem old note"],
      ["teacher", "redo exercise 4"],
      ["student", "ipsum ok"],
    ]);
  });

  it("splits a batch whose answer has more pages", async () => {
    await watchedAccount();
    const cr = new FakeClassroom();
    cr.commentsMaxKeys = 4;
    cr.addComment("200322958360", "111111111101", "teacher", at(-48), "lorem");
    cr.addComment("233229031112", "111111111102", "student", at(-47), "ipsum");
    const res = await sync(cr, NOW);
    expect(res.stats.comments.fetched).toBe(2);
    expect(cr.calls.filter((c) => c === "sLc6hf").length).toBeGreaterThan(1);
  });

  it("a drifted comments answer raises a drift alert and the sync still succeeds", async () => {
    await watchedAccount();
    const cr = new FakeClassroom();
    cr.commentsPayload = ["hrq.sub", [false], []];
    const res = await sync(cr, NOW);
    expect(res.status).toBe("ok");
    expect(res.stats.comments.errors).toBe(1);
    expect((await db.alert.findMany()).map((a) => a.key)).toContainEqual(
      expect.stringMatching(/^sync:\d+:drift:sLc6hf:/),
    );
  });
});

describe("pickItems", () => {
  const summary = (id: string, extra: Partial<AssignmentSummary> = {}): AssignmentSummary => ({
    id,
    courseId: COURSE,
    courseName: "c",
    title: id,
    kind: "assignment",
    dueAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    bucket: "assigned",
    submissionState: "new",
    bucketCode: 1,
    grade: null,
    maxPoints: null,
    attachmentCount: 0,
    submissionUpdatedAt: null,
    url: "https://classroom.google.com/",
    ...extra,
  });

  it("picks new, changed, due-soon and (capped) stale items", () => {
    const fresh = { detailFetchedAt: NOW };
    const soon = summary("soon", { dueAt: new Date(NOW.getTime() + 30 * H) });
    const done = summary("done", { dueAt: soon.dueAt, bucket: "turned_in" });
    const same = summary("same");
    const changed = summary("changed");
    const known = new Map([
      ["soon", { id: 1, summaryHash: summaryHash(soon), ...fresh }],
      ["done", { id: 2, summaryHash: summaryHash(done), ...fresh }],
      ["same", { id: 3, summaryHash: summaryHash(same), ...fresh }],
      ["changed", { id: 4, summaryHash: "old", ...fresh }],
    ]);
    const stale = Array.from({ length: MAX_FULL_REFRESH_PER_SYNC + 5 }, (_, i) =>
      summary(`stale${i}`),
    );
    for (const [i, s] of stale.entries()) {
      known.set(s.id, {
        id: 10 + i,
        summaryHash: summaryHash(s),
        detailFetchedAt: new Date(NOW.getTime() - (8 + i) * 24 * H),
      });
    }
    const picks = pickItems([soon, done, same, changed, summary("new"), ...stale], known, NOW, 7);
    expect(picks.get("new")).toBe("new");
    expect(picks.get("changed")).toBe("changed");
    expect(picks.get("soon")).toBe("due_soon");
    expect(picks.has("done")).toBe(false);
    expect(picks.has("same")).toBe(false);
    const refreshed = [...picks].filter(([, r]) => r === "refresh").map(([id]) => id);
    expect(refreshed).toHaveLength(MAX_FULL_REFRESH_PER_SYNC);
    expect(refreshed[0]).toBe(`stale${MAX_FULL_REFRESH_PER_SYNC + 4}`); // stalest first
  });
});

describe("helpers", () => {
  it("statusOf maps buckets", () => {
    expect(statusOf("done_late", "turned_in")).toBe("turned_in");
    expect(statusOf("graded_late", "returned")).toBe("returned");
    expect(statusOf("unknown", null)).toBe("assigned");
    expect(statusOf("unknown", "returned")).toBe("returned");
  });

  it("diffAssignment reports changed fields and materials", () => {
    const base = {
      id: "1",
      courseId: "2",
      kind: "assignment" as const,
      title: "t",
      instructions: "i",
      instructionsHtml: null,
      dueAt: null,
      maxPoints: null,
      createdAt: null,
      materials: [],
    };
    const next = {
      ...base,
      dueAt: "2025-10-20T20:59:00.000Z",
      materials: [{ title: "m", url: "https://example.com/m" }] as never,
    };
    expect(diffAssignment(base, next)).toEqual({
      dueAt: { from: null, to: "2025-10-20T20:59:00.000Z" },
      materials: { from: [], to: ["m <https://example.com/m>"] },
    });
    expect(diffAssignment(base, base)).toEqual({});
  });

  it("syncWatchList mirrors the config list to Account.watched", async () => {
    await upsertAccount(db, { email: "old@school.example" });
    await setWatchedAccounts(db, ["old@school.example"]);
    const rows = await syncWatchList(db, ["New@School.example"]);
    expect(rows.map((r) => r.email)).toEqual(["new@school.example"]);
    const old = await db.account.findUniqueOrThrow({ where: { email: "old@school.example" } });
    expect(old.watched).toBe(false);
  });

  it("loadTurnedInInput reads instructions written by sync", async () => {
    await watchedAccount();
    const cr = new FakeClassroom();
    await sync(cr, NOW);
    cr.setSubmission("200322958360", 2, 3, new Date(NOW.getTime() + H));
    await sync(cr, new Date(NOW.getTime() + H));
    const [id] = await pendingQualityVersions(db, "llm:fake");
    const input = await loadTurnedInInput(db, id as number, async () => undefined);
    expect(input?.assignment.instructions.length).toBeGreaterThan(0);
  });
});
