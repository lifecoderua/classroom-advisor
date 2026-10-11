import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_GEMINI_MODEL, expandHome, loadConfig } from "../src/config/index.ts";

const HOME = "/home/tester";
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ca-config-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const load = (env: NodeJS.ProcessEnv = {}) => loadConfig({ cwd: dir, env, home: HOME });
const writeJson = (value: unknown) =>
  writeFileSync(join(dir, "config.local.json"), JSON.stringify(value));

describe("expandHome", () => {
  it("expands ~ and ~/", () => {
    expect(expandHome("~", HOME)).toBe(HOME);
    expect(expandHome("~/x/y", HOME)).toBe("/home/tester/x/y");
    expect(expandHome("/abs/~/x", HOME)).toBe("/abs/~/x");
  });
});

describe("loadConfig", () => {
  it("returns defaults with no files and no env", () => {
    expect(load()).toEqual({
      profileDir: "/home/tester/.classroom-advisor/chrome-profile",
      chromeChannel: "chrome",
      dataDir: join(dir, ".data"),
      watchedAccounts: [],
      llmProvider: "claude-cli",
      claudeBin: "claude",
      geminiModel: DEFAULT_GEMINI_MODEL,
      llmTimeoutMs: 180_000,
      runIntervalMin: 60,
      alertLookbackDays: 14,
      fullRefreshDays: 7,
      syncDelayMs: 300,
    });
  });

  it("reads config.local.json", () => {
    writeJson({
      profileDir: "/tmp/profile",
      dataDir: "data",
      watchedAccounts: ["kid@school.example"],
      llmProvider: "fake",
    });
    const c = load();
    expect(c.profileDir).toBe("/tmp/profile");
    expect(c.dataDir).toBe(join(dir, "data"));
    expect(c.watchedAccounts).toEqual(["kid@school.example"]);
    expect(c.llmProvider).toBe("fake");
  });

  it("layers .env over the JSON file and process env over .env", () => {
    writeJson({ llmProvider: "fake", claudeBin: "from-json" });
    writeFileSync(
      join(dir, ".env"),
      "CA_LLM_PROVIDER=gemini\nCA_CLAUDE_BIN=from-dotenv\nCA_WATCHED_ACCOUNTS=a@x.example, b@x.example\n",
    );
    const c = load({ CA_CLAUDE_BIN: "from-env" });
    expect(c.llmProvider).toBe("gemini");
    expect(c.claudeBin).toBe("from-env");
    expect(c.watchedAccounts).toEqual(["a@x.example", "b@x.example"]);
  });

  it("ignores empty env values", () => {
    expect(load({ CA_LLM_PROVIDER: "  " }).llmProvider).toBe("claude-cli");
  });

  it("rejects an unknown provider", () => {
    expect(() => load({ CA_LLM_PROVIDER: "openai" })).toThrow(ConfigError);
  });

  it("rejects invalid emails and unknown keys", () => {
    writeJson({ watchedAccounts: ["not-an-email"] });
    expect(() => load()).toThrow(/watchedAccounts/);
    writeJson({ typo: true });
    expect(() => load()).toThrow(ConfigError);
  });

  it("reads GEMINI_API_KEY from env or .env only, and the model from CA_GEMINI_MODEL", () => {
    expect(load()).not.toHaveProperty("geminiApiKey");
    writeFileSync(join(dir, ".env"), "GEMINI_API_KEY=from-dotenv\nCA_GEMINI_MODEL=gemini-x\n");
    expect(load()).toMatchObject({ geminiApiKey: "from-dotenv", geminiModel: "gemini-x" });
    expect(load({ GEMINI_API_KEY: "from-env" }).geminiApiKey).toBe("from-env");
    writeJson({ geminiApiKey: "in-json" });
    expect(() => load()).toThrow(ConfigError);
  });

  it("rejects malformed JSON", () => {
    writeFileSync(join(dir, "config.local.json"), "{ nope");
    expect(() => load()).toThrow(/Invalid JSON/);
  });
});
