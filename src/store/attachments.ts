import type { Db } from "./db.ts";
import type { Attachment } from "./generated/client.ts";
import type { AttachmentOwner } from "./types.ts";

export type AttachmentScope =
  | { owner: "material"; assignmentId: number }
  | { owner: "submission"; assignmentId: number; submissionId: number };

export interface AttachmentInput {
  url: string;
  title?: string | null;
  driveFileId?: string | null;
  mime?: string | null;
  modifiedAt?: Date | null;
  /** Material is a "make a copy for each student" template. */
  isTemplate?: boolean;
  /** Student copy: Drive id of its template. */
  templateSourceId?: string | null;
}

/**
 * Makes the stored attachments of `scope` match `items` (keyed by url): upserts the listed
 * ones and deletes the rest. Cached content is dropped when the Drive file id or its
 * `modifiedAt` changes.
 */
export function syncAttachments(
  db: Db,
  scope: AttachmentScope,
  items: readonly AttachmentInput[],
  now: Date = new Date(),
): Promise<Attachment[]> {
  const { assignmentId, owner } = scope;
  const submissionId = scope.owner === "submission" ? scope.submissionId : null;
  return db.$transaction(async (tx) => {
    await tx.attachment.deleteMany({
      where: { assignmentId, owner, url: { notIn: items.map((i) => i.url) } },
    });
    const out: Attachment[] = [];
    for (const item of items) {
      const fields = {
        submissionId,
        title: item.title ?? null,
        driveFileId: item.driveFileId ?? null,
        mime: item.mime ?? null,
        modifiedAt: item.modifiedAt ?? null,
        isTemplate: item.isTemplate ?? false,
        templateSourceId: item.templateSourceId ?? null,
        lastSeenAt: now,
      };
      const key = { assignmentId_owner_url: { assignmentId, owner, url: item.url } };
      const existing = await tx.attachment.findUnique({ where: key });
      if (!existing) {
        out.push(
          await tx.attachment.create({
            data: { ...fields, assignmentId, owner, url: item.url, firstSeenAt: now },
          }),
        );
        continue;
      }
      const stale =
        existing.driveFileId !== fields.driveFileId ||
        existing.modifiedAt?.getTime() !== fields.modifiedAt?.getTime();
      const reset = stale ? { contentPath: null, contentHash: null, fetchedAt: null } : {};
      out.push(
        await tx.attachment.update({ where: { id: existing.id }, data: { ...fields, ...reset } }),
      );
    }
    return out;
  });
}

export function listAttachments(
  db: Db,
  assignmentId: number,
  owner?: AttachmentOwner,
): Promise<Attachment[]> {
  return db.attachment.findMany({
    where: { assignmentId, ...(owner ? { owner } : {}) },
    orderBy: { id: "asc" },
  });
}

/** Records fetched content (path relative to dataDir). */
export function setAttachmentContent(
  db: Db,
  id: number,
  content: { contentPath: string; contentHash: string },
  now: Date = new Date(),
): Promise<Attachment> {
  return db.attachment.update({ where: { id }, data: { ...content, fetchedAt: now } });
}
