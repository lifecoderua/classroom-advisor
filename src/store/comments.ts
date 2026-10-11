import type { Db } from "./db.ts";
import type { Comment } from "./generated/client.ts";
import type { CommentAuthorRole } from "./types.ts";

export interface CommentInput {
  assignmentId: number;
  /** Classroom's comment id. */
  classroomId: string;
  authorRole: CommentAuthorRole;
  authorId?: string | null;
  text: string;
  postedAt: Date;
  /** Only applied on creation: an existing comment keeps its flag. */
  baseline: boolean;
}

/**
 * Stores a private comment, deduped by `(assignmentId, classroomId)`. An existing one gets its
 * text, role and `lastSeenAt` refreshed (an edit is not a new comment).
 */
export async function upsertComment(
  db: Db,
  input: CommentInput,
  now: Date = new Date(),
): Promise<{ comment: Comment; created: boolean }> {
  const where = {
    assignmentId_classroomId: { assignmentId: input.assignmentId, classroomId: input.classroomId },
  };
  const existing = await db.comment.findUnique({ where });
  const fields = {
    authorRole: input.authorRole,
    authorId: input.authorId ?? null,
    text: input.text,
    postedAt: input.postedAt,
  };
  if (existing) {
    const comment = await db.comment.update({ where, data: { ...fields, lastSeenAt: now } });
    return { comment, created: false };
  }
  const comment = await db.comment.create({
    data: {
      ...fields,
      assignmentId: input.assignmentId,
      classroomId: input.classroomId,
      baseline: input.baseline,
      firstSeenAt: now,
      lastSeenAt: now,
    },
  });
  return { comment, created: true };
}
