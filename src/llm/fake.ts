import {
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
};

export type FakeResponder = (input: ReviewInput, opts: ReviewOptions) => ReviewOutput | Error;

export interface FakeProviderOptions {
  /** Fixed output, or a function of the input. Returning an `Error` makes `review` reject with it. */
  respond?: ReviewOutput | FakeResponder;
}

/** Deterministic provider for tests. Records every call in `calls`. */
export class FakeProvider implements LlmProvider {
  readonly name = "fake";
  readonly calls: { input: ReviewInput; opts: ReviewOptions }[] = [];

  constructor(private readonly options: FakeProviderOptions = {}) {}

  async review(input: ReviewInput, opts: ReviewOptions = {}): Promise<ReviewOutput> {
    this.calls.push({ input, opts });
    const { respond = DEFAULT_FAKE_OUTPUT } = this.options;
    const out = typeof respond === "function" ? respond(input, opts) : respond;
    if (out instanceof Error) throw out;
    return reviewOutputSchema.parse(out);
  }
}
