import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { officeSummaryPath } from "../collector/files.ts";
import { isOfficeSummary, type OfficeSummary } from "../collector/office.ts";
import {
  type Attachment,
  COMMENT_AUTHOR_ROLES,
  type CommentAuthorRole,
  type Db,
} from "../store/index.ts";
import {
  type HeuristicAttachment,
  type HeuristicMaterial,
  kindFromMime,
  type TurnedInInput,
  type TurnedInResult,
  turnedInSignals,
} from "./heuristics.ts";
import { isTemporaryUnreadable, type ReadabilityInput, unreadableReason } from "./readability.ts";

export type ReadText = (attachment: Attachment) => Promise<string | undefined>;

const TEXT_EXTS: ReadonlySet<string> = new Set([".txt", ".csv", ".md"]);

/** Reads cached text exports (`<dataDir>/<contentPath>`); other content yields `undefined`. */
export function cachedTextReader(dataDir: string): ReadText {
  return async (a) => {
    if (!a.contentPath || !TEXT_EXTS.has(extname(a.contentPath))) return undefined;
    return readFile(join(dataDir, a.contentPath), "utf8").catch(() => undefined);
  };
}

/** Absolute local image path of an attachment, when one is cached. */
export type ImagePathOf = (attachment: Attachment) => string | undefined;

const IMAGE_EXTS: ReadonlySet<string> = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".heic",
  ".heif",
]);

/** Cached image files (`<dataDir>/<contentPath>` with an image extension). */
export function cachedImagePath(dataDir: string): ImagePathOf {
  return (a) =>
    a.contentPath && IMAGE_EXTS.has(extname(a.contentPath).toLowerCase())
      ? join(dataDir, a.contentPath)
      : undefined;
}

/** Structure summary of an Office/Slides attachment, when one is cached. */
export type ReadOffice = (attachment: Attachment) => Promise<OfficeSummary | undefined>;

/** Reads `<stem>.office.json` next to a cached `<stem>.txt` (see `fetchAttachment`). */
export function cachedOfficeReader(dataDir: string): ReadOffice {
  return async (a) => {
    if (!a.contentPath?.endsWith(".txt")) return undefined;
    try {
      const v: unknown = JSON.parse(
        await readFile(join(dataDir, officeSummaryPath(a.contentPath)), "utf8"),
      );
      return isOfficeSummary(v) ? v : undefined;
    } catch {
      return undefined;
    }
  };
}

export interface LoadOptions {
  imagePathOf?: ImagePathOf | undefined;
  readOffice?: ReadOffice | undefined;
}

function instructionsOf(payload: string | undefined): string {
  if (!payload) return "";
  try {
    const p = JSON.parse(payload) as { instructions?: unknown; description?: unknown };
    const v = p.instructions ?? p.description;
    return typeof v === "string" ? v : "";
  } catch {
    return "";
  }
}

/** The latest this many private comments go to the review. */
export const REVIEW_COMMENTS = 10;

/** Loads the snapshot for one submission version (current attachments, latest instructions). */
export async function loadTurnedInInput(
  db: Db,
  submissionVersionId: number,
  readText: ReadText,
  { imagePathOf, readOffice }: LoadOptions = {},
): Promise<TurnedInInput | null> {
  const v = await db.submissionVersion.findUnique({
    where: { id: submissionVersionId },
    include: {
      submission: {
        include: {
          assignment: {
            include: {
              course: { select: { name: true } },
              attachments: { orderBy: { id: "asc" } },
              versions: { orderBy: [{ seenAt: "desc" }, { id: "desc" }], take: 1 },
              comments: {
                orderBy: [{ postedAt: "desc" }, { id: "desc" }],
                take: REVIEW_COMMENTS,
              },
            },
          },
        },
      },
    },
  });
  if (!v) return null;
  const { assignment } = v.submission;
  const toItem = async (a: Attachment): Promise<HeuristicAttachment & HeuristicMaterial> => {
    const imagePath = imagePathOf?.(a);
    const office = await readOffice?.(a);
    const kind = kindFromMime(a.mime, a.url);
    const title = a.title ?? a.url;
    const text = await readText(a);
    const readability: ReadabilityInput = {
      kind,
      title,
      url: a.url,
      mime: a.mime,
      contentPath: a.contentPath,
      fetchError: a.fetchError,
      text,
      imagePath,
      hasStructure: office !== undefined,
    };
    const unreadable = unreadableReason(readability);
    return {
      kind,
      title,
      driveFileId: a.driveFileId,
      text,
      ...(unreadable ? { unreadable } : {}),
      ...(unreadable && isTemporaryUnreadable(readability) ? { unreadableTemporary: true } : {}),
      ...(a.isTemplate ? { isTemplate: true } : {}),
      ...(a.templateSourceId ? { templateSourceId: a.templateSourceId } : {}),
      ...(imagePath ? { imagePath } : {}),
      ...(office ? { office } : {}),
    };
  };
  const byOwner = (owner: string) =>
    Promise.all(assignment.attachments.filter((a) => a.owner === owner).map(toItem));
  return {
    assignment: {
      kind: assignment.kind,
      title: assignment.title,
      instructions: instructionsOf(assignment.versions[0]?.payload),
      materials: await byOwner("material"),
      courseName: assignment.course.name,
      dueAt: assignment.dueAt,
    },
    submission: {
      state: v.state,
      turnedInAt: v.submission.turnedInAt,
      attachments: await byOwner("submission"),
    },
    comments: assignment.comments.reverse().map((c) => ({
      authorRole: COMMENT_AUTHOR_ROLES.includes(c.authorRole as CommentAuthorRole)
        ? (c.authorRole as CommentAuthorRole)
        : "unknown",
      postedAt: c.postedAt,
      text: c.text,
    })),
  };
}

/** Runs the turned-in heuristics for a submission version; `null` when it doesn't exist. */
export async function evaluateTurnedIn(
  db: Db,
  submissionVersionId: number,
  readText: ReadText,
  opts: LoadOptions = {},
): Promise<TurnedInResult | null> {
  const input = await loadTurnedInInput(db, submissionVersionId, readText, opts);
  return input && turnedInSignals(input);
}
