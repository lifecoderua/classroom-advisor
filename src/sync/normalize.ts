// Pure helpers for sync: stable hashing, the stored payload shapes, status mapping and the
// field diff of `assignment.updated`. No I/O.

import { createHash } from "node:crypto";
import type { AssignmentDetail, Attachment } from "../collector/classroom/detail.ts";
import type { Bucket } from "../collector/classroom/enums.ts";
import type { AssignmentSummary } from "../collector/classroom/todo.ts";
import type { AttachmentInput } from "../store/attachments.ts";
import type { AssignmentStatus } from "../store/types.ts";

/** JSON with object keys sorted, `undefined` dropped and dates as ISO strings. */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = sortKeys(x);
    }
    return out;
  }
  return v;
}

export function hashOf(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

/**
 * Hash of what the To-do listing says about an item. A change means the item or its
 * submission moved, so its details are fetched again. The url is left out (it carries the
 * authuser only).
 */
export function summaryHash(s: AssignmentSummary): string {
  const { url: _url, courseName: _name, ...rest } = s;
  return hashOf(rest);
}

/** Assignment status from the To-do bucket (the source of truth for missing/late/graded). */
export function statusOf(bucket: Bucket, state: string | null | undefined): AssignmentStatus {
  switch (bucket) {
    case "assigned":
    case "missing":
    case "excused":
      return bucket;
    case "turned_in":
    case "done_late":
      return "turned_in";
    case "returned":
    case "graded":
    case "graded_late":
      return "returned";
    default:
      return state === "turned_in" || state === "returned" ? state : "assigned";
  }
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

function attachmentPayload(a: Attachment) {
  return {
    origin: a.origin,
    type: a.type,
    kind: a.kind,
    title: a.title,
    url: a.url,
    driveFileId: a.driveFileId ?? null,
    mime: a.mime ?? null,
    ...(a.isTemplate ? { isTemplate: true } : {}),
    ...(a.templateSourceId ? { templateSourceId: a.templateSourceId } : {}),
    ...(a.annotatedSourceId ? { annotatedSourceId: a.annotatedSourceId } : {}),
  };
}

/**
 * The stored assignment version payload (and the input of its content hash). `instructions`
 * is what `evaluate-heuristics` reads. Timestamps that move without a content change
 * (`updatedAt`) are left out, so they don't create versions.
 */
export function assignmentPayload(d: AssignmentDetail) {
  return {
    id: d.id,
    courseId: d.courseId,
    kind: d.kind,
    title: d.title,
    instructions: d.instructions,
    instructionsHtml: d.instructionsHtml ?? null,
    dueAt: iso(d.dueAt),
    maxPoints: d.maxPoints ?? null,
    createdAt: iso(d.createdAt),
    materials: d.materials.map(attachmentPayload),
  };
}
export type AssignmentPayload = ReturnType<typeof assignmentPayload>;

type SubmissionDetail = NonNullable<AssignmentDetail["submission"]>;

/** The stored submission version payload (and the input of its content hash). */
export function submissionPayload(s: SubmissionDetail) {
  return {
    state: s.state,
    bucket: s.bucket,
    turnedInAt: iso(s.turnedInAt),
    returnedAt: iso(s.returnedAt),
    grade: s.grade ?? null,
    late: s.late ?? null,
    excused: s.excused ?? null,
    attachments: s.attachments.map(attachmentPayload),
  };
}
export type SubmissionPayload = ReturnType<typeof submissionPayload>;

/** Store rows for attachments, deduped by url (the store's key). */
export function attachmentInputs(list: readonly Attachment[]): AttachmentInput[] {
  const byUrl = new Map<string, AttachmentInput>();
  for (const a of list) {
    if (byUrl.has(a.url)) continue;
    byUrl.set(a.url, {
      url: a.url,
      title: a.title,
      driveFileId: a.driveFileId ?? null,
      mime: a.mime ?? null,
      modifiedAt: a.modifiedAt ?? null,
      ...(a.isTemplate ? { isTemplate: true } : {}),
      ...(a.templateSourceId ? { templateSourceId: a.templateSourceId } : {}),
    });
  }
  return [...byUrl.values()];
}

/** Student work as stored: the teacher's annotated copies are not the student's work. */
export function studentAttachments(s: SubmissionDetail): Attachment[] {
  return s.attachments.filter((a) => a.origin !== "teacher_annotated");
}

export type FieldDiff = Record<string, { from: unknown; to: unknown }>;

/** Field diff between two assignment payloads; materials are compared by url and title. */
export function diffAssignment(
  prev: Partial<AssignmentPayload> | null,
  next: AssignmentPayload,
): FieldDiff {
  const out: FieldDiff = {};
  const scalar = ["kind", "title", "instructions", "dueAt", "maxPoints"] as const;
  for (const k of scalar) {
    const from = prev?.[k] ?? null;
    const to = next[k] ?? null;
    if (from !== to) out[k] = { from, to };
  }
  const mat = (list: readonly { url: string; title: string }[] | undefined) =>
    (list ?? []).map((m) => `${m.title} <${m.url}>`).sort();
  const from = mat(prev?.materials);
  const to = mat(next.materials);
  if (stableJson(from) !== stableJson(to)) out.materials = { from, to };
  return out;
}

/** Parses a stored JSON payload; `null` when missing or malformed. */
export function parsePayload<T>(raw: string | null | undefined): Partial<T> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" ? (v as Partial<T>) : null;
  } catch {
    return null;
  }
}
