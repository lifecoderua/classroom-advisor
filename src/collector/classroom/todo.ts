import { z } from "zod";
import { idToB64, ParseDriftError, reader } from "./parse-util.ts";
import {
  ALL_BUCKETS,
  type ClassroomSession,
  coursesArgs,
  createRpcClient,
  type RpcClientOptions,
  SUBMISSIONS_BATCH,
  type SubmissionKey,
  submissionsArgs,
  type Transport,
  todoArgs,
} from "./rpc.ts";

/**
 * To-do listing (#5): parses `gXtzob` (courses), `pONvgf` (stream items) and `Zj93ge`
 * (submissions) into normalized {@link AssignmentSummary} rows. Field positions are in
 * docs/CLASSROOM-INTERNALS.md. Missing/late/graded come from the submission's bucket
 * (`[20]`) and are never recomputed from dates.
 */

export const ITEM_KINDS = ["assignment", "material", "question", "quiz", "unknown"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export const BUCKETS = [
  "assigned",
  "missing",
  "turned_in",
  "done_late",
  "returned",
  "graded",
  "graded_late",
  "excused",
  "unknown",
] as const;
export type Bucket = (typeof BUCKETS)[number];

export const SUBMISSION_STATES = ["new", "turned_in", "returned", "reclaimed", "unknown"] as const;
export type SubmissionState = (typeof SUBMISSION_STATES)[number];

const BUCKET_BY_CODE: Record<number, Bucket> = {
  1: "assigned",
  2: "missing",
  3: "turned_in",
  4: "done_late",
  7: "returned",
  8: "graded",
  10: "graded_late",
  11: "excused",
};

const STATE_BY_CODE: Record<number, SubmissionState> = {
  2: "turned_in",
  3: "returned",
  4: "new",
  5: "reclaimed",
};

/** Stream item type `item[0]` → kind. Quizzes are not distinguishable yet (see internals). */
const KIND_BY_TYPE: Record<number, ItemKind> = { 2: "assignment", 5: "question", 7: "material" };

export const bucketOf = (code: number | null): Bucket =>
  code === null ? "unknown" : (BUCKET_BY_CODE[code] ?? "unknown");
export const submissionStateOf = (code: number | null): SubmissionState =>
  code === null ? "unknown" : (STATE_BY_CODE[code] ?? "unknown");

export const assignmentSummarySchema = z.object({
  id: z.string().regex(/^\d+$/),
  courseId: z.string().regex(/^\d+$/),
  courseName: z.string(),
  title: z.string(),
  kind: z.enum(ITEM_KINDS),
  /** UTC instant, or null when the item has no due date. */
  dueAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
  bucket: z.enum(BUCKETS),
  /** null when the listing returned no submission for the item. */
  submissionState: z.enum(SUBMISSION_STATES).nullable(),
  /** Raw To-do bucket code `[20]`, kept for codes we don't name yet (5, 6, 9). */
  bucketCode: z.number().int().nullable(),
  grade: z.number().nullable(),
  maxPoints: z.number().nullable(),
  attachmentCount: z.number().int().nonnegative(),
  url: z.url(),
});
export type AssignmentSummary = z.infer<typeof assignmentSummarySchema>;

// ---- courses (gXtzob) -------------------------------------------------------------------

export interface Course {
  id: string;
  name: string;
  /** `[20]`: 1 active, 2 archived. */
  state: number | null;
  active: boolean;
}

export interface Page<T> {
  rows: T[];
  hasMore: boolean;
  nextPageToken: string | null;
}

function expectTag(rpcid: string, payload: unknown, tag: string): unknown[] {
  if (!Array.isArray(payload) || payload[0] !== tag) {
    throw new ParseDriftError({
      rpcid,
      path: "[0]",
      expected: `tag ${tag}`,
      shape: Array.isArray(payload) ? `tag ${String(payload[0]).slice(0, 12)}` : typeof payload,
    });
  }
  return payload;
}

/** `[hasMore, [nextPageToken]]` at `payload[1]`. */
function paging(
  rpcid: string,
  payload: unknown[],
): { hasMore: boolean; nextPageToken: string | null } {
  const r = reader(rpcid);
  const hasMore = r.optBool(payload, [1, 0]) ?? false;
  const nextPageToken = r.optStr(payload, [1, 1, 0]);
  if (hasMore && !nextPageToken) throw r.drift([1, 1, 0], "page token", null);
  return { hasMore, nextPageToken: hasMore ? nextPageToken : null };
}

export function parseCourses(payload: unknown): Page<Course> {
  const rpcid = "gXtzob";
  const p = expectTag(rpcid, payload, "hrq.crs");
  const r = reader(rpcid);
  const rows = (r.optArr(p, [2]) ?? []).map((c, i): Course => {
    const label = `course#${i}`;
    const state = r.optInt(c, [20], label);
    return {
      id: r.id(c, [0, 0], label),
      name: r.optStr(c, [5], label) ?? "",
      state,
      active: state === 1,
    };
  });
  return { rows, ...paging(rpcid, p) };
}

// ---- stream items (pONvgf) --------------------------------------------------------------

export interface StreamItem {
  id: string;
  courseId: string;
  kind: ItemKind;
  title: string;
  createdAt: number;
  updatedAt: number;
  dueAt: number | null;
  maxPoints: number | null;
}

/** Parses one stream item `[type, assignment?, ?, ?, ?, material?]`. */
export function parseStreamItem(item: unknown, rpcid: string, label: string): StreamItem {
  const r = reader(rpcid);
  const type = r.int(item, [0], label);
  const kind = KIND_BY_TYPE[type] ?? "unknown";
  // Assignments (and presumably questions) keep the body at [1]; material posts at [5].
  const bodyPath = kind === "material" ? [5] : [1];
  const body = r.at(item, bodyPath) ?? r.at(item, kind === "material" ? [1] : [5]);
  if (!Array.isArray(body)) throw r.drift(bodyPath, "item body", body, label);
  const base = r.arr(body, [0], `${label}.body`);
  const bl = `${label}.base`;
  const work = kind === "material" ? null : r.optArr(body, [1], `${label}.body`);
  const wl = `${label}.work`;
  return {
    id: r.id(base, [0, 0], bl),
    courseId: r.id(base, [0, 1, 0], bl),
    kind,
    title: r.optStr(base, [5], bl) ?? "",
    createdAt: r.ms(base, [1], bl),
    updatedAt: r.ms(base, [2], bl),
    dueAt: work ? r.optMs(work, [0], wl) : null,
    maxPoints: work ? r.optNum(work, [3], wl) : null,
  };
}

export function parseTodoPage(payload: unknown): Page<StreamItem> {
  const rpcid = "pONvgf";
  const p = expectTag(rpcid, payload, "hrsi.qr");
  const items = reader(rpcid).optArr(p, [2]) ?? [];
  return {
    rows: items.map((it, i) => parseStreamItem(it, rpcid, `item#${i}`)),
    ...paging(rpcid, p),
  };
}

// ---- submissions (Zj93ge) ---------------------------------------------------------------

export interface Submission {
  key: SubmissionKey;
  stateCode: number | null;
  state: SubmissionState;
  bucketCode: number | null;
  bucket: Bucket;
  grade: number | null;
  attachmentCount: number;
  updatedAt: number | null;
}

export function parseSubmissions(payload: unknown): Submission[] {
  const rpcid = "Zj93ge";
  const p = expectTag(rpcid, payload, "hrq.sub");
  const r = reader(rpcid);
  return (r.optArr(p, [2]) ?? []).map((s, i): Submission => {
    const label = `sub#${i}`;
    const stateCode = r.optInt(s, [5], label);
    const bucketCode = r.optInt(s, [20], label);
    const attachments = r.optArr(s, [4], label);
    return {
      key: {
        studentId: r.id(s, [0, 0], label),
        itemId: r.id(s, [0, 1, 0], label),
        courseId: r.id(s, [0, 1, 1, 0], label),
      },
      stateCode,
      state: submissionStateOf(stateCode),
      bucketCode,
      bucket: bucketOf(bucketCode),
      grade: r.optNum(s, [8], label),
      attachmentCount: r.optInt(s, [13], label) ?? attachments?.length ?? 0,
      updatedAt: r.optMs(s, [2], label),
    };
  });
}

// ---- join -------------------------------------------------------------------------------

const itemKey = (itemId: string, courseId: string) => `${courseId}/${itemId}`;

/** Student details URL: `/c/<b64 course>/{a|m}/<b64 item>/details?authuser=<email>`. */
export function detailsUrl(courseId: string, itemId: string, kind: ItemKind, authuser: string) {
  const seg = kind === "material" ? "m" : "a";
  const url = new URL(
    `/c/${idToB64(courseId)}/${seg}/${idToB64(itemId)}/details`,
    "https://classroom.google.com",
  );
  url.searchParams.set("authuser", authuser);
  return url.toString();
}

/**
 * Joins items with their submission (by `[itemId, [courseId]]`) and course name.
 * Throws {@link ParseDriftError} when items exist but none has a submission, which means
 * the join keys or the submissions shape moved.
 */
export function joinSummaries(
  items: readonly StreamItem[],
  submissions: readonly Submission[],
  courses: readonly Course[],
  authuser: string,
): AssignmentSummary[] {
  const subs = new Map(submissions.map((s) => [itemKey(s.key.itemId, s.key.courseId), s]));
  const names = new Map(courses.map((c) => [c.id, c.name]));
  const needSub = items.filter((i) => i.kind !== "material");
  if (needSub.length > 0 && !needSub.some((i) => subs.has(itemKey(i.id, i.courseId)))) {
    throw new ParseDriftError({
      rpcid: "Zj93ge",
      detail: `no submission matched any of ${needSub.length} item(s)`,
    });
  }
  return items.map((i) => {
    const s = subs.get(itemKey(i.id, i.courseId));
    const summary = {
      id: i.id,
      courseId: i.courseId,
      courseName: names.get(i.courseId) ?? "",
      title: i.title,
      kind: i.kind,
      dueAt: i.dueAt === null ? null : new Date(i.dueAt),
      createdAt: new Date(i.createdAt),
      updatedAt: new Date(i.updatedAt),
      bucket: s?.bucket ?? "unknown",
      submissionState: s?.state ?? null,
      bucketCode: s?.bucketCode ?? null,
      grade: s?.grade ?? null,
      maxPoints: i.maxPoints,
      attachmentCount: s?.attachmentCount ?? 0,
      url: detailsUrl(i.courseId, i.id, i.kind, authuser),
    } satisfies AssignmentSummary;
    const parsed = assignmentSummarySchema.safeParse(summary);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new ParseDriftError({
        rpcid: "pONvgf",
        path: `summary.${issue?.path.join(".") ?? "?"}`,
        detail: issue?.code ?? "invalid",
      });
    }
    return parsed.data;
  });
}

