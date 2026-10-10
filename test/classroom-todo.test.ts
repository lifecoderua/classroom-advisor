import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { frame } from "../scripts/anonymize.ts";
import { parseItem } from "../src/collector/classroom/detail.ts";
import { ParseDriftError } from "../src/collector/classroom/parse-util.ts";
import type { ClassroomSession, Transport } from "../src/collector/classroom/rpc.ts";
import {
  countByBucket,
  detailsUrl,
  joinSummaries,
  listTodo,
  parseCourses,
  parseSubmissions,
  parseTodoPage,
} from "../src/collector/classroom/todo.ts";

const DIR = join(import.meta.dirname, "..", "fixtures", "classroom");
// biome-ignore lint/suspicious/noExplicitAny: positional protobuf-JSON arrays
type J = any;
const fixture = (name: string): { rpcid: string; request: J; response: J } =>
  JSON.parse(readFileSync(join(DIR, name), "utf8"));
const clone = <T>(v: T): T => structuredClone(v);

const COURSES = fixture("courses.gXtzob.json").response;
const TODO = fixture("todo.pONvgf.json").response;
const SUBS = fixture("submissions.Zj93ge.json").response;
const COURSE_ID = "342275451769";

const SESSION: ClassroomSession = {
  authuser: "user1@school.example",
  basePath: "/u/1",
  sourcePath: "/u/1/a/not-turned-in/all",
  at: "AT",
  fsid: "1",
  bl: "BL",
  hl: "en",
  userId: "831760658545",
};

const wrap = (rpcid: string, payload: unknown) =>
  frame([[["wrb.fr", rpcid, JSON.stringify(payload), null, null, null, "generic"]], [["di", 7]]]);

interface Call {
  rpcid: string;
  args: J;
}

/** Fake batchexecute: answers from `handlers` and records decoded args. */
function fakeTransport(handlers: Record<string, (args: J, n: number) => unknown>): {
  transport: Transport;
  calls: Call[];
} {
  const calls: Call[] = [];
  const transport: Transport = async (url, body) => {
    const rpcid = new URL(url, "https://classroom.google.com").searchParams.get("rpcids") ?? "";
    const freq = JSON.parse(new URLSearchParams(body).get("f.req") ?? "");
    const args = JSON.parse(freq[0][0][1]);
    const n = calls.filter((c) => c.rpcid === rpcid).length;
    calls.push({ rpcid, args });
    const handler = handlers[rpcid];
    if (!handler) throw new Error(`unexpected rpc ${rpcid}`);
    return wrap(rpcid, handler(args, n));
  };
  return { transport, calls };
}

describe("parsers on fixtures", () => {
  it("gXtzob: courses with state", () => {
    const { rows, hasMore } = parseCourses(COURSES);
    expect(hasMore).toBe(false);
    expect(rows).toHaveLength(3);
    expect(rows.filter((c) => c.active).map((c) => c.id)).toEqual([COURSE_ID]);
    expect(rows[0]?.name).toBe("nisi aliquip ex");
  });

  it("pONvgf: items and paging", () => {
    const page = parseTodoPage(TODO);
    expect(page.hasMore).toBe(true);
    expect(page.nextPageToken).toBe(TODO[1][1][0]);
    expect(page.rows).toHaveLength(12);
    const first = page.rows[0];
    expect(first).toMatchObject({
      id: "200322958360",
      courseId: COURSE_ID,
      kind: "assignment",
      title: "do eiusmod",
      dueAt: null,
      maxPoints: 100,
    });
    const due = page.rows.find((r) => r.id === "441339928087");
    expect(due?.dueAt).toEqual(new Date(1760734740000));
    expect(due?.maxPoints).toBeNull();
  });

  it("material posts: body at [5], no due date", () => {
    const item = fixture("material-detail.tQShAc.json").response[1][0][2];
    const m = parseItem(item);
    expect(m.kind).toBe("material");
    expect(m.dueAt).toBeNull();
    expect(m.id).toMatch(/^\d+$/);
    expect(detailsUrl(m.courseId, m.id, m.kind, "a@b.example")).toContain("/m/");
  });

  it("Zj93ge: state, bucket, grade, attachment count", () => {
    const subs = parseSubmissions(SUBS);
    expect(subs).toHaveLength(12);
    const graded = subs.find((s) => s.key.itemId === "978938961705");
    expect(graded).toMatchObject({
      state: "returned",
      bucket: "graded",
      bucketCode: 8,
      grade: 9,
      attachmentCount: 2,
    });
    expect(subs[0]?.key).toEqual({
      studentId: "831760658545",
      itemId: "200322958360",
      courseId: COURSE_ID,
    });
    expect(subs[0]?.state).toBe("new");
  });

  it("Zj93ge with attachments mask parses too", () => {
    const [s] = parseSubmissions(fixture("detail-attachments.Zj93ge.json").response);
    expect(s?.attachmentCount).toBeGreaterThan(0);
  });
});

