// Assignment detail parser (#6). Pure functions over already-unwrapped batchexecute payloads:
// `tQShAc` (items by key), `t51ITc` (materials of one item), `Zj93ge` (submissions; list and
// attachments masks) and `sLc6hf` (private comments). Positions are documented in
// docs/CLASSROOM-INTERNALS.md and pinned by test/classroom-fixtures.test.ts.
//
// Structural surprises (a missing tag, a field of the wrong type, a required field left out)
// throw `ParseDriftError`. Unknown enum values map to "unknown" instead, so a new Classroom
// state doesn't stop the sync.

import { z } from "zod";
import type {
  HeuristicAttachment,
  HeuristicMaterial,
  TurnedInInput,
} from "../../checks/heuristics.ts";
import {
  BUCKETS,
  bucketOf,
  ITEM_KINDS,
  type ItemKind,
  SUBMISSION_STATES,
  submissionStateOf,
} from "./enums.ts";
import { Cursor, ParseDriftError, type Path } from "./parse-util.ts";

const ms = (v: number) => new Date(v);

// ---------------------------------------------------------------------------------------------
// Schemas.

export const attachmentSchema = z.object({
  origin: z.enum(["material", "student", "teacher_annotated", "unknown"]),
  type: z.enum(["drive", "youtube", "link", "form", "unknown"]),
  kind: z.enum([
    "doc",
    "slides",
    "sheet",
    "pdf",
    "image",
    "video",
    "form",
    "link",
    "youtube",
    "other",
  ]),
  driveFileId: z.string().optional(),
  url: z.string().min(1),
  title: z.string(),
  mime: z.string().optional(),
  modifiedAt: z.date().optional(),
  bytes: z.number().optional(),
  /** Material is a "make a copy for each student" template (inferred, see `linkTemplates`). */
  isTemplate: z.boolean().optional(),
  /** Student copy: Drive id of the template it was made from (inferred, see `linkTemplates`). */
  templateSourceId: z.string().optional(),
  /** Teacher-annotated copy: Drive id of the student's original file (`[14][3][1]`). */
  annotatedSourceId: z.string().optional(),
});
export type Attachment = z.infer<typeof attachmentSchema>;

export const submissionSchema = z.object({
  state: z.enum(SUBMISSION_STATES),
  bucket: z.enum(BUCKETS),
  /** `Zj93ge [21]`, the last state change; set as `turnedInAt` while turned in. */
  turnedInAt: z.date().optional(),
  /** `Zj93ge [21]` while returned. */
  returnedAt: z.date().optional(),
  grade: z.number().optional(),
  /** From the bucket (`done_late`, `graded_late`); never derived from timestamps. */
  late: z.boolean().optional(),
  excused: z.boolean().optional(),
  updatedAt: z.date().optional(),
  attachments: z.array(attachmentSchema),
  /** Not observed in any response yet; reserved. */
  history: z.array(z.object({ state: z.string(), at: z.date() })).optional(),
});
export type SubmissionDetail = z.infer<typeof submissionSchema>;

export const privateCommentSchema = z.object({
  id: z.string(),
  authorRole: z.enum(["student", "teacher", "unknown"]),
  authorId: z.string().optional(),
  text: z.string(),
  html: z.string().optional(),
  at: z.date(),
});
export type PrivateComment = z.infer<typeof privateCommentSchema>;

export const assignmentDetailSchema = z.object({
  id: z.string(),
  courseId: z.string(),
  kind: z.enum(ITEM_KINDS),
  title: z.string(),
  /** Plain text of the description; `""` when there is none. */
  instructions: z.string(),
  instructionsHtml: z.string().optional(),
  dueAt: z.date().nullable(),
  maxPoints: z.number().optional(),
  createdAt: z.date().optional(),
  updatedAt: z.date(),
  materials: z.array(attachmentSchema),
  /** `null` for material posts (nothing to submit) or when no submission was fetched. */
  submission: submissionSchema.nullable(),
  privateComments: z.array(privateCommentSchema),
});
export type AssignmentDetail = z.infer<typeof assignmentDetailSchema>;

