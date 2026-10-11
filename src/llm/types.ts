import { z } from "zod";

export const signalSchema = z.object({
  /** Heuristic signal code, e.g. `no_attachments`, `template_unchanged`. */
  code: z.string().min(1),
  confidence: z.number().min(0).max(1),
  detail: z.string().optional(),
});

export const materialSchema = z.object({
  title: z.string(),
  kind: z.string(),
  /** Extracted text, when available. */
  text: z.string().optional(),
  /**
   * Structure of a presentation/document read from the file itself: slide count, pictures,
   * shapes, animation effects and transitions per slide (or images/tables for documents).
   */
  structure: z.string().optional(),
});

export const attachmentSchema = materialSchema.extend({
  /** Absolute path to a local image (screenshot/photo/rendered page) of the attachment. */
  imagePath: z.string().optional(),
});

export const commentSchema = z.object({
  author: z.enum(["teacher", "student", "unknown"]),
  /** ISO 8601. */
  postedAt: z.string(),
  text: z.string(),
});

export const reviewInputSchema = z.object({
  assignment: z.object({
    title: z.string(),
    instructions: z.string(),
    kind: z.string(),
    courseName: z.string(),
    /** ISO 8601. */
    dueAt: z.string().optional(),
  }),
  materials: z.array(materialSchema),
  submission: z.object({
    attachments: z.array(attachmentSchema),
    /** ISO 8601. */
    turnedInAt: z.string(),
  }),
  signals: z.array(signalSchema),
  /**
   * Recent private comments between the teacher and the student on this submission, oldest
   * first (text may be truncated).
   */
  comments: z.array(commentSchema).optional(),
  /** Language hint for the feedback (e.g. `uk`, `en`). Defaults to the assignment's language. */
  locale: z.string().optional(),
});

export type ReviewInput = z.infer<typeof reviewInputSchema>;

export const VERDICTS = ["ok", "warn", "panic"] as const;
export const SEVERITIES = ["low", "medium", "high"] as const;

export const reviewOutputSchema = z.strictObject({
  verdict: z.enum(VERDICTS),
  addressesAssignment: z.boolean(),
  missingParts: z.array(z.string()),
  issues: z.array(z.strictObject({ severity: z.enum(SEVERITIES), text: z.string() })),
  summaryForParent: z.string(),
  confidence: z.number().min(0).max(1),
});

export type ReviewOutput = z.infer<typeof reviewOutputSchema>;

/** JSON Schema of `ReviewOutput`, for providers that support structured output. */
export const reviewOutputJsonSchema = z.toJSONSchema(reviewOutputSchema, { target: "draft-07" });

export interface ReviewOptions {
  /**
   * Task instructions for the model (the domain prompt, owned by the checks layer).
   * A minimal generic instruction is used when omitted.
   */
  instructions?: string;
  /** Overrides the provider's default timeout. */
  timeoutMs?: number;
}

export interface LlmProvider {
  readonly name: string;
  review(input: ReviewInput, opts?: ReviewOptions): Promise<ReviewOutput>;
}

export class LlmError extends Error {
  override name = "LlmError";
}
