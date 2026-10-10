import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireRunLock, lockPath, RunLockedError } from "../../src/run/lock.ts";
import { inQuietHours, parseDuration, parseQuietHours } from "../../src/run/schedule.ts";

// Local-time dates: quiet hours are evaluated in the process's time zone.
const at = (h: number, m = 0) => new Date(2026, 9, 10, h, m);

describe("quiet hours", () => {
  it("parses HH:MM-HH:MM", () => {
    expect(parseQuietHours("22:00-07:00")).toEqual({ start: 22 * 60, end: 7 * 60 });
    expect(parseQuietHours("9:30-12:15")).toEqual({ start: 570, end: 735 });
  });

  it("rejects bad specs", () => {
    for (const bad of ["", "22:00", "24:00-07:00", "22:60-07:00", "07:00-07:00", "a-b", "1-2-3"]) {
      expect(() => parseQuietHours(bad), bad).toThrow(/quietHours/);
    }
  });

  it("handles a range crossing midnight", () => {
    const q = parseQuietHours("22:00-07:00");
    expect(inQuietHours(q, at(21, 59))).toBe(false);
    expect(inQuietHours(q, at(22, 0))).toBe(true);
    expect(inQuietHours(q, at(23, 30))).toBe(true);
    expect(inQuietHours(q, at(0, 0))).toBe(true);
    expect(inQuietHours(q, at(6, 59))).toBe(true);
    expect(inQuietHours(q, at(7, 0))).toBe(false);
    expect(inQuietHours(q, at(12, 0))).toBe(false);
  });

  it("handles a same-day range", () => {
    const q = parseQuietHours("13:00-15:00");
    expect(inQuietHours(q, at(12, 59))).toBe(false);
    expect(inQuietHours(q, at(13, 0))).toBe(true);
    expect(inQuietHours(q, at(14, 59))).toBe(true);
    expect(inQuietHours(q, at(15, 0))).toBe(false);
    expect(inQuietHours(q, at(23, 0))).toBe(false);
  });
});

describe("parseDuration", () => {
  it("parses minutes, hours, days and weeks", () => {
    expect(parseDuration("90m")).toBe(90 * 60_000);
    expect(parseDuration("24h")).toBe(86_400_000);
    expect(parseDuration("3d")).toBe(3 * 86_400_000);
    expect(parseDuration("1W")).toBe(7 * 86_400_000);
  });

  it("rejects junk", () => {
    for (const bad of ["", "0h", "5", "h", "1.5h", "-2d", "2y"]) {
      expect(() => parseDuration(bad), bad).toThrow(/invalid duration/);
    }
  });
});

describe("run lock", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ca-lock-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes the PID and releases", () => {
    const lock = acquireRunLock(dir, { pid: 4242, isAlive: () => true });
    expect(JSON.parse(readFileSync(lockPath(dir), "utf8"))).toMatchObject({
      pid: 4242,
      host: hostname(),
    });
    expect(() => acquireRunLock(dir, { pid: 5555, isAlive: () => true })).toThrow(RunLockedError);
    lock.release();
    acquireRunLock(dir, { pid: 5555, isAlive: () => true }).release();
  });

  it("replaces a stale or unreadable lock", () => {
    writeFileSync(lockPath(dir), JSON.stringify({ pid: 999_999, host: hostname() }));
    const lock = acquireRunLock(dir, { pid: 1, isAlive: () => false });
    expect(JSON.parse(readFileSync(lockPath(dir), "utf8")).pid).toBe(1);
    lock.release();

    writeFileSync(lockPath(dir), "garbage");
    acquireRunLock(dir, { pid: 2, isAlive: () => true }).release();
  });

  it("keeps a lock held by another host", () => {
    writeFileSync(lockPath(dir), JSON.stringify({ pid: 1, host: "elsewhere.invalid" }));
    expect(() => acquireRunLock(dir, { pid: 2, isAlive: () => false })).toThrow(RunLockedError);
  });

  it("does not remove a lock it no longer owns", () => {
    const lock = acquireRunLock(dir, { pid: 3, isAlive: () => true });
    writeFileSync(lockPath(dir), JSON.stringify({ pid: 4, host: hostname() }));
    lock.release();
    expect(JSON.parse(readFileSync(lockPath(dir), "utf8")).pid).toBe(4);
  });
});