// ---------------------------------------------------------------------------------------------
// Attachments (the 21-slot array shared by materials and student work).

const GOOGLE_MIME_KIND: Record<string, Attachment["kind"]> = {
  "application/vnd.google-apps.document": "doc",
  "application/vnd.google-apps.kix": "doc",
  "application/vnd.google-apps.presentation": "slides",
  "application/vnd.google-apps.punch": "slides",
  "application/vnd.google-apps.spreadsheet": "sheet",
  "application/vnd.google-apps.ritz": "sheet",
  "application/vnd.google-apps.form": "form",
  "application/vnd.google-apps.freebird": "form",
};

const FORMS_URL = /^https?:\/\/(docs\.google\.com\/forms\/|forms\.gle\/)/;

function kindFromMime(mime: string | undefined): Attachment["kind"] {
  if (!mime) return "other";
  const google = GOOGLE_MIME_KIND[mime];
  if (google) return google;
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  return "other";
}

const ORIGINS: Record<number, Attachment["origin"]> = {
  1: "material",
  2: "student",
  3: "teacher_annotated",
};

/** Parses one 21-slot attachment array. `r` points at the attachment itself. */
export function parseAttachment(r: Cursor): Attachment {
  if (!Array.isArray(r.root)) r.expected([], "attachment array");
  const title = r.optStr([0]) ?? "";
  const ref = r.str([2]);
  const typeCode = r.num([3]);
  const mime = r.optStr([4]);
  const openUrl = r.optStr([6]);
  const originCode = r.optNum([15]);
  const origin = (originCode !== undefined && ORIGINS[originCode]) || "unknown";
  const bytes = r.optNum([14, 7]);
  const extras = r.optArr([14]) ? r.child([14]) : undefined;

  let out: Attachment;
  switch (typeCode) {
    case 2: {
      const kind = kindFromMime(mime);
      out = {
        origin,
        type: kind === "form" ? "form" : "drive",
        kind,
        driveFileId: ref,
        url: openUrl ?? `https://drive.google.com/file/d/${ref}/view`,
        title,
      };
      break;
    }
    case 3:
      out = {
        origin,
        type: "youtube",
        kind: "youtube",
        url: openUrl ?? `https://www.youtube.com/watch?v=${ref}`,
        title,
      };
      break;
    case 4: {
      // Google Forms (quizzes) arrive as plain links; no native Forms type was seen.
      const url = openUrl ?? ref;
      const form = FORMS_URL.test(url);
      out = { origin, type: form ? "form" : "link", kind: form ? "form" : "link", url, title };
      break;
    }
    default:
      out = { origin, type: "unknown", kind: kindFromMime(mime), url: openUrl ?? ref, title };
  }
  if (mime) out.mime = mime;
  if (bytes !== undefined) out.bytes = bytes;
  if (origin === "teacher_annotated" && extras?.get([2]) === true) {
    const src = extras.optStr([3, 1]);
    if (src) out.annotatedSourceId = src;
  }
  return out;
}

/**
 * Best-effort "make a copy for each student" detection. UNVERIFIED: no such assignment appears in
 * the recon captures (see docs/CLASSROOM-INTERNALS.md). Expected shape: a Google-native material
 * (`[15]` = 1) plus a student attachment (`[15]` = 2) with a `vnd.google-apps.*` mime that is a
 * copy of it. A copy is linked to a template when
 *  - its `[14][3]` is `[2, <materialDriveId>]` (as on annotated copies), or
 *  - its title equals the template title, or ends with ` - <template title>` (Classroom names
 *    copies "<Student name> - <title>"), with the same kind.
 * Matched materials get `isTemplate: true`, matched copies `templateSourceId`.
 */
