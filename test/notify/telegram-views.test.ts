import { describe, expect, it } from "vitest";
import type { Report, ReportAlert } from "../../src/notify/console.ts";
import {
  type Action,
  buildModel,
  decodeAction,
  encodeAction,
  legacyTag,
  listView,
  shortTitle,
  shortTitles,
  summaryView,
} from "../../src/notify/telegram-views.ts";
import type { AlertContent, AlertLevel } from "../../src/store/types.ts";

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
      { kind: "login" },
      { kind: "login", layout: "phone" },
      { kind: "login", layout: "desktop" },
      { kind: "loginDone" },
      { kind: "noop" },
    ];
    for (const a of actions) {
      const data = encodeAction(a);
      expect(data.length).toBeLessThanOrEqual(64);
      expect(decodeAction(data)).toEqual(a);
    }
    for (const bad of ["", "zz", "l:x:1", "c:1:0:b5", "S:", "r:abc", "L:x"]) {
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
    // Separators the date leaves behind go too.
    expect(shortTitle("08.10.2026-географія о 09:40")).toBe("географія о 09:40");
    expect(shortTitle("08.10.2026 – історія")).toBe("історія");
    expect(shortTitle("Історія - 08.10.2026")).toBe("Історія");
  });

  it("keeps the dates of titles that would look like duplicates", () => {
    expect(
      shortTitles(["English. 09.10.2026", "English. 12.10.2026", "13.10 Геометрія", "Алгебра"]),
    ).toEqual(["English. 09.10.2026", "English. 12.10.2026", "Геометрія", "Алгебра"]);
    // The same title twice is the same post name, not a collision to explain.
    expect(shortTitles(["Music 01.10", "Music 01.10"])).toEqual(["Music", "Music"]);
  });

  it("tags free-text (legacy) alerts by their key", () => {
    const tag = (key: string, level: AlertLevel = "alert") => legacyTag({ key, level });
    expect(tag("deadline:7:untouched_24h")).toBe("untouched");
    expect(tag("deadline:7:due_soon", "panic")).toBe("dueSoon");
    expect(tag("deadline:7:missing", "panic")).toBe("missing");
    expect(tag("deadline:7:no_due_date:2026-W41", "info")).toBe("noDueDate");
    expect(tag("quality:9", "alert")).toBe("incomplete");
    expect(tag("quality:9", "panic")).toBe("redo");
    expect(tag("quality:9:unchecked", "info")).toBe("checkByHand");
    expect(tag("quality:9:c4:unchecked", "info")).toBe("checkByHand");
    expect(tag("quality:9:llm-failed")).toBe("notChecked");
    expect(tag("comment:3")).toBe("comment");
    expect(tag("sync:1:session_missing:2026-10-15")).toBe("sync");
    expect(tag("misc:1")).toBe("other");
  });
});

describe("digest model", () => {
  const NOW = new Date("2026-10-15T08:00:00Z");
  const loc = { lang: "en" as const, timeZone: "UTC" };
  let nextId = 1;
  const alert = (key: string, level: AlertLevel, content: AlertContent, muted = false) =>
    ({
      id: nextId++,
      key,
      level,
      content,
      createdAt: NOW,
      sentAt: null,
      mutedAt: muted ? NOW : null,
    }) satisfies ReportAlert;
  const report = (alerts: ReportAlert[]): Report => ({
    generatedAt: NOW,
    since: null,
    alertsOnly: true,
    accounts: [
      {
        id: 1,
        email: "kid@school.example",
        label: "Kid",
        panics: [],
        alerts,
        checkByHand: [],
        info: [],
        turnedIn: [],
        upcoming: [],
        backlog: [],
      },
    ],
    other: [],
    autoClosed: 0,
    upcomingDays: 0,
  });

  it("shows sync alerts as a banner, not as list items, and tags legacy alerts by key", () => {
    const session = alert("sync:1:session_missing:2026-10-15", "alert", {
      code: "sync.session",
      params: { account: "Kid", state: "missing" },
    });
    const closed = alert(
      "sync:1:drift:abc:2026-10-14",
      "alert",
      { code: "sync.drift", params: { account: "Kid", rpcid: "abc", error: "x" } },
      true,
    );
    const legacy = alert("deadline:5:untouched_24h", "alert", {
      code: "text",
      params: { text: "Not started: Art" },
    });
    const model = buildModel({
      report: report([session, closed, legacy]),
      alertAssignments: new Map([[legacy.id, 5]]),
      assignments: new Map([
        [
          5,
          {
            title: "Art",
            course: "Art",
            dueAt: null,
            postedAt: NOW,
            url: "https://classroom.example/a/5",
            turnedIn: false,
          },
        ],
      ]),
      loc,
    });
    const kid = model.kids[0];
    expect(kid?.banners.map((b) => b.alertId)).toEqual([session.id]);
    expect(kid?.groups.map((g) => g.ref)).toEqual(["a5"]);
    expect(kid?.groups[0]?.problems.map((p) => p.tag)).toEqual(["untouched"]);

    const list = listView(model, 1, 0, loc);
    expect(list.html).toMatch(/⚠️🆕 <i>Sync stopped for Kid/);
    expect(list.html).not.toContain("Art");
    // One full-width button per assignment, opening its card; 🔑 for the lost login; then Back.
    expect(list.keyboard.map((row) => row.length)).toEqual([1, 1, 1]);
    expect(list.keyboard[1]?.[0]).toMatchObject({ text: "🔑 Log in", callback_data: "L" });
    expect(list.keyboard[0]?.[0]?.text).toBe("🟠🆕 Art · from 15/10");
    expect(list.keyboard[0]?.[0]?.callback_data).toMatch(/^c:1:0:a5$/);
    expect(summaryView(model, "Digest", loc).html).toMatch(/Kid<\/b>.*\n⚠️/);
  });

  it("keeps a kid with only a sync banner on the summary", () => {
    const session = alert("sync:1:session_expired:2026-10-15", "alert", {
      code: "sync.session",
      params: { account: "Kid", state: "expired" },
    });
    const model = buildModel({
      report: report([session]),
      alertAssignments: new Map(),
      assignments: new Map(),
      loc,
    });
    expect(model.kids).toHaveLength(1);
    const summary = summaryView(model, "Digest", loc);
    expect(summary.html).toContain("⚠️");
    expect(summary.keyboard.flat().map((b) => b.callback_data)).toContain("L");
  });

  it("offers no 🔑 for a parser drift banner", () => {
    const drift = alert("sync:1:drift:abc:2026-10-15", "alert", {
      code: "sync.drift",
      params: { account: "Kid", rpcid: "abc", error: "x" },
    });
    const model = buildModel({
      report: report([drift]),
      alertAssignments: new Map(),
      assignments: new Map(),
      loc,
    });
    expect(
      summaryView(model, "Digest", loc)
        .keyboard.flat()
        .map((b) => b.callback_data),
    ).not.toContain("L");
  });
});
