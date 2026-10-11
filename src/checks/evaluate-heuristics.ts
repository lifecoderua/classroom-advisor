import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { Attachment, Db } from "../store/index.ts";
import {
  type HeuristicAttachment,
  type HeuristicMaterial,
  kindFromMime,
  type TurnedInInput,
  type TurnedInResult,
  turnedInSignals,
} from "./heuristics.ts";

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

/** Loads the snapshot for one submission version (current attachments, latest instructions). */
export async function loadTurnedInInput(
  db: Db,
  submissionVersionId: number,
  readText: ReadText,
  imagePathOf?: ImagePathOf,
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
    return {
      kind: kindFromMime(a.mime, a.url),
      title: a.title ?? a.url,
      driveFileId: a.driveFileId,
      text: await readText(a),
      ...(a.isTemplate ? { isTemplate: true } : {}),
      ...(a.templateSourceId ? { templateSourceId: a.templateSourceId } : {}),
      ...(imagePath ? { imagePath } : {}),
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
  };
}

/** Runs the turned-in heuristics for a submission version; `null` when it doesn't exist. */
export async function evaluateTurnedIn(
  db: Db,
  submissionVersionId: number,
  readText: ReadText,
): Promise<TurnedInResult | null> {
  const input = await loadTurnedInInput(db, submissionVersionId, readText);
  return input && turnedInSignals(input);
}