export function linkTemplates(
  materials: readonly Attachment[],
  attachments: readonly Attachment[],
  sourceIds: ReadonlyMap<Attachment, string> = new Map(),
): { materials: Attachment[]; attachments: Attachment[] } {
  const isGoogle = (a: Attachment) =>
    a.type === "drive" && !!a.driveFileId && !!a.mime?.startsWith("application/vnd.google-apps.");
  const candidates = materials.filter(isGoogle);
  const templateIds = new Set<string>();
  const outAtts = attachments.map((a) => {
    if (a.origin !== "student" || !isGoogle(a)) return a;
    const src = sourceIds.get(a);
    const t =
      (src && candidates.find((m) => m.driveFileId === src)) ||
      candidates.find(
        (m) =>
          m.kind === a.kind &&
          m.driveFileId !== a.driveFileId &&
          (a.title === m.title || a.title.endsWith(` - ${m.title}`)),
      );
    if (!t?.driveFileId) return a;
    templateIds.add(t.driveFileId);
    return { ...a, templateSourceId: t.driveFileId };
  });
  const outMats = materials.map((m) =>
    m.driveFileId && templateIds.has(m.driveFileId) ? { ...m, isTemplate: true } : m,
  );
  return { materials: outMats, attachments: outAtts };
}

// ---------------------------------------------------------------------------------------------
// Items (`tQShAc`; the same item shape appears in `pONvgf` and `dpT4Vd` lists).

export interface ParsedItem {
  id: string;
  courseId: string;
  kind: ItemKind;
  title: string;
  instructions: string;
  instructionsHtml?: string;
  dueAt: Date | null;
  maxPoints?: number;
  createdAt?: Date;
  updatedAt: Date;
  /** Material ids referenced by the description (`base[27][0][4]`); `t51ITc` returns them. */
  materialIds: string[];
}

/** Parses one bare item `[type, assignment?, ?, ?, ?, material?]`. */
export function parseItem(item: unknown, rpcid = "tQShAc", path: Path = []): ParsedItem {
  const r = new Cursor(rpcid, item, path);
  const type = r.num([0]);
  let kind: ParsedItem["kind"];
  let bodyPos: number;
  if (type === 2) [kind, bodyPos] = ["assignment", 1];
  else if (type === 7) [kind, bodyPos] = ["material", 5];
  else {
    // Type 5 is assumed to be a question (the To-do filter asks for [2,5]) but none was seen, so
    // its body position is unknown: take the first array after the type.
    kind = type === 5 ? "question" : "unknown";
    bodyPos = [1, 5, 2, 3, 4].find((i) => Array.isArray(r.get([i]))) ?? 1;
  }
  const body = r.child([bodyPos]);
  const base = body.child([0]);
  if (!Array.isArray(base.root)) base.expected([], "item base array");

  const desc = base.optArr([27, 0]) ? base.child([27, 0]) : undefined;
  let instructions = "";
  let instructionsHtml: string | undefined;
  if (desc?.get([6]) != null) {
    const rt = desc.child([6]);
    rt.tag("edu.rt");
    instructions = rt.optStr([1]) ?? "";
    instructionsHtml = rt.optStr([4, 1]);
  }
  const materialIds = desc ? (desc.optArr([4]) ?? []).map((_, i) => desc.id([4, i, 1, 1])) : [];

  const work = body.optArr([1]) ? body.child([1]) : undefined;
  const due = work?.optNum([0]);
  const maxPoints = work?.optNum([3]);
  const created = base.optNum([1]);

  const out: ParsedItem = {
    id: base.id([0, 0]),
    courseId: base.id([0, 1, 0]),
    kind,
    title: base.str([5]),
    instructions,
    dueAt: due === undefined ? null : ms(due),
    updatedAt: ms(base.num([2])),
    materialIds,
  };
  if (instructionsHtml !== undefined) out.instructionsHtml = instructionsHtml;
  if (maxPoints !== undefined) out.maxPoints = maxPoints;
  if (created !== undefined) out.createdAt = ms(created);
  return out;
}

/** `tQShAc` → `["hrsi.lr", [[[0], itemKey, item]…]]`. */
export function parseItems(payload: unknown): ParsedItem[] {
  const r = new Cursor("tQShAc", payload);
  r.tag("hrsi.lr");
  const rows = r.arr([1]);
  if (rows.length === 0) r.drift([1], "no items");
  return rows.map((_, i) => parseItem(r.get([1, i, 2]), "tQShAc", [1, i, 2]));
}