// ---- listing ----------------------------------------------------------------------------

export interface ListTodoOptions extends RpcClientOptions {
  /** Buckets to ask for; all by default. */
  buckets?: readonly number[];
  /** Safety cap on pages per query. */
  maxPages?: number;
}

export interface TodoListing {
  courses: Course[];
  summaries: AssignmentSummary[];
}

/**
 * Lists every To-do item of one account: courses (`gXtzob`, active only), then
 * `pONvgf` per active course following the page token, then `Zj93ge` in batches.
 * Sequential calls; read-only rpcids only.
 */
export async function listTodo(
  transport: Transport,
  account: ClassroomSession,
  options: ListTodoOptions = {},
): Promise<TodoListing> {
  const client = createRpcClient(transport, account, options);
  const maxPages = options.maxPages ?? 50;

  async function pages<T>(
    fetchPage: (token: string | null) => Promise<Page<T>>,
    rpcid: string,
  ): Promise<T[]> {
    const out: T[] = [];
    let token: string | null = null;
    for (let n = 0; ; n++) {
      if (n >= maxPages)
        throw new ParseDriftError({ rpcid, detail: `more than ${maxPages} pages` });
      const page = await fetchPage(token);
      out.push(...page.rows);
      if (!page.hasMore) return out;
      if (page.nextPageToken === token) {
        throw new ParseDriftError({ rpcid, detail: "page token did not advance" });
      }
      token = page.nextPageToken;
    }
  }

  const courses = await pages(
    async (t) => parseCourses(await client.call("gXtzob", coursesArgs(t))),
    "gXtzob",
  );
  if (courses.length === 0) {
    throw new ParseDriftError({ rpcid: "gXtzob", detail: "no courses" });
  }
  const active = courses.filter((c) => c.active);

  const items: StreamItem[] = [];
  const seen = new Set<string>();
  for (const course of active) {
    const rows = await pages(
      async (t) =>
        parseTodoPage(
          await client.call("pONvgf", todoArgs([course.id], options.buckets ?? ALL_BUCKETS, t)),
        ),
      "pONvgf",
    );
    for (const row of rows) {
      const k = itemKey(row.id, row.courseId);
      if (seen.has(k)) continue;
      seen.add(k);
      items.push(row);
    }
  }

  const keys: SubmissionKey[] = items
    .filter((i) => i.kind !== "material")
    .map((i) => ({ studentId: account.userId, itemId: i.id, courseId: i.courseId }));
  const submissions: Submission[] = [];
  for (let i = 0; i < keys.length; i += SUBMISSIONS_BATCH) {
    const batch = keys.slice(i, i + SUBMISSIONS_BATCH);
    submissions.push(...parseSubmissions(await client.call("Zj93ge", submissionsArgs(batch))));
  }

  return { courses, summaries: joinSummaries(items, submissions, courses, account.authuser) };
}

/** Counts per bucket, every bucket present (zeros included). */
export function countByBucket(summaries: readonly AssignmentSummary[]): Record<Bucket, number> {
  const counts = Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<Bucket, number>;
  for (const s of summaries) counts[s.bucket]++;
  return counts;
}
