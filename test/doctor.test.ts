import { describe, expect, it } from "vitest";
import { chromeCandidates, runDoctor, which } from "../src/cli/doctor.ts";
import type { Config } from "../src/config/index.ts";

describe("chromeCandidates", () => {
  it("is platform-aware", () => {
    expect(chromeCandidates("darwin")[0]).toContain("/Applications/Google Chrome.app");
    expect(chromeCandidates("linux")).toContain("/usr/bin/google-chrome");
    expect(chromeCandidates("win32", { PROGRAMFILES: "C:\\PF" })[0]).toMatch(/chrome\.exe$/);
  });
});

describe("which", () => {
  it("finds node on PATH and misses nonsense", () => {
    expect(which("node")).toBeTruthy();
    expect(which("definitely-not-a-real-binary-xyz")).toBeUndefined();
  });
});

const base: Config = {
  profileDir: "/nonexistent/profile",
  dataDir: "/nonexistent/data",
  watchedAccounts: [],
  llmProvider: "fake",
  claudeBin: "definitely-not-a-real-binary-xyz",
  geminiModel: "gemini-test",
  llmTimeoutMs: 1000,
  runIntervalMin: 60,
};

describe("runDoctor", () => {
  it("reports each check", () => {
    const results = runDoctor(base);
    expect(results.map((r) => r.name)).toEqual([
      "Node",
      "Chrome",
      "Profile dir",
      "claude CLI",
      "Gemini key",
    ]);
    expect(results.find((r) => r.name === "Node")?.ok).toBe(true);
    expect(results.find((r) => r.name === "Profile dir")?.ok).toBe(false);
    expect(results.find((r) => r.name === "claude CLI")?.ok).toBe(false);
  });

  it("reports whether GEMINI_API_KEY is set without printing it", () => {
    const gemini = (c: Config) => runDoctor(c).find((r) => r.name === "Gemini key");
    expect(gemini(base)).toMatchObject({ ok: true, detail: "GEMINI_API_KEY not set" });
    expect(gemini({ ...base, llmProvider: "gemini" })).toMatchObject({
      ok: false,
      detail: expect.stringContaining("required"),
    });
    const set = gemini({ ...base, llmProvider: "gemini", geminiApiKey: "sekret-123" });
    expect(set?.ok).toBe(true);
    expect(set?.detail).toContain("set");
    expect(set?.detail).not.toContain("sekret-123");
  });
});
