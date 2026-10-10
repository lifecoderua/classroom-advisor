import { describe, expect, it } from "vitest";
import { chromeCandidates, runDoctor, which } from "../src/cli/doctor.ts";

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

describe("runDoctor", () => {
  it("reports each check", () => {
    const results = runDoctor({
      profileDir: "/nonexistent/profile",
      dataDir: "/nonexistent/data",
      watchedAccounts: [],
      llmProvider: "fake",
      claudeBin: "definitely-not-a-real-binary-xyz",
    });
    expect(results.map((r) => r.name)).toEqual(["Node", "Chrome", "Profile dir", "claude CLI"]);
    expect(results.find((r) => r.name === "Node")?.ok).toBe(true);
    expect(results.find((r) => r.name === "Profile dir")?.ok).toBe(false);
    expect(results.find((r) => r.name === "claude CLI")?.ok).toBe(false);
  });
});
