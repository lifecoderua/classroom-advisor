import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeProvider } from "../../src/llm/index.ts";
import { runCycle, runLoop, type SyncFn, stubSync } from "../../src/run/cycle.ts";
import { parseQuietHours } from "../../src/run/schedule.ts";
import {
  type Db,
  upsertAccount,
  upsertAssignment,
  upsertCourse,
  upsertSubmission,
} from "../../src/store/index.ts";
import { migratedTemplate } from "../store/helpers.ts";

const NOW = new Date("2026-10-10T12:00:00Z");
const H = 3_600_000;

let template: ReturnType<typeof migratedTemplate>;
let db: Db;

beforeAll(() => {
  template = migratedTemplate();
}, 60_000);
afterAll(() => template.cleanup());
beforeEach(async () => {
  db = await template.fresh();
});

/** A fake sync that stores one due-soon assignment and one turned-in submission. */
const fakeSync =
  (calls: string[]): SyncFn =>
  async ({ db, now }) => {
    calls.push("sync");
    const account = await upsertAccount(db, { email: "student-one@school.example" });
    await db.account.update({ where: { id: account.id }, data: { watched: true } });
    const course = await upsertCourse(db, {
      accountId: account.id,
      classroomId: "c",
      name: "Math",
    });
    const base = { accountId: account.id, courseId: course.id, kind: "assignment" as const };
    await upsertAssignment(
      db,
      {
        ...base,
        classroomId: "soon",
        title: "Due soon",
        status: "assigned",
        dueAt: new Date(now.getTime() + 3 * H),
        postedAt: new Date(now.getTime() - 48 * H),
        hash: "soon",
        payload: {},
      },
      now,
    );
    const { assignment } = await upsertAssignment(
      db,
      {
        ...base,
        classroomId: "done",
        title: "Essay",
        status: "turned_in",
        hash: "done",
        payload: { instructions: "Write an essay." },
      },
      now,
    );
    await upsertSubmission(
      db,
      { assignmentId: assignment.id, state: "turned_in", turnedInAt: now, hash: "s", payload: {} },
      now,
    );
  };

const warnProvider = () =>
  new FakeProvider({
    respond: {
      verdict: "warn",
      addressesAssignment: true,
      missingParts: [],
      issues: [],
      summaryForParent: "Only half is done.",
      confidence: 0.8,
    },
  });

describe("runCycle", () => {
  it("syncs, evaluates deadlines, reviews and prints only new alerts", async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    const provider = warnProvider();
    const deps = {
      db,
      sync: fakeSync(calls),
      provider,
      readText: async () => undefined,
      now: () => NOW,
      log: (l: string) => logs.push(l),
      timeZone: "UTC",
    };
    const first = await runCycle(deps);
    expect(calls).toEqual(["sync"]);
    expect(first.errors).toEqual([]);
    expect(first.reviewed).toBe(1);
    expect(provider.calls).toHaveLength(1);
    expect(first.newAlertIds).toHaveLength(2);
    expect(first.digest).toContain("== student-one ==");
    expect(first.digest).toContain("🔴 Panics");
    expect(first.digest).toContain("Only half is done.");

    // Idempotent: nothing new on the second cycle, so no digest and no second review.
    const second = await runCycle(deps);
    expect(calls).toEqual(["sync", "sync"]);
    expect(second).toEqual({ newAlertIds: [], reviewed: 0, errors: [] });
    expect(provider.calls).toHaveLength(1);
  });

  it("keeps going when sync fails", async () => {
    const logs: string[] = [];
    await fakeSync([])({ db, now: NOW, log: () => {} });
    const res = await runCycle({
      db,
      sync: async () => {
        throw new Error("session missing");
      },
      provider: warnProvider(),
      readText: async () => undefined,
      now: () => NOW,
      log: (l) => logs.push(l),
    });
    expect(res.errors).toEqual(["sync failed: Error: session missing"]);
    expect(res.newAlertIds).toHaveLength(2);
    expect(logs[0]).toContain("sync failed");
  });

  it("uses the stub sync until #19", async () => {
    const logs: string[] = [];
    const res = await runCycle({
      db,
      sync: stubSync,
      provider: warnProvider(),
      readText: async () => undefined,
      now: () => NOW,
      log: (l) => logs.push(l),
    });
    expect(logs).toEqual(["sync not implemented (#19); checking stored data only"]);
    expect(res).toEqual({ newAlertIds: [], reviewed: 0, errors: [] });
  });
});

describe("runLoop", () => {
  const quiet = parseQuietHours("22:00-07:00");
  // Local times, matching how quiet hours are evaluated.
  const clock = (hour: number) => () => new Date(2026, 9, 10, hour);

  it("runs every interval, skips quiet hours and stops on abort", async () => {
    const controller = new AbortController();
    const hours = [21, 23, 3, 8];
    let tick = 0;
    const now = () => new Date(2026, 9, 10, hours[tick] ?? 0);
    const sleeps: number[] = [];
    const ran: number[] = [];
    const res = await runLoop({
      intervalMin: 60,
      quietHours: quiet,
      signal: controller.signal,
      log: () => {},
      now,
      cycle: async () => {
        ran.push(hours[tick] ?? -1);
      },
      sleep: async (ms) => {
        sleeps.push(ms);
        tick++;
        if (tick === hours.length - 1) {
          // Abort while the last (non-quiet) cycle is due: it must not start.
          controller.abort();
        }
      },
    });
    expect(ran).toEqual([21]);
    expect(res).toEqual({ cycles: 1, skipped: 2 });
    expect(sleeps).toEqual([3_600_000, 3_600_000, 3_600_000]);
  });

  it("--once runs a single cycle even in quiet hours", async () => {
    let n = 0;
    const res = await runLoop({
      intervalMin: 60,
      quietHours: quiet,
      once: true,
      signal: new AbortController().signal,
      now: clock(23),
      cycle: async () => {
        n++;
      },
      sleep: async () => {
        throw new Error("should not sleep");
      },
    });
    expect(n).toBe(1);
    expect(res).toEqual({ cycles: 1, skipped: 0 });
  });

  it("finishes the current cycle on SIGINT-style abort", async () => {
    const controller = new AbortController();
    let finished = false;
    const res = await runLoop({
      intervalMin: 1,
      signal: controller.signal,
      log: () => {},
      cycle: async () => {
        controller.abort();
        await Promise.resolve();
        finished = true;
      },
    });
    expect(finished).toBe(true);
    expect(res.cycles).toBe(1);
  });
});