describe("joinSummaries", () => {
  const items = parseTodoPage(TODO).rows;
  const subs = parseSubmissions(SUBS);
  const courses = parseCourses(COURSES).rows;

  it("joins by item key and maps every observed bucket", () => {
    const rows = joinSummaries(items, subs, courses, SESSION.authuser);
    expect(rows).toHaveLength(12);
    expect(countByBucket(rows)).toEqual({
      assigned: 2,
      missing: 1,
      turned_in: 2,
      done_late: 1,
      returned: 1,
      graded: 2,
      graded_late: 1,
      excused: 2,
      unknown: 0,
    });
    const r = rows.find((x) => x.id === "535241786656");
    expect(r).toMatchObject({
      courseName: "nisi aliquip ex",
      bucket: "missing",
      submissionState: "new",
      maxPoints: 100,
      grade: null,
      attachmentCount: 0,
    });
    expect(r?.dueAt).toEqual(new Date(1760129940000));
    expect(r?.dueAt?.toISOString()).toBe("2025-10-10T20:59:00.000Z");
    expect(r?.url).toBe(
      "https://classroom.google.com/c/MzQyMjc1NDUxNzY5/a/NTM1MjQxNzg2NjU2/details?authuser=user1%40school.example",
    );
  });

  it("an item without a submission gets bucket unknown", () => {
    const rows = joinSummaries(items, subs.slice(1), courses, SESSION.authuser);
    expect(rows[0]).toMatchObject({ bucket: "unknown", submissionState: null, bucketCode: null });
  });

  it("raises drift when no submission matches any item", () => {
    expect(() => joinSummaries(items, [], courses, SESSION.authuser)).toThrow(ParseDriftError);
  });
});

describe("listTodo", () => {
  it("pages pONvgf per active course and batches Zj93ge", async () => {
    const page2 = ["hrsi.qr", [false], []];
    const { transport, calls } = fakeTransport({
      gXtzob: () => COURSES,
      pONvgf: (_args, n) => (n === 0 ? TODO : page2),
      Zj93ge: () => SUBS,
    });
    const { courses, summaries } = await listTodo(transport, SESSION);
    expect(courses).toHaveLength(3);
    expect(summaries).toHaveLength(12);
    expect(calls.map((c) => c.rpcid)).toEqual(["gXtzob", "pONvgf", "pONvgf", "Zj93ge"]);

    const [q1, q2] = calls.filter((c) => c.rpcid === "pONvgf");
    expect(q1?.args[0][1]).toBeNull();
    expect(q2?.args[0][1]).toBe(TODO[1][1][0]); // next page token sent back
    expect(q1?.args[2][0][1]).toEqual([[Number(COURSE_ID)]]); // active course only
    expect(q1?.args[2][0][14]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

    const keys = calls.find((c) => c.rpcid === "Zj93ge")?.args[2][2];
    expect(keys).toHaveLength(12);
    expect(keys[0]).toEqual([831760658545, [200322958360, [342275451769]]]);
  });

  it("splits submissions into batches of 100", async () => {
    const many = clone(TODO);
    many[1] = [false];
    const template = many[2][0];
    many[2] = Array.from({ length: 150 }, (_, i) => {
      const it = clone(template);
      it[1][0][0][0] = String(100000000000 + i);
      return it;
    });
    const { transport, calls } = fakeTransport({
      gXtzob: () => COURSES,
      pONvgf: () => many,
      Zj93ge: (args) => {
        const subs = clone(SUBS);
        subs[2] = (args[2][2] as J[]).map((k) => {
          const s = clone(SUBS[2][0]);
          s[0] = [String(k[0]), [String(k[1][0]), [String(k[1][1][0])]]];
          return s;
        });
        return subs;
      },
    });
    const { summaries } = await listTodo(transport, SESSION);
    expect(summaries).toHaveLength(150);
    const sizes = calls.filter((c) => c.rpcid === "Zj93ge").map((c) => c.args[2][2].length);
    expect(sizes).toEqual([100, 50]);
    expect(countByBucket(summaries).assigned).toBe(150);
  });

  it("no courses, wrong tags and bad positions raise ParseDriftError", async () => {
    const run = (handlers: Record<string, (args: J, n: number) => unknown>) =>
      listTodo(fakeTransport(handlers).transport, SESSION);
    const ok = { gXtzob: () => COURSES, pONvgf: () => ["hrsi.qr", [false]], Zj93ge: () => SUBS };

    await expect(run({ ...ok, gXtzob: () => ["hrq.crs", [false]] })).rejects.toThrow(/no courses/);
    await expect(run({ ...ok, pONvgf: () => ["hrq.xyz", [false], []] })).rejects.toThrow(
      ParseDriftError,
    );

    const badTitle = clone(TODO);
    badTitle[1] = [false];
    badTitle[2][0][1][0][5] = 42;
    const err = await run({ ...ok, pONvgf: () => badTitle }).catch((e) => e);
    expect(err).toBeInstanceOf(ParseDriftError);
    expect(err.message).toContain("[2][0][1][0][5]");

    const noToken = clone(TODO);
    noToken[1] = [true];
    await expect(run({ ...ok, pONvgf: () => noToken })).rejects.toThrow(/page token/);

    const stuck = { ...ok, pONvgf: () => TODO };
    await expect(run(stuck)).rejects.toThrow(/did not advance/);
  });

  it("drift messages never carry titles", async () => {
    const badDue = clone(TODO);
    badDue[1] = [false];
    badDue[2][0][1][1][0] = "do eiusmod";
    const err = await listTodo(
      fakeTransport({ gXtzob: () => COURSES, pONvgf: () => badDue, Zj93ge: () => SUBS }).transport,
      SESSION,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ParseDriftError);
    expect(err.message).not.toContain("eiusmod");
  });
});
