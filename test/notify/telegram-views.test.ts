import { describe, expect, it } from "vitest";
import {
  type Action,
  decodeAction,
  encodeAction,
  shortTitle,
} from "../../src/notify/telegram-views.ts";

describe("telegram views", () => {
  it("round-trips callback data within Telegram's 64 bytes", () => {
    const actions: Action[] = [
      { kind: "home" },
      { kind: "list", kid: 12, page: 3 },
      { kind: "card", kid: 12, page: 0, ref: "a123456" },
      { kind: "seen", kid: 0, page: 2, ref: "x99" },
      { kind: "seenCard", ref: "a7" },
      { kind: "recheck", assignmentId: 42 },
      { kind: "upcoming" },
      { kind: "refresh" },
      { kind: "noop" },
    ];
    for (const a of actions) {
      const data = encodeAction(a);
      expect(data.length).toBeLessThanOrEqual(64);
      expect(decodeAction(data)).toEqual(a);
    }
    for (const bad of ["", "zz", "l:x:1", "c:1:0:b5", "S:", "r:abc"]) {
      expect(decodeAction(bad)).toBeNull();
    }
  });

  it("drops leading and trailing dates from titles and shortens them", () => {
    expect(shortTitle("13.10 Геометрія. Тематична робота")).toBe("Геометрія. Тематична робота");
    expect(shortTitle("12.10-16.10.2026 біологія")).toBe("біологія");
    expect(shortTitle("Українська мова 14.10.26")).toBe("Українська мова");
    expect(shortTitle("13.10")).toBe("13.10");
    expect(shortTitle("A".repeat(60))).toBe(`${"A".repeat(41)}…`);
    expect(shortTitle("line one\n  line two")).toBe("line one line two");
  });
});
