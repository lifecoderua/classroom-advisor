import type { Config } from "../config/index.ts";
import { ClaudeCliProvider, type Runner } from "./claude-cli.ts";
import { FakeProvider } from "./fake.ts";
import { LlmError, type LlmProvider } from "./types.ts";

export * from "./claude-cli.ts";
export * from "./fake.ts";
export * from "./prompt.ts";
export * from "./types.ts";

export interface CreateProviderDeps {
  /** Command runner for `claude-cli` (tests). */
  runner?: Runner;
}

export function createProvider(
  config: Pick<Config, "llmProvider" | "claudeBin" | "claudeModel" | "llmTimeoutMs">,
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
      throw new LlmError("LLM provider 'gemini' is not implemented yet");
  }
}
