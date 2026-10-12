import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkDatabase,
  chromeCandidates,
  chromeCheck,
  runDoctor,
  which,
} from "../src/cli/doctor.ts";
import type { Config } from "../src/config/index.ts";
import { setWatchedAccounts, upsertAccount } from "../src/store/index.ts";
import { migratedTemplate } from "./store/helpers.ts";

describe("chromeCandidates", () => {
  it("is platform-aware", () => {
    expect(chromeCandidates("darwin")[0]).toContain("/Applications/Google Chrome.app");
    expect(chromeCandidates("linux")).toContain("/usr/bin/google-chrome");
    expect(chromeCandidates("win32", { PROGRAMFILES: "C:\\PF" })[0]).toMatch(/chrome\.exe$/);
  });
});

describe("chromeCheck", () => {
  it("checks the bundled build for the chromium channel", () => {
    expect(chromeCheck("chromium", () => "/nonexistent/chrome")).toMatchObject({
      ok: false,
      detail: expect.stringContaining("playwright install chromium"),
    });
    expect(chromeCheck("chromium", () => process.execPath).ok).toBe(true);
    expect(chromeCheck("msedge").detail).toContain("not checked");
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
  chromeChannel: "chrome",
  dataDir: "/nonexistent/data",
  watchedAccounts: [],
  llmProvider: "fake",
  claudeBin: "definitely-not-a-real-binary-xyz",
  geminiModel: "gemini-test",
  llmTimeoutMs: 1000,
  runIntervalMin: 60,
  alertLookbackDays: 14,
  digestLang: "en",
  timeZone: "UTC",
  backlogForgetDays: 14,
  upcomingDays: 14,
  refreshCooldownMin: 5,
  fullRefreshDays: 7,
  syncDelayMs: 0,
  telegramChatIds: [],
  telegramDigestTime: "19:00",
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
      "Telegram",
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

describe("runDoctor Telegram", () => {
  it("reports the token and linked chats without printing the token", () => {
    const tg = (c: Config) => runDoctor(c).find((r) => r.name === "Telegram");
    expect(tg(base)).toMatchObject({ ok: true, detail: expect.stringContaining("not set") });
    const unlinked = tg({ ...base, telegramBotToken: "123:sekret" });
    expect(unlinked).toMatchObject({ ok: false, detail: expect.stringContaining("telegram link") });
    const linked = tg({ ...base, telegramBotToken: "123:sekret", telegramChatIds: ["42"] });
    expect(linked?.ok).toBe(true);
    expect(linked?.detail).not.toContain("sekret");
  });
});

describe("checkDatabase", () => {
  it("fails when the DB file is missing", async () => {
    const r = await checkDatabase({ dataDir: "/nonexistent/data" });
    expect(r).toMatchObject({ name: "Database", ok: false });
    expect(r.detail).toContain("db:migrate");
  });

  it("counts watched accounts", async () => {
    const template = migratedTemplate();
    const dataDir = mkdtempSync(join(tmpdir(), "ca-doctor-"));
    try {
      const db = await template.fresh();
      await upsertAccount(db, { email: "student-one@school.example" });
      await setWatchedAccounts(db, ["student-two@school.example"]);
      const [row] = await db.$queryRawUnsafe<{ file: string }[]>(
        "SELECT file FROM pragma_database_list WHERE name = 'main'",
      );
      copyFileSync(row?.file ?? "", join(dataDir, "app.db"));
      expect(await checkDatabase({ dataDir })).toEqual({
        name: "Database",
        ok: true,
        detail: "1 watched of 2 account(s)",
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      await template.cleanup();
    }
  }, 60_000);
});
