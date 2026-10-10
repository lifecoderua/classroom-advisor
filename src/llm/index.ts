import type { Config } from "../config/index.ts";
import { ClaudeCliProvider, type Runner } from "./claude-cli.ts";
import { FakeProvider } from "./fake.ts";
import { type GeminiOptions, GeminiProvider } from "./gemini.ts";
import { LlmError, type LlmProvider } from "./types.ts";

export * from "./claude-cli.ts";
export * from "./fake.ts";
export * from "./gemini.ts";
export * from "./prompt.ts";
export * from "./types.ts";

export interface CreateProviderDeps {
  /** Command runner for `claude-cli` (tests). */
  runner?: Runner;
  /** HTTP layer for `gemini` (tests). */
  fetch?: GeminiOptions["fetch"];
}

export function createProvider(
  config: Pick<
    Config,
    "llmProvider" | "claudeBin" | "claudeModel" | "geminiModel" | "geminiApiKey" | "llmTimeoutMs"
  >,
  deps: CreateProviderDeps = {},
): LlmProvider {
  switch (config.llmProvider) {
    case "claude-cli":
      return new ClaudeCliProvider({
        bin: config.claudeBin,
        model: config.claudeModel,
        timeoutMs: config.llmTimeoutMs,
        runner: deps.runner,
      });
    case "fake":
      return new FakeProvider();
    case "gemini":
      if (!config.geminiApiKey) {
        throw new LlmError("LLM provider 'gemini' needs GEMINI_API_KEY in the environment or .env");
      }
      return new GeminiProvider({
        apiKey: config.geminiApiKey,
        model: config.geminiModel,
        timeoutMs: config.llmTimeoutMs,
        fetch: deps.fetch,
      });
  }
}
