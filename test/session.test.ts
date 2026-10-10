import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSingletonLock, profileLock } from "../src/collector/session.ts";
import { ConfigError } from "../src/config/index.ts";
import { setWatched } from "../src/config/local.ts";

describe("parseSingletonLock", () => {
  it("splits host and pid", () => {
    expect(parseSingletonLock("my-host.local-4242")).toEqual({ host: "my-host.local", pid: 4242 });
    expect(parseSingletonLock("garbage")).toBeUndefined();
  });
});

describe("profileLock", () => {
  const readlink = () => "box-123";
  it("is undefined without a lock file", () => {
    expect(profileLock("/nonexistent/profile")).toBeUndefined();
  });
  it("reports a live lock on this host", () => {
    expect(profileLock("/p", { readlink, host: "box", alive: () => true })).toEqual({
      host: "box",
      pid: 123,
    });
  });
  it("ignores a stale lock on this host", () => {
    expect(profileLock("/p", { readlink, host: "box", alive: () => false })).toBeUndefined();
  });
  it("treats a lock from another host as held", () => {
    expect(profileLock("/p", { readlink, host: "other", alive: () => false })).toBeDefined();
  });
});

describe("setWatched", () => {
  let dir: string;
  const file = () => join(dir, "config.local.json");
  const read = () => JSON.parse(readFileSync(file(), "utf8"));
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ca-watch-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the file and adds a normalized email", () => {
    expect(setWatched(dir, " Kid1@School.example ", true)).toEqual({
      changed: true,
      watchedAccounts: ["kid1@school.example"],
    });
    expect(read()).toEqual({ watchedAccounts: ["kid1@school.example"] });
  });

  it("preserves other keys and is idempotent", () => {
    writeFileSync(
      file(),
      JSON.stringify({ llmProvider: "fake", watchedAccounts: ["kid1@school.example"] }),
    );
    expect(setWatched(dir, "kid1@school.example", true).changed).toBe(false);
    setWatched(dir, "kid2@school.example", true);
    expect(read()).toEqual({
      llmProvider: "fake",
      watchedAccounts: ["kid1@school.example", "kid2@school.example"],
    });
    setWatched(dir, "KID1@school.example", false);
    expect(read()).toEqual({ llmProvider: "fake", watchedAccounts: ["kid2@school.example"] });
    expect(setWatched(dir, "kid9@school.example", false).changed).toBe(false);
  });

  it("rejects bad input", () => {
    expect(() => setWatched(dir, "not-an-email", true)).toThrow(ConfigError);
    writeFileSync(file(), "[1]");
    expect(() => setWatched(dir, "kid1@school.example", true)).toThrow(/JSON object/);
  });
});
