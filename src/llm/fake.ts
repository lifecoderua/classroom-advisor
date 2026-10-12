import {
  type GenerateOptions,
  type JsonTask,
  LlmError,
  type LlmProvider,
  type ReviewInput,
  type ReviewOptions,
  type ReviewOutput,
  reviewOutputSchema,
} from "./types.ts";

export const DEFAULT_FAKE_OUTPUT: ReviewOutput = {
  verdict: "ok",
  addressesAssignment: true,
  missingParts: [],
  issues: [],
  summaryForParent: "Looks complete.",
  confidence: 0.9,
  unverifiable: [],
};

export type FakeResponder = (input: ReviewInput, opts: ReviewOptions) => ReviewOutput | Error;

/** Answer of a `generate` call: anything (validated by the task's schema) or an `Error`. */
export type FakeJsonResponder = (task: JsonTask<unknown>) => unknown;

export interface FakeProviderOptions {
  /** Fixed output, or a function of the input. Returning an `Error` makes `review` reject with it. */
  respond?: ReviewOutput | FakeResponder;
  /**
   * Answers `generate` calls. Returning an `Error` makes the call reject with it. Without it,
   * `generate` rejects with an `LlmError` (as a provider failure would).
   */
  respondJson?: FakeJsonResponder;
}

/** Deterministic provider for tests. Records every call in `calls` / `jsonCalls`. */
export class FakeProvider implements LlmProvider {
  readonly name = "fake";
  readonly calls: { input: ReviewInput; opts: ReviewOptions }[] = [];
  readonly jsonCalls: JsonTask<unknown>[] = [];

  constructor(private readonly options: FakeProviderOptions = {}) {}

  async review(input: ReviewInput, opts: ReviewOptions = {}): Promise<ReviewOutput> {
    this.calls.push({ input, opts });
    const { respond = DEFAULT_FAKE_OUTPUT } = this.options;
    const out = typeof respond === "function" ? respond(input, opts) : respond;
    if (out instanceof Error) throw out;
    return reviewOutputSchema.parse(out);
  }

  async generate<T>(task: JsonTask<T>, _opts: GenerateOptions = {}): Promise<T> {
    this.jsonCalls.push(task as JsonTask<unknown>);
    const respond = this.options.respondJson;
    if (!respond) throw new LlmError("fake provider: no JSON responder");
    const out = respond(task as JsonTask<unknown>);
    if (out instanceof Error) throw out;
    return task.schema.parse(out);
  }
}