// ---------------------------------------------------------------------------------------------
// Materials (`t51ITc` → `[null, [[attachment, null, [itemKey, materialId]]…]]`).

export interface ParsedMaterial {
  itemId: string;
  materialId: string;
  attachment: Attachment;
  /** `[14][3][1]`, a source Drive id when present. */
  sourceId?: string;
}

export function parseMaterials(payload: unknown): ParsedMaterial[] {
  const r = new Cursor("t51ITc", payload);
  if (!Array.isArray(payload)) r.expected([], "array");
  const rows = r.optArr([1]) ?? [];
  return rows.map((_, i) => {
    const row = r.child([1, i]);
    return {
      itemId: row.id([2, 0, 0]),
      materialId: row.id([2, 1]),
      attachment: parseAttachment(row.child([0])),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Submissions (`Zj93ge` → `["hrq.sub", [false], [sub…]]`).

export interface ParsedSubmission {
  studentId: string;
  itemId: string;
  courseId: string;
  submission: SubmissionDetail;
  /** Student attachments → `[14][3][1]` source ids, for `linkTemplates`. */
  sourceIds: Map<Attachment, string>;
}

/** Raw submission rows of one or more `Zj93ge` payloads, keyed by `studentId/itemId`. */
function submissionRows(payloads: readonly unknown[]): Map<string, unknown[]> {
  const out = new Map<string, unknown[]>();
  payloads.forEach((payload) => {
    const r = new Cursor("Zj93ge", payload);
    r.tag("hrq.sub");
    const subs = r.optArr([2]) ?? [];
    subs.forEach((_, i) => {
      const s = r.child([2, i]);
      if (!Array.isArray(s.root)) s.expected([], "submission array");
      const key = `${s.id([0, 0])}/${s.id([0, 1, 0])}`;
      // The list mask and the attachments mask return disjoint fields: merge position-wise.
      const prev = out.get(key);
      const row = s.root as unknown[];
      if (!prev) out.set(key, [...row]);
      else {
        for (let p = 0; p < row.length; p++) if (prev[p] == null) prev[p] = row[p];
      }
    });
  });
  return out;
}

function parseSubmissionRow(row: unknown[], path: Path): ParsedSubmission {
  const r = new Cursor("Zj93ge", row, path);
  const stateCode =
    r.optNum([5]) ?? r.drift([5], "submission state missing (list mask not fetched?)");
  const bucketCode = r.optNum([20]);
  const lastChange = r.optNum([21]);
  const updated = r.optNum([2]);
  const grade = r.optNum([8]);
  const excusedFlag = r.optNum([32]);

  const sourceIds = new Map<Attachment, string>();
  const attachments = (r.optArr([4]) ?? []).map((_, i) => {
    const ar = r.child([4, i]);
    const a = parseAttachment(ar);
    const src = ar.get([14, 3, 1]);
    if (a.origin === "student" && typeof src === "string") sourceIds.set(a, src);
    return a;
  });

  const state = submissionStateOf(stateCode);
  const bucket = bucketOf(bucketCode);
  const submission: SubmissionDetail = { state, bucket, attachments };
  if (lastChange !== undefined) {
    if (state === "turned_in") submission.turnedInAt = ms(lastChange);
    if (state === "returned") submission.returnedAt = ms(lastChange);
  }
  if (grade !== undefined) submission.grade = grade;
  if (bucket !== "unknown") submission.late = bucket === "done_late" || bucket === "graded_late";
  if (excusedFlag !== undefined) submission.excused = excusedFlag === 2 || bucket === "excused";
  if (updated !== undefined) submission.updatedAt = ms(updated);
  return {
    studentId: r.id([0, 0]),
    itemId: r.id([0, 1, 0]),
    courseId: r.id([0, 1, 1, 0]),
    submission,
    sourceIds,
  };
}

/**
 * Parses one or more `Zj93ge` payloads. Pass both the list-mask and the attachments-mask
 * response for the same keys; their rows are merged per submission.
 */
export function parseSubmissions(...payloads: unknown[]): ParsedSubmission[] {
  return [...submissionRows(payloads).values()].map((row) => parseSubmissionRow(row, []));
}

// ---------------------------------------------------------------------------------------------
// Private comments (`sLc6hf` → `["hrq.cmt", [false], [comment…]]`).

export interface ParsedComment extends PrivateComment {
  /** From the comment's submission key. */
  itemId?: string;
  courseId?: string;
  studentId?: string;
}

/**
 * `[1][0]` of an `sLc6hf` response: more comments than the page size (`[0][0]` of the request,
 * 100). Never seen `true`; the sync splits the batch when it is.
 */
export function commentsHaveMore(payload: unknown): boolean {
  const r = new Cursor("sLc6hf", payload);
  r.tag("hrq.cmt");
  const v = r.get([1, 0]);
  if (v == null) return false;
  if (typeof v !== "boolean") r.expected([1, 0], "boolean");
  return v as boolean;
}

/**
 * Parses an `sLc6hf` response. A request may carry many submission keys (the sync batches
 * 100); each comment names its submission at `[0][2]`.
 */
export function parsePrivateComments(payload: unknown): ParsedComment[] {
  const r = new Cursor("sLc6hf", payload);
  r.tag("hrq.cmt");
  const rows = r.optArr([2]) ?? [];
  return rows.map((_, i) => {
    const c = r.child([2, i]);
    const id = c.id([0, 0]);
    const studentId = c.get([0, 2, 0]) == null ? undefined : c.id([0, 2, 0]);
    const itemId = c.get([0, 2, 1, 0]) == null ? undefined : c.id([0, 2, 1, 0]);
    const courseId = c.get([0, 2, 1, 1, 0]) == null ? undefined : c.id([0, 2, 1, 1, 0]);
    const authorId = c.get([4, 0]) == null ? undefined : c.id([4, 0]);
    const rt = c.child([11]);
    rt.tag("edu.rt");
    // Private comments are between the student and the class's teachers only.
    const authorRole: PrivateComment["authorRole"] =
      !authorId || !studentId ? "unknown" : authorId === studentId ? "student" : "teacher";
    const out: ParsedComment = { id, authorRole, text: rt.optStr([1]) ?? "", at: ms(c.num([1])) };
    if (authorId) out.authorId = authorId;
    const html = rt.optStr([4, 1]);
    if (html !== undefined) out.html = html;
    if (itemId) out.itemId = itemId;
    if (courseId) out.courseId = courseId;
    if (studentId) out.studentId = studentId;
    return out;
  });
}

// ---------------------------------------------------------------------------------------------
// Assembly.

export interface DetailPayloads {
  /** `tQShAc` response, or an item already parsed (e.g. from a `pONvgf` list). */
  item: unknown;
  /** `t51ITc` response; omit when the item has no material refs (the call errors then). */
  materials?: unknown;
  /** `Zj93ge` responses (list mask and/or attachments mask). */
  submissions?: readonly unknown[];
  /** `sLc6hf` private-comments response. */
  comments?: unknown;
  /** The watched student's id (`WIZ_global_data.x3UoP[0]`); picks the submission. */
  studentId?: string;
}

function isParsedItem(v: unknown): v is ParsedItem {
  return typeof v === "object" && v !== null && !Array.isArray(v) && "materialIds" in v;
}

/** Combines the per-RPC payloads of one item into a validated `AssignmentDetail`. */
export function parseAssignmentDetail(p: DetailPayloads): AssignmentDetail {
  let item: ParsedItem;
  if (isParsedItem(p.item)) item = p.item;
  else {
    const items = parseItems(p.item);
    if (items.length !== 1)
      throw new ParseDriftError({
        rpcid: "tQShAc",
        path: "[1]",
        detail: `expected 1 item, got ${items.length}`,
      });
    item = items[0] as ParsedItem;
  }

  const mats = p.materials === undefined ? [] : parseMaterials(p.materials);
  const foreign = mats.find((m) => m.itemId !== item.id);
  if (foreign)
    throw new ParseDriftError({
      rpcid: "t51ITc",
      path: "[1]",
      detail: `material of item ${foreign.itemId}, not ${item.id}`,
    });

  let sub: ParsedSubmission | undefined;
  if (p.submissions && p.submissions.length > 0) {
    const subs = parseSubmissions(...p.submissions).filter(
      (s) => s.itemId === item.id && (!p.studentId || s.studentId === p.studentId),
    );
    if (subs.length !== 1)
      throw new ParseDriftError({
        rpcid: "Zj93ge",
        path: "[2]",
        detail: `expected 1 submission for ${item.id}, got ${subs.length}`,
      });
    sub = subs[0];
  }

  const linked = linkTemplates(
    mats.map((m) => m.attachment),
    sub?.submission.attachments ?? [],
    sub?.sourceIds,
  );
  const comments = p.comments === undefined ? [] : parsePrivateComments(p.comments);

  const { materialIds: _, ...rest } = item;
  if (rest.kind === "assignment" && linked.materials.some((m) => m.kind === "form"))
    rest.kind = "quiz"; // a Forms link is how Classroom's "Quiz assignment" shows up
  const detail = {
    ...rest,
    materials: linked.materials,
    submission: sub ? { ...sub.submission, attachments: linked.attachments } : null,
    privateComments: comments
      .filter((c) => !c.itemId || c.itemId === item.id)
      .map(({ itemId: _i, courseId: _c, studentId: _s, ...c }) => c),
  };
  const res = assignmentDetailSchema.safeParse(detail);
  if (!res.success)
    throw new ParseDriftError({
      rpcid: "detail",
      path: "<assembled>",
      detail: res.error.issues.map((i) => `${i.path.join(".")}: ${i.code}`).join("; "),
    });
  return res.data;
}

// ---------------------------------------------------------------------------------------------
// Heuristics input.

/** Maps parser kinds to the kinds `src/checks/heuristics.ts` knows. */
function heuristicKind(kind: Attachment["kind"]): string {
  if (kind === "youtube") return "video";
  if (kind === "other") return "file";
  return kind;
}

/** Text of a file, keyed by `driveFileId` (or `url` for non-Drive attachments). */
export type AttachmentTexts =
  | ReadonlyMap<string, string | null | undefined>
  | Readonly<Record<string, string | null | undefined>>;

function textOf(texts: AttachmentTexts, a: Attachment): string | null | undefined {
  const key = a.driveFileId ?? a.url;
  return texts instanceof Map ? texts.get(key) : (texts as Record<string, string>)[key];
}

/**
 * Maps a detail to `TurnedInInput`. Teacher-annotated copies are left out of the student's
 * attachments: they are the teacher's work, not the student's.
 */
export function toHeuristicsInput(
  detail: AssignmentDetail,
  texts: AttachmentTexts = new Map(),
  extra: { courseName?: string } = {},
): TurnedInInput {
  const material = (a: Attachment): HeuristicMaterial => ({
    kind: heuristicKind(a.kind),
    title: a.title,
    driveFileId: a.driveFileId,
    text: textOf(texts, a),
    isTemplate: a.isTemplate,
  });
  const attachment = (a: Attachment): HeuristicAttachment => ({
    kind: heuristicKind(a.kind),
    title: a.title,
    driveFileId: a.driveFileId,
    text: textOf(texts, a),
    templateSourceId: a.templateSourceId,
    bytes: a.bytes,
  });
  const sub = detail.submission;
  return {
    assignment: {
      kind: detail.kind,
      title: detail.title,
      instructions: detail.instructions,
      materials: detail.materials.map(material),
      courseName: extra.courseName,
      dueAt: detail.dueAt,
    },
    submission: {
      state: sub?.state ?? "new",
      turnedInAt: sub?.turnedInAt ?? null,
      attachments: (sub?.attachments ?? [])
        .filter((a) => a.origin !== "teacher_annotated")
        .map(attachment),
    },
  };
}
