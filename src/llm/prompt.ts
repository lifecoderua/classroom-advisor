import type { z } from "zod";
import { type ReviewInput, reviewOutputJsonSchema } from "./types.ts";

/** Generic fallback; the real domain prompt is supplied by the caller via `ReviewOptions.instructions`. */
export const DEFAULT_INSTRUCTIONS =
  "Review the student's submission against the assignment and report whether it addresses it.";

/** Image paths referenced by the input, in order, de-duplicated. */
export function imagePaths(input: ReviewInput): string[] {
  const paths = input.submission.attachments.flatMap((a) => (a.imagePath ? [a.imagePath] : []));
  return [...new Set(paths)];
}

/**
 * Wraps the caller's instructions with the input payload and output-format rules.
 * Provider-agnostic plumbing only: no domain guidance lives here.
 */
export function buildPrompt(input: ReviewInput, instructions = DEFAULT_INSTRUCTIONS): string {
  const parts = [
    instructions.trim(),
    `## Input\n\n\`\`\`json\n${JSON.stringify(input, null, 2)}\n\`\`\``,
  ];
  const images = imagePaths(input);
  if (images.length > 0) {
    parts.push(
      "## Images\n\nSome attachments have an `imagePath`. Use the Read tool to view each of these files before answering. Do not read any other file.\n\n" +
        images.map((p) => `- ${p}`).join("\n"),
    );
  }
  parts.push(outputFormatInstructions());
  return parts.join("\n\n");
}

export function outputFormatInstructions(): string {
  return (
    "## Output format\n\nRespond with a single JSON object and nothing else (no prose, no code fences). " +
    "It must match this JSON Schema:\n\n" +
    JSON.stringify(reviewOutputJsonSchema)
  );
}

/** Follow-up prompt after an invalid answer: the original prompt plus what went wrong. */
export function buildCorrectivePrompt(original: string, problem: string): string {
  return (
    `${original}\n\n## Correction\n\nA previous answer to this request was rejected: ${problem}\n` +
    "Answer again with only the JSON object matching the schema above."
  );
}

/** Pulls a JSON object out of model text, tolerating code fences and surrounding prose. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidates = [trimmed, fenced?.[1]?.trim()];
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) candidates.push(trimmed.slice(start, end + 1));
  for (const c of candidates) {
    if (!c) continue;
    try {
      return JSON.parse(c);
    } catch {
      // try next candidate
    }
  }
  throw new SyntaxError("no JSON object found in model output");
}

export function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("; ");
}
