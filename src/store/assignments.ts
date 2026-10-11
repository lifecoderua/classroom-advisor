import type { Db } from "./db.ts";
import type {
  Assignment,
  AssignmentVersion,
  Submission,
  SubmissionVersion,
} from "./generated/client.ts";
import type { AssignmentKind, AssignmentStatus, Change, SubmissionState } from "./types.ts";

export interface AssignmentInput {
  accountId: number;
  courseId: number;
  classroomId: string;
  kind: AssignmentKind;
  title: string;
  dueAt?: Date | null;
  postedAt?: Date | null;
  status: AssignmentStatus;
  /** Content hash computed by sync; a new value appends an `AssignmentVersion`. */
  hash: string;
  /** Normalized object, stored as JSON in the version row. */
  payload: unknown;
  /** Hash of the To-do summary the snapshot came from (sync bookkeeping). */
  summaryHash?: string | null;
  /** When details were last fetched (sync bookkeeping). */
  detailFetchedAt?: Date | null;
  /** Set on create only: the row comes from the account's baseline sync. */
  baseline?: boolean;
}

export interface AssignmentUpsert {
  assignment: Assignment;
  change: Change;
  /** The version written by this call, if any. */
  version: AssignmentVersion | null;
}

/**
 * Upserts an assignment snapshot. Fields absent from `input` are stored as null (the sync
 * bookkeeping fields `summaryHash`/`detailFetchedAt` are left alone when absent). Fields are
 * refreshed on every call (e.g. `status`, which is not part of the content hash); a version
 * row is appended only when the assignment is new or its hash changed.
 */
export function upsertAssignment(
  db: Db,
  input: AssignmentInput,
  now: Date = new Date(),
): Promise<AssignmentUpsert> {
  const { accountId, classroomId, hash } = input;
  const fields = {
    courseId: input.courseId,
    kind: input.kind,
    title: input.title,
    dueAt: input.dueAt ?? null,
    postedAt: input.postedAt ?? null,
    status: input.status,
    currentHash: hash,
    lastSeenAt: now,
    ...(input.summaryHash !== undefined ? { summaryHash: input.summaryHash } : {}),
    ...(input.detailFetchedAt !== undefined ? { detailFetchedAt: input.detailFetchedAt } : {}),
  };
  return db.$transaction(async (tx) => {
    const existing = await tx.assignment.findUnique({
      where: { accountId_classroomId: { accountId, classroomId } },
    });
    if (existing && existing.currentHash === hash) {
      const assignment = await tx.assignment.update({ where: { id: existing.id }, data: fields });
      return { assignment, change: "unchanged", version: null };
    }
    const assignment = existing
      ? await tx.assignment.update({ where: { id: existing.id }, data: fields })
      : await tx.assignment.create({
          data: {
            ...fields,
            accountId,
            classroomId,
            firstSeenAt: now,
            baseline: input.baseline ?? false,
          },
        });
    const version = await tx.assignmentVersion.create({
      data: {
        assignmentId: assignment.id,
        hash,
        payload: JSON.stringify(input.payload),
        seenAt: now,
      },
    });
    return { assignment, change: existing ? "updated" : "new", version };
  });
}

export function findAssignment(
  db: Db,
  accountId: number,
  classroomId: string,
): Promise<Assignment | null> {
  return db.assignment.findUnique({ where: { accountId_classroomId: { accountId, classroomId } } });
}

/** Version history, oldest first. */
export function listAssignmentVersions(db: Db, assignmentId: number): Promise<AssignmentVersion[]> {
  return db.assignmentVersion.findMany({
    where: { assignmentId },
    orderBy: [{ seenAt: "asc" }, { id: "asc" }],
  });
}

export interface SubmissionInput {
  assignmentId: number;
  state: SubmissionState;
  turnedInAt?: Date | null;
  grade?: string | null;
  /** Content hash computed by sync; a new value appends a `SubmissionVersion`. */
  hash: string;
  payload: unknown;
  /** Marks a version written by the baseline sync (never quality-reviewed). */
  baseline?: boolean;
}

export interface SubmissionUpsert {
  submission: Submission;
  change: Change;
  version: SubmissionVersion | null;
}

/**
 * Same contract as `upsertAssignment`, keyed by assignment (one submission per assignment).
 * An unchanged hash only touches `lastSeenAt`.
 */
export function upsertSubmission(
  db: Db,
  input: SubmissionInput,
  now: Date = new Date(),
): Promise<SubmissionUpsert> {
  const { assignmentId, hash } = input;
  const fields = {
    state: input.state,
    turnedInAt: input.turnedInAt ?? null,
    grade: input.grade ?? null,
    currentHash: hash,
    lastSeenAt: now,
  };
  return db.$transaction(async (tx) => {
    const existing = await tx.submission.findUnique({ where: { assignmentId } });
    if (existing && existing.currentHash === hash) {
      const submission = await tx.submission.update({
        where: { id: existing.id },
        data: { lastSeenAt: now },
      });
      return { submission, change: "unchanged", version: null };
    }
    const submission = existing
      ? await tx.submission.update({ where: { id: existing.id }, data: fields })
      : await tx.submission.create({ data: { ...fields, assignmentId, firstSeenAt: now } });
    const version = await tx.submissionVersion.create({
      data: {
        submissionId: submission.id,
        hash,
        state: input.state,
        payload: JSON.stringify(input.payload),
        baseline: input.baseline ?? false,
        seenAt: now,
      },
    });
    return { submission, change: existing ? "updated" : "new", version };
  });
}

/** Version history, oldest first. */
export function listSubmissionVersions(db: Db, submissionId: number): Promise<SubmissionVersion[]> {
  return db.submissionVersion.findMany({
    where: { submissionId },
    orderBy: [{ seenAt: "asc" }, { id: "asc" }],
  });
}

export function latestSubmissionVersion(
  db: Db,
  submissionId: number,
): Promise<SubmissionVersion | null> {
  return db.submissionVersion.findFirst({
    where: { submissionId },
    orderBy: [{ seenAt: "desc" }, { id: "desc" }],
  });
}
