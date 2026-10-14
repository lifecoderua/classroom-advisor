import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pickChat } from "../../src/cli/telegram.ts";
import { formatAgo } from "../../src/i18n/index.ts";
import { buildReport } from "../../src/notify/console.ts";
import {
  chatsOf,
  escapeHtml,
  type FetchFn,
  parseCommand,
  splitMessage,
  TelegramApi,
  TelegramError,
  TelegramNotifier,
  type TgUpdate,
} from "../../src/notify/telegram.ts";
import { parseQuietHours } from "../../src/run/schedule.ts";
import {
  type Db,
  muteAlert,
  raiseAlert,
  upsertAccount,
  upsertAssignment,
  upsertComment,
  upsertCourse,
  upsertSubmission,
} from "../../src/store/index.ts";
import { migratedTemplate } from "../store/helpers.ts";

const TOKEN = "123456:TEST-token-value";
const CHAT = "4242";

interface Call {
  method: string;
  body: Record<string, unknown>;
}

/** Fake Bot API: records calls; `respond` returns the `result` (or throws a {code, desc}). */
function fakeFetch(
  respond: (method: string, body: Record<string, unknown>) => unknown = () => true,
) {
  const calls: Call[] = [];
  let messageId = 100;
  const fn: FetchFn = async (url, init) => {
    const method = url.split("/").pop() ?? "";
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ method, body });
    try {
      let result = respond(method, body);
      if (method === "sendMessage" && result === true) {
        const chat = { id: Number(body.chat_id), type: "private" };
        result = { message_id: ++messageId, date: 0, chat, text: body.text };
      }
      return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    } catch (err) {
      const e = err as { code?: number; desc?: string; retryAfter?: number };
      return new Response(
        JSON.stringify({
          ok: false,
          error_code: e.code ?? 400,
          description: e.desc ?? "Bad Request",
          ...(e.retryAfter !== undefined ? { parameters: { retry_after: e.retryAfter } } : {}),
        }),
        { status: e.code ?? 400 },
      );
    }
  };
  const sent = () => calls.filter((c) => c.method === "sendMessage");
  const edits = () => calls.filter((c) => c.method === "editMessageText");
  const toasts = () =>
    calls.filter((c) => c.method === "answerCallbackQuery").map((c) => c.body.text);
  return { fn, calls, sent, edits, toasts };
}

/** Button texts and callback data / urls of a sent or edited message. */
function buttons(body: Record<string, unknown> | undefined): string[] {
  const markup = body?.reply_markup as
    | { inline_keyboard: { text: string; callback_data?: string; url?: string }[][] }
    | undefined;
  return (markup?.inline_keyboard ?? []).flat().map((b) => `${b.text}=${b.callback_data ?? b.url}`);
}

/** A tap on a button of message `messageId` in `chat`. */
function tap(chat: string, messageId: number, data: string, id = 1): TgUpdate {
  return {
    update_id: id,
    callback_query: {
      id: `q${id}`,
      from: { id: 1, is_bot: false, first_name: "Parent" },
      message: { message_id: messageId, date: 0, chat: { id: Number(chat), type: "private" } },
      data,
    },
  };
}

describe("formatting helpers", () => {
  it("escapes HTML", () => {
    expect(escapeHtml(`a < b & "c" > d`)).toBe("a &lt; b &amp; &quot;c&quot; &gt; d");
  });

  it("splits on line boundaries under the limit", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i} ${"x".repeat(80)}`);
    const chunks = splitMessage(lines.join("\n"), 500);
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(500);
    expect(chunks.join("\n")).toBe(lines.join("\n"));
  });

  it("cuts a single over-long line as plain text without breaking an entity", () => {
    const line = `<b>t</b> ${"a".repeat(95)}&amp;${"b".repeat(50)}`;
    const [chunk] = splitMessage(line, 100);
    expect(chunk?.length).toBeLessThanOrEqual(100);
    expect(chunk).not.toContain("<b>");
    expect(chunk).not.toMatch(/&[a-z]*…$/);
  });

  it("parses commands", () => {
    expect(parseCommand("/status")).toEqual({ name: "status", args: [] });
    expect(parseCommand("/status@my_bot")).toEqual({ name: "status", args: [] });
    expect(parseCommand("/ack_12")).toEqual({ name: "ack", args: ["12"] });
    expect(parseCommand("/ack 3, 4")).toEqual({ name: "ack", args: ["3", "4"] });
    expect(parseCommand("hello")).toBeNull();
  });

  it("lists chats from updates and picks one", () => {
    const chat = (id: number) => ({ id, type: "private", first_name: `P${id}` });
    const updates: TgUpdate[] = [
      { update_id: 1, message: { message_id: 1, date: 0, chat: chat(1), text: "/start" } },
      { update_id: 2, message: { message_id: 2, date: 0, chat: chat(1), text: "hi" } },
      { update_id: 3, my_chat_member: { chat: chat(2) } },
    ];
    const chats = chatsOf(updates);
    expect(chats.map((c) => c.id)).toEqual([1, 2]);
    expect(() => pickChat(chats)).toThrow(/--chat/);
    expect(pickChat(chats, "2").id).toBe(2);
    expect(() => pickChat(chats, "3")).toThrow(/hasn't messaged/);
    expect(pickChat([chat(5)]).id).toBe(5);
  });

  it("formats ages", () => {
    expect(formatAgo(5 * 60_000, "en")).toBe("5m ago");
    expect(formatAgo(3 * 3_600_000, "en")).toBe("3h ago");
    expect(formatAgo(72 * 3_600_000, "en")).toBe("3d ago");
  });
});

describe("TelegramApi", () => {
  it("posts JSON to the method URL and returns the result", async () => {
    let seenUrl = "";
    const api = new TelegramApi(TOKEN, async (url) => {
      seenUrl = url;
      return new Response(JSON.stringify({ ok: true, result: { id: 1, username: "bot" } }));
    });
    expect(await api.getMe()).toMatchObject({ username: "bot" });
    expect(seenUrl).toBe(`https://api.telegram.org/bot${TOKEN}/getMe`);
  });

  it("never puts the token into error messages", async () => {
    const api = new TelegramApi(TOKEN, async (url) => {
      throw new Error(`connect failed for ${url}`);
    });
    const err = await api.getMe().catch((e: Error) => e);
    expect(err).toBeInstanceOf(TelegramError);
    expect((err as Error).message).not.toContain(TOKEN);
    expect((err as Error).message).toContain("<token>");
  });

  it("surfaces API errors and retries a 429 once", async () => {
    let n = 0;
    const f = fakeFetch(() => {
      if (n++ === 0) throw { code: 429, desc: "Too Many Requests", retryAfter: 0 };
      return true;
    });
    await new TelegramApi(TOKEN, f.fn).sendMessage(CHAT, "hi");
    expect(f.sent()).toHaveLength(2);
    expect(f.sent()[0]?.body).toMatchObject({ chat_id: CHAT, parse_mode: "HTML" });

    const bad = fakeFetch(() => {
      throw { code: 400, desc: "can't parse entities" };
    });
    await expect(new TelegramApi(TOKEN, bad.fn).sendMessage(CHAT, "<b>")).rejects.toThrow(
      /400 can't parse entities/,
    );
  });

  it("requires a token", () => {
    expect(() => new TelegramApi("")).toThrow(/TELEGRAM_BOT_TOKEN/);
  });
});

describe("TelegramNotifier", () => {
  let template: ReturnType<typeof migratedTemplate>;
  let db: Db;
  let dir: string;
  // UTC times: the digest schedule and quiet hours use the notifier's time zone (UTC here).
  let clock: Date;
  const at = (h: number, m = 0, day = 10) => new Date(Date.UTC(2026, 9, day, h, m));

  beforeAll(() => {
    template = migratedTemplate();
  }, 60_000);
  afterAll(() => template.cleanup());
  beforeEach(async () => {
    db = await template.fresh();
    dir = mkdtempSync(join(tmpdir(), "ca-tg-"));
    clock = at(12);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function seed() {
    const account = await upsertAccount(db, {
      email: "student-one@school.example",
      displayName: "Student <One>",
    });
    await db.account.update({ where: { id: account.id }, data: { watched: true } });
    const course = await upsertCourse(db, {
      accountId: account.id,
      classroomId: "111",
      name: "Math",
    });
    const { assignment } = await upsertAssignment(db, {
      accountId: account.id,
      courseId: course.id,
      classroomId: "222",
      kind: "assignment",
      title: "Fractions",
      status: "assigned",
      hash: "h",
      payload: {},
    });
    const item = { title: "Fractions", course: "Math" };
    const panic = await raiseAlert(
      db,
      {
        key: `deadline:${assignment.id}:due_soon`,
        level: "panic",
        code: "deadline.due_soon",
        params: { ...item, dueAt: at(15).toISOString() },
      },
      clock,
    );
    const alert = await raiseAlert(
      db,
      {
        key: `deadline:${assignment.id}:untouched_24h`,
        level: "alert",
        code: "deadline.untouched_24h",
        params: item,
      },
      clock,
    );
    const info = await raiseAlert(
      db,
      { key: "misc:1", level: "info", message: "something else" },
      clock,
    );
    return {
      account,
      assignmentId: assignment.id,
      panicId: panic.alert.id,
      alertId: alert.alert.id,
      infoId: info.alert.id,
    };
  }

  function notifier(
    f: ReturnType<typeof fakeFetch>,
    extra: Partial<ConstructorParameters<typeof TelegramNotifier>[0]> = {},
  ) {
    return new TelegramNotifier({
      db,
      api: new TelegramApi(TOKEN, f.fn),
      chatIds: [CHAT],
      digestTime: "19:00",
      statePath: join(dir, "telegram.json"),
      now: () => clock,
      log: () => undefined,
      timeZone: "UTC",
      lang: "en",
      ...extra,
    });
  }

  const sentAt = async (id: number) => (await db.alert.findUniqueOrThrow({ where: { id } })).sentAt;

  const say = (chat: string, text: string, id = 1): TgUpdate => ({
    update_id: id,
    message: { message_id: id, date: 0, chat: { id: Number(chat), type: "private" }, text },
  });
  const text = (c: { body: Record<string, unknown> } | undefined) => String(c?.body.text);

  it("sends a panic right away as a card of its assignment, the rest in the daily digest", async () => {
    const { panicId, alertId, infoId, assignmentId } = await seed();
    const f = fakeFetch();
    const n = notifier(f);

    await n.afterCycle();
    expect(f.sent()).toHaveLength(1);
    const card = text(f.sent()[0]);
    expect(card).toContain("🚨 <b>Urgent</b>");
    // base64("111") = MTEx, base64("222") = MjIy
    expect(card).toContain(
      '🔴 <b><a href="https://classroom.google.com/c/MTEx/a/MjIy/details?authuser=student-one%40school.example">Fractions</a></b>',
    );
    // Every open problem of the assignment, also the not-yet-sent one.
    expect(card).toContain("🔴 <b>due soon</b> — Sat 10 Oct, 15:00 (in 3h)");
    expect(card).toContain("🟠 <b>not started</b>");
    expect(buttons(f.sent()[0]?.body)).toEqual([
      expect.stringMatching(/^🔎 Classroom=https:/),
      `✅ Seen=S:a${assignmentId}`,
    ]);
    expect(await sentAt(panicId)).not.toBeNull();
    expect(await sentAt(alertId)).toBeNull();

    await n.afterCycle(); // nothing new before 19:00
    expect(f.sent()).toHaveLength(1);

    clock = at(19, 5);
    await n.afterCycle();
    expect(f.sent()).toHaveLength(2);
    const digest = text(f.sent()[1]);
    expect(digest).toContain("📋 <b>Daily digest</b> · Sat 10 Oct, 19:05");
    // The panic went out as a card already; the digest has what's new since.
    expect(digest).toContain("👤 <b>Student &lt;One&gt;</b> — open 1");
    expect(digest).toContain("👤 <b>Other</b> — open 1");
    expect(buttons(f.sent()[1]?.body)).toEqual([
      expect.stringMatching(/^👤 Student <One> \(1\)=l:\d+:0$/),
      "👤 Other (1)=l:0:0",
      "🔄 Refresh=f",
    ]);
    expect(await sentAt(alertId)).not.toBeNull();
    expect(await sentAt(infoId)).not.toBeNull();
    expect(JSON.parse(readFileSync(join(dir, "telegram.json"), "utf8"))).toMatchObject({
      lastDigestDay: "2026-10-10",
    });

    // Once per day, even when new alerts arrive later that evening.
    await raiseAlert(db, { key: "misc:2", level: "alert", message: "late one" }, clock);
    clock = at(21);
    await n.afterCycle();
    expect(f.sent()).toHaveLength(2);
    clock = at(19, 0, 11);
    await n.afterCycle();
    expect(f.sent()).toHaveLength(3);
  });

  it("navigates the digest in place: list, card, seen moves it to the end, back", async () => {
    const { account, assignmentId, panicId, alertId } = await seed();
    const course = await db.course.findFirstOrThrow();
    const { assignment: other } = await upsertAssignment(db, {
      accountId: account.id,
      courseId: course.id,
      classroomId: "333",
      kind: "assignment",
      title: "12.10 Geometry. Angles 12.10",
      status: "assigned",
      dueAt: at(18, 0, 9),
      hash: "g",
      payload: {},
    });
    await raiseAlert(
      db,
      {
        key: `deadline:${other.id}:missing`,
        level: "alert",
        code: "deadline.missing",
        params: { title: other.title, course: "Math" },
      },
      clock,
    );
    const f = fakeFetch();
    const n = notifier(f);
    await n.handleUpdate(say(CHAT, "/digest"));
    expect(f.sent()).toHaveLength(1);
    const digestId = 101;
    expect(text(f.sent()[0])).toContain("🔴 1 · open 2");

    await n.handleUpdate(tap(CHAT, digestId, `l:${account.id}:0`));
    expect(f.toasts()).toEqual([undefined]);
    expect(f.edits()[0]?.body).toMatchObject({ chat_id: CHAT, message_id: digestId });
    const list = text(f.edits()[0]);
    expect(list).toContain("👤 <b>Student &lt;One&gt;</b> · page 1/1");
    expect(list).toMatch(
      /1\. 🔴 <a href="[^"]*MjIy[^"]*">Fractions<\/a>\n {6}<i>due soon, not started<\/i>/,
    );
    expect(list).toContain(">Geometry. Angles</a>\n      <i>due 09/10 · not turned in</i>");
    expect(buttons(f.edits()[0]?.body)).toEqual([
      `1=c:${account.id}:0:a${assignmentId}`,
      `2=c:${account.id}:0:a${other.id}`,
      "⬅ Back=h",
    ]);

    await n.handleUpdate(tap(CHAT, digestId, `c:${account.id}:0:a${assignmentId}`));
    expect(text(f.edits()[1])).toContain("🔴 <b>due soon</b>");
    expect(buttons(f.edits()[1]?.body)).toEqual([
      expect.stringMatching(/^🔎 Classroom=https:/),
      `✅ Seen=s:${account.id}:0:a${assignmentId}`,
      `⬅ Back=l:${account.id}:0`,
    ]);

    // Seen: both alerts muted, a popup, straight back to the list with it last and crossed out.
    await n.handleUpdate(tap(CHAT, digestId, `s:${account.id}:0:a${assignmentId}`));
    expect(f.toasts().at(-1)).toBe("Marked as seen");
    expect((await db.alert.findUniqueOrThrow({ where: { id: panicId } })).mutedAt).not.toBeNull();
    expect((await db.alert.findUniqueOrThrow({ where: { id: alertId } })).mutedAt).not.toBeNull();
    const after = text(f.edits()[2]);
    expect(after).toMatch(/1\. 🟠 <a [^>]*>Geometry\. Angles<\/a>/);
    expect(after).toContain("2. ✅ <s>Fractions</s>");
    expect(buttons(f.edits()[2]?.body)[1]).toBe(`✅2=c:${account.id}:0:a${assignmentId}`);

    await n.handleUpdate(tap(CHAT, digestId, "h"));
    expect(text(f.edits()[3])).toContain("👤 <b>Student &lt;One&gt;</b> — open 1 · ✅ 1");
    expect(f.sent()).toHaveLength(1); // nothing was sent: the chat doesn't scroll

    // Unknown messages say they're out of date; other chats are ignored.
    await n.handleUpdate(tap(CHAT, 999, "h"));
    expect(f.toasts().at(-1)).toContain("out of date");
    await n.handleUpdate(tap("777", digestId, "h"));
    expect(f.edits()).toHaveLength(4);
  });

  it("pages long lists", async () => {
    const { account } = await seed();
    const course = await db.course.findFirstOrThrow();
    for (let i = 0; i < 6; i++) {
      const { assignment } = await upsertAssignment(db, {
        accountId: account.id,
        courseId: course.id,
        classroomId: `9${i}`,
        kind: "assignment",
        title: `Task ${i}`,
        status: "assigned",
        dueAt: at(10, 0, i + 1),
        hash: `t${i}`,
        payload: {},
      });
      await raiseAlert(
        db,
        {
          key: `deadline:${assignment.id}:missing`,
          level: "alert",
          code: "deadline.missing",
          params: { title: assignment.title, course: "Math" },
        },
        clock,
      );
    }
    const f = fakeFetch();
    const n = notifier(f);
    await n.handleUpdate(say(CHAT, "/digest"));
    await n.handleUpdate(tap(CHAT, 101, `l:${account.id}:1`));
    const page = text(f.edits()[0]);
    expect(page).toContain("page 2/2");
    expect(page).toContain("6. ");
    expect(page).toContain("7. ");
    expect(buttons(f.edits()[0]?.body)).toContain(`◀=l:${account.id}:0`);
    expect(buttons(f.edits()[0]?.body)).toContain("2/2=n");
  });

  it("keeps a missing debt after 'seen' until turned in, and counts it in /status", async () => {
    const { account } = await seed();
    await db.alert.updateMany({ data: { sentAt: clock, mutedAt: clock } }); // nothing pending
    const course = await db.course.findFirstOrThrow();
    const { assignment } = await upsertAssignment(db, {
      accountId: account.id,
      courseId: course.id,
      classroomId: "333",
      kind: "assignment",
      title: "Overdue <map>",
      status: "assigned",
      dueAt: at(18, 0, 7),
      hash: "o",
      payload: {},
    });
    const missing = await raiseAlert(
      db,
      {
        key: `deadline:${assignment.id}:missing`,
        level: "panic",
        code: "deadline.missing",
        params: { title: "Overdue <map>", course: "Math" },
      },
      at(18, 0, 7),
    );
    await db.alert.update({ where: { id: missing.alert.id }, data: { sentAt: at(18, 0, 7) } });
    const f = fakeFetch();
    const n = notifier(f);

    clock = at(19, 5);
    await n.afterCycle();
    expect(f.sent()).toHaveLength(1);
    expect(text(f.sent()[0])).toContain("👤 <b>Student &lt;One&gt;</b> — open 1");
    const digestId = 101;
    await n.handleUpdate(tap(CHAT, digestId, `c:${account.id}:0:a${assignment.id}`));
    const card = text(f.edits()[0]);
    expect(card).toContain("Overdue &lt;map&gt;");
    expect(card).toContain("🟠 <b>not turned in</b> — 3 days");

    await n.handleUpdate(msg("/status"));
    expect(text(f.sent()[1])).toContain("📌 Open debts: 1");

    await n.handleUpdate(tap(CHAT, digestId, `s:${account.id}:0:a${assignment.id}`));
    expect(f.toasts().at(-1)).toContain("debt stays");
    expect(text(f.edits()[1])).toContain("1. ✅ <s>Overdue &lt;map&gt;</s>");
    await n.handleUpdate(msg("/status"));
    expect(text(f.sent()[2])).toContain("📌 Open debts: 1");

    // Next day: still there, marked seen, a day older.
    clock = at(19, 5, 11);
    await n.afterCycle();
    expect(text(f.sent()[3])).toContain("— open 0 · ✅ 1");

    // Turned in: resolved.
    await upsertSubmission(db, {
      assignmentId: assignment.id,
      state: "turned_in",
      turnedInAt: clock,
      hash: "t",
      payload: {},
    });
    await n.handleUpdate(msg("/status"));
    expect(text(f.sent().at(-1))).toContain("📌 Open debts: 0");

    function msg(t: string) {
      return say(CHAT, t);
    }
  });

  it("sends a fresh teacher comment as a card, outside quiet hours only", async () => {
    const { assignmentId } = await seed();
    await db.alert.updateMany({ data: { sentAt: clock } });
    const { comment } = await upsertComment(db, {
      assignmentId,
      classroomId: "c1",
      authorRole: "teacher",
      text: "Add the <photo> please",
      postedAt: clock,
      baseline: false,
    });
    await raiseAlert(
      db,
      {
        key: `comment:${comment.id}`,
        level: "alert",
        code: "comment.teacher",
        params: { title: "Fractions", course: "Math", text: "Add the <photo> please" },
      },
      clock,
    );
    const f = fakeFetch();
    const n = notifier(f, { quietHours: parseQuietHours("22:00-07:00") });
    clock = at(23);
    await n.afterCycle();
    expect(f.sent()).toHaveLength(0);
    clock = at(7, 30, 11);
    await n.afterCycle();
    expect(f.sent()).toHaveLength(1);
    const card = text(f.sent()[0]);
    expect(card).toContain("💬 <b>Teacher comment</b>");
    expect(card).toContain(
      "🟠 <b>teacher comment</b>\n<blockquote expandable>Add the &lt;photo&gt; please</blockquote>",
    );

    // Seen on the card itself: edited in place, all marked.
    await n.handleUpdate(tap(CHAT, 101, `S:a${assignmentId}`));
    const seen = text(f.edits()[0]);
    expect(seen).toContain("✅ <b>teacher comment</b>");
    expect(seen).toContain("<i>✅ Seen</i>");
    expect(buttons(f.edits()[0]?.body)).toEqual([expect.stringMatching(/^🔎 Classroom=/)]);
  });

  it("sends in Ukrainian at the digest time of the configured zone", async () => {
    await seed();
    await raiseAlert(
      db,
      {
        key: "deadline:1:missing",
        level: "panic",
        code: "deadline.missing",
        params: { title: "Дроби", course: "Математика" },
      },
      clock,
    );
    const f = fakeFetch();
    const n = notifier(f, { lang: "uk", timeZone: "Europe/Kyiv" });
    await n.afterCycle();
    const urgent = text(f.sent()[0]);
    expect(urgent).toContain("🚨 <b>Терміново</b>");
    expect(urgent).toContain("<b>наближається термін</b> — сб, 10 жовт., 18:00 (через 3 год)");
    expect(urgent).toContain("<b>не розпочато</b>");
    expect(buttons(f.sent()[0]?.body)).toContain("✅ Переглянуто=S:a1");

    // 19:00 in Kyiv is 16:00 UTC.
    clock = at(15, 55);
    await n.afterCycle();
    expect(f.sent()).toHaveLength(1);
    clock = at(16, 5);
    await n.afterCycle();
    expect(f.sent()).toHaveLength(2);
    expect(text(f.sent()[1])).toContain("📋 <b>Підсумок дня</b>");
    expect(text(f.sent()[1])).toContain("відкрито 1");

    await n.handleUpdate(say(CHAT, "/status"));
    const status = text(f.sent()[2]);
    expect(status).toContain("Остання синхронізація: ще не було");
    expect(status).toContain("хвости забуваються через 14 днів");
    await n.handleUpdate(say(CHAT, "/help"));
    expect(text(f.sent()[3])).toContain("/recheck &lt;посилання на Classroom&gt;");
  });

  it("says how many alerts closed automatically since the last digest", async () => {
    const { alertId } = await seed();
    await db.alert.update({
      where: { id: alertId },
      data: { mutedAt: clock, muteReason: "auto", sentAt: clock },
    });
    const f = fakeFetch();
    const n = notifier(f);
    clock = at(19, 5);
    await n.afterCycle();
    const digest = text(f.sent().at(-1));
    expect(digest).toContain("✔️ Closed automatically: 1");
    // Counted once: the next digest starts from this one.
    clock = at(19, 5, 11);
    await n.handleUpdate(say(CHAT, "/digest"));
    expect(text(f.sent().at(-1))).toBe("Nothing pending.");
  });

  it("shows upcoming work (beyond a day, within the horizon) behind a button and in /status", async () => {
    const { account } = await seed();
    await db.alert.updateMany({ data: { sentAt: clock, mutedAt: clock } }); // nothing pending
    const course = await db.course.findFirstOrThrow();
    const add = async (classroomId: string, title: string, dueAt: Date, extra = {}) =>
      upsertAssignment(db, {
        accountId: account.id,
        courseId: course.id,
        classroomId,
        kind: "assignment",
        title,
        status: "assigned",
        dueAt,
        hash: title,
        payload: {},
        ...extra,
      });
    await add("301", "Poem", at(10, 0, 13));
    await add("302", "Old baseline", at(10, 0, 12), { baseline: true });
    await add("303", "Soon", at(20, 0, 10)); // within a day: its own panic
    await add("304", "Far", at(10, 0, 30)); // beyond 14 days
    await add("305", "Excused", at(10, 0, 13), { status: "excused" });
    const f = fakeFetch();
    const n = notifier(f, { lang: "uk" });
    clock = at(19, 5);
    await n.afterCycle();
    expect(text(f.sent()[0])).toContain("🟢 попереду 2");
    expect(buttons(f.sent()[0]?.body)).toContain("🟢 Попереду (2)=u");
    await n.handleUpdate(tap(CHAT, 101, "u"));
    const upcoming = text(f.edits()[0]);
    expect(upcoming).toContain("🟢 <b>Попереду</b> (14 днів)");
    expect(upcoming.indexOf("Old baseline")).toBeLessThan(upcoming.indexOf("Poem"));
    expect(upcoming).toContain("<i>термін пн, 12 жовт., 10:00 (через 39 год)</i>");
    expect(upcoming).not.toContain("Far");
    expect(upcoming).not.toContain("Excused");
    await n.handleUpdate(say(CHAT, "/status"));
    expect(text(f.sent()[1])).toContain("🟢 Термін попереду: 2");
  });

  describe("manual triggers (#54)", () => {
    const GROUP = "-1001234567890";

    it("registers the command menu for private chats and groups, and learns the bot name", async () => {
      const f = fakeFetch((method) =>
        method === "getMe" ? { id: 1, is_bot: true, first_name: "B", username: "class_bot" } : true,
      );
      const n = notifier(f);
      await n.setup();
      const set = f.calls.filter((c) => c.method === "setMyCommands");
      expect(set.map((c) => c.body.scope)).toEqual([
        { type: "default" },
        { type: "all_group_chats" },
      ]);
      const commands = (set[0]?.body.commands ?? []) as { command: string }[];
      expect(commands.map((c) => c.command)).toEqual([
        "status",
        "digest",
        "refresh",
        "recheck",
        "help",
      ]);
    });

    it("the 🔄 button queues a cycle and rewrites that digest with fresh data", async () => {
      await seed();
      const f = fakeFetch();
      const n = notifier(f);
      await n.handleUpdate(say(CHAT, "/digest"));
      await raiseAlert(db, { key: "misc:new", level: "alert", message: "new one" }, clock);
      await n.handleUpdate(tap(CHAT, 101, "f"));
      expect(f.toasts()).toEqual([expect.stringContaining("Refreshing")]);
      expect(n.manualPending()).toBe(true);
      n.startCycle();
      await n.afterCycle({ rechecked: [] });
      expect(f.sent()).toHaveLength(1);
      expect(f.edits()[0]?.body).toMatchObject({ chat_id: CHAT, message_id: 101 });
      expect(text(f.edits()[0])).toContain("🔄 <b>Fresh digest</b>");
      expect(text(f.edits()[0])).toContain("👤 <b>Other</b> — open 2");
      // Cooldown: a popup, nothing queued.
      clock = new Date(clock.getTime() + 60_000);
      await n.handleUpdate(tap(CHAT, 101, "f", 2));
      expect(f.toasts().at(-1)).toContain("wait 4 more min");
      expect(n.manualPending()).toBe(false);
    });

    it("the 🔄 Recheck button queues a recheck of turned-in work", async () => {
      const { assignmentId } = await seed();
      const f = fakeFetch();
      const n = notifier(f);
      await n.handleUpdate(say(CHAT, "/digest"));
      await n.handleUpdate(tap(CHAT, 101, `r:${assignmentId}`));
      expect(f.toasts().at(-1)).toContain("Not turned in yet");
      await upsertSubmission(db, {
        assignmentId,
        state: "turned_in",
        turnedInAt: clock,
        hash: "s",
        payload: {},
      });
      await n.handleUpdate(tap(CHAT, 101, `r:${assignmentId}`, 2));
      expect(f.toasts().at(-1)).toContain("Checking again");
      expect(n.startCycle()).toEqual([assignmentId]);
    });

    it("/refresh queues a cycle and sends a fresh digest to that chat only, even when empty", async () => {
      await seed();
      await db.alert.updateMany({ data: { sentAt: clock, mutedAt: clock } });
      const f = fakeFetch();
      const n = notifier(f, { chatIds: [CHAT, GROUP], botUsername: "class_bot" });
      expect(n.manualPending()).toBe(false);
      await n.handleUpdate(say(GROUP, "/refresh@class_bot"));
      expect(f.sent()[0]?.body).toMatchObject({
        chat_id: GROUP,
        text: expect.stringContaining("Refreshing"),
      });
      expect(n.manualPending()).toBe(true);
      // The loop's wait returns at once so the cycle runs now.
      await n.idle(600_000, new AbortController().signal);
      expect(f.calls.filter((c) => c.method === "getUpdates")).toHaveLength(0);

      expect(n.startCycle()).toEqual([]);
      expect(n.manualPending()).toBe(false);
      await n.afterCycle({ rechecked: [] });
      const fresh = f.sent().at(-1)?.body;
      expect(fresh?.chat_id).toBe(GROUP);
      expect(String(fresh?.text)).toContain("Fresh digest");
      expect(String(fresh?.text)).toContain("Nothing pending.");
      expect(f.sent().filter((c) => c.body.chat_id === CHAT)).toHaveLength(0);

      // Rate limit: one manual cycle per 5 minutes.
      clock = new Date(clock.getTime() + 60_000);
      await n.handleUpdate(say(CHAT, "/refresh"));
      expect(String(f.sent().at(-1)?.body.text)).toContain("wait 4 more min");
      clock = new Date(clock.getTime() + 5 * 60_000);
      await n.handleUpdate(say(CHAT, "/refresh"));
      expect(String(f.sent().at(-1)?.body.text)).toContain("Refreshing");
    });

    it("says 'already running' during a cycle and sends its digest when it ends", async () => {
      await seed();
      let release: () => void = () => undefined;
      let polls = 0;
      const f = fakeFetch((method) => {
        if (method !== "getUpdates") return true;
        // The first poll brings a /refresh while the cycle runs; the second ends the cycle.
        if (++polls === 1) return [say(CHAT, "/refresh", 5)];
        release();
        return [];
      });
      const n = notifier(f);
      const work = new Promise<string>((resolve) => {
        release = () => resolve("done");
      });
      expect(await n.during(work)).toBe("done");
      expect(String(f.sent()[0]?.body.text)).toContain("already running");
      await n.afterCycle();
      expect(String(f.sent().at(-1)?.body.text)).toContain("Fresh digest");
    });

    it("/recheck_<id>@bot or a link queues a recheck and answers with the new verdict", async () => {
      const { account } = await seed();
      const assignment = await db.assignment.findFirstOrThrow();
      await upsertSubmission(
        db,
        {
          assignmentId: assignment.id,
          state: "turned_in",
          turnedInAt: clock,
          hash: "s",
          payload: {},
        },
        clock,
      );
      const f = fakeFetch();
      const n = notifier(f, { chatIds: [CHAT, GROUP] });
      await n.handleUpdate(say(GROUP, `/recheck_${assignment.id}@class_bot`));
      expect(String(f.sent()[0]?.body.text)).toContain(
        "&quot;Fractions&quot; (Math): checking again",
      );
      const link = `https://classroom.google.com/c/MTEx/a/MjIy/details?authuser=${account.email}`;
      await n.handleUpdate(say(CHAT, `/recheck ${link}`));
      await n.handleUpdate(say(CHAT, "/recheck nonsense"));
      expect(String(f.sent()[2]?.body.text)).toContain("Couldn't find that assignment");
      expect(n.manualPending()).toBe(true);
      expect(n.startCycle()).toEqual([assignment.id]);
      await n.afterCycle({
        rechecked: [
          {
            assignmentId: assignment.id,
            title: "Fractions",
            course: "Math",
            status: "reviewed",
            verdict: "warn",
            content: {
              code: "quality.review",
              params: {
                title: "Fractions",
                course: "Math",
                verdict: "warn",
                summary: "Task 2 missing.",
              },
            },
          },
        ],
      });
      const answers = f.sent().filter((c) => String(c.body.text).includes("Checked again"));
      expect(answers.map((c) => c.body.chat_id).sort()).toEqual([CHAT, GROUP].sort());
      expect(String(answers[0]?.body.text)).toContain("🟠 warn");
      expect(String(answers[0]?.body.text)).toContain("Task 2 missing.");
    });
  });

  it("answers commands in a linked group, also with @bot", async () => {
    await seed();
    const GROUP = "-1001234567890";
    const f = fakeFetch();
    const n = notifier(f, { chatIds: [GROUP] });
    await n.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: Number(GROUP), type: "supergroup", title: "Family" },
        text: "/status@classroom_bot",
      },
    });
    expect(f.sent()[0]?.body.chat_id).toBe(GROUP);
    expect(String(f.sent()[0]?.body.text)).toContain("Status");
  });

  it("follows a group's upgrade to a supergroup and resends there", async () => {
    await seed();
    const OLD = "-4001";
    const NEW = "-1009999";
    const f = fakeFetch((method, body) => {
      if (method === "sendMessage" && body.chat_id === OLD) {
        throw { code: 400, desc: "Bad Request: group chat was upgraded to a supergroup chat" };
      }
      return true;
    });
    // The fake doesn't add `parameters.migrate_to_chat_id`; wrap it in.
    const fn: FetchFn = async (url, init) => {
      const res = await f.fn(url, init);
      const body = (await res.json()) as Record<string, unknown>;
      if (!body.ok) body.parameters = { migrate_to_chat_id: Number(NEW) };
      return new Response(JSON.stringify(body), { status: res.status });
    };
    const migrated: [string, string][] = [];
    const n = new TelegramNotifier({
      db,
      api: new TelegramApi(TOKEN, fn),
      chatIds: [OLD],
      digestTime: "19:00",
      statePath: join(dir, "telegram.json"),
      now: () => clock,
      log: () => undefined,
      timeZone: "UTC",
      lang: "en",
      onChatMigrated: (from, to) => migrated.push([from, to]),
    });
    expect(await n.sendCards()).toBe(1);
    expect(f.sent().map((c) => c.body.chat_id)).toEqual([OLD, NEW]);
    expect(migrated).toEqual([[OLD, NEW]]);
    expect(n.chats).toEqual([NEW]);
    expect(JSON.parse(readFileSync(join(dir, "telegram.json"), "utf8"))).toMatchObject({
      chatMigrations: { [OLD]: NEW },
    });
    // A restarted notifier with the old id from config goes straight to the new one, and
    // takes commands from it.
    const g = fakeFetch();
    const again = notifier(g, { chatIds: [OLD] });
    expect(again.chats).toEqual([NEW]);
    await again.handleUpdate({
      update_id: 2,
      message: {
        message_id: 2,
        date: 0,
        chat: { id: Number(NEW), type: "supergroup" },
        text: "/status",
      },
    });
    expect(g.sent()[0]?.body.chat_id).toBe(NEW);
  });

  it("switches on the 'migrated to supergroup' service message", async () => {
    const f = fakeFetch();
    const n = notifier(f, { chatIds: ["-4001"] });
    await n.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: -4001, type: "group" },
        migrate_to_chat_id: -1005555,
      },
    });
    expect(n.chats).toEqual(["-1005555"]);
  });

  it("holds the digest during quiet hours; panics still go out", async () => {
    await seed();
    const f = fakeFetch();
    const n = notifier(f, { quietHours: parseQuietHours("18:00-23:00") });
    clock = at(19, 30);
    await n.afterCycle();
    expect(f.sent()).toHaveLength(1);
    expect(String(f.sent()[0]?.body.text)).toContain("Urgent");
    expect(String(f.sent()[0]?.body.text)).not.toContain("Daily digest");
    clock = at(23, 10);
    await n.afterCycle();
    expect(f.sent()).toHaveLength(2);
  });

  it("keeps alerts unsent when sending fails", async () => {
    const { panicId } = await seed();
    const f = fakeFetch(() => {
      throw { code: 403, desc: "Forbidden: bot was blocked by the user" };
    });
    await notifier(f).afterCycle();
    expect(await sentAt(panicId)).toBeNull();
  });

  it("skips muted alerts and very old unsent ones", async () => {
    const { panicId } = await seed();
    await muteAlert(db, panicId, clock);
    await raiseAlert(db, { key: "misc:old", level: "panic", message: "old" }, at(12, 0, 1));
    const f = fakeFetch();
    await notifier(f).sendCards();
    expect(f.sent()).toHaveLength(0);
  });

  it("answers commands from allowed chats only", async () => {
    const { alertId } = await seed();
    const f = fakeFetch();
    const n = notifier(f);
    const msg = (chat: number, text: string, id = 1): TgUpdate => ({
      update_id: id,
      message: { message_id: id, date: 0, chat: { id: chat, type: "private" }, text },
    });

    await n.handleUpdate(msg(999, "/status"));
    await n.handleUpdate(msg(Number(CHAT), "just chatting"));
    expect(f.sent()).toHaveLength(0);

    await n.handleUpdate(msg(Number(CHAT), "/status"));
    const status = String(f.sent()[0]?.body.text);
    expect(f.sent()[0]?.body.chat_id).toBe(CHAT);
    expect(status).toContain("Student &lt;One&gt;");
    expect(status).toContain("Last sync: never");
    expect(status).toContain("🔴 1 · 🟠 1");

    await muteAlert(db, alertId, clock);
    await n.handleUpdate(msg(Number(CHAT), "/digest"));
    const digest = String(f.sent()[1]?.body.text);
    expect(digest).toContain("Digest");
    expect(digest).toContain("— 🔴 1 · open 1");
    await n.handleUpdate(msg(Number(CHAT), "/digest"));
    expect(String(f.sent()[2]?.body.text)).toBe("Nothing pending.");

    await n.handleUpdate(msg(Number(CHAT), "/start"));
    expect(String(f.sent()[3]?.body.text)).toContain("/recheck");
  });

  it("long-polls between cycles, stores the offset and stops at the deadline", async () => {
    await seed();
    let polls = 0;
    const f = fakeFetch((method, body) => {
      if (method !== "getUpdates") return true;
      polls++;
      clock = new Date(clock.getTime() + Number(body.timeout) * 1000);
      if (polls === 1) {
        return [
          {
            update_id: 7,
            message: {
              message_id: 1,
              date: 0,
              chat: { id: Number(CHAT), type: "private" },
              text: "/status",
            },
          },
        ];
      }
      return [];
    });
    const n = notifier(f, { pollTimeoutSec: 50 });
    await n.idle(120_000, new AbortController().signal);
    const gets = f.calls.filter((c) => c.method === "getUpdates");
    expect(gets.length).toBe(3); // 50s + 50s + 20s
    expect(gets[0]?.body).toMatchObject({
      timeout: 50,
      allowed_updates: ["message", "callback_query"],
    });
    expect(gets[0]?.body).not.toHaveProperty("offset");
    expect(gets[1]?.body).toMatchObject({ offset: 8 });
    expect(gets[2]?.body).toMatchObject({ timeout: 20 });
    expect(f.sent()).toHaveLength(1); // the /status reply
    expect(JSON.parse(readFileSync(join(dir, "telegram.json"), "utf8"))).toMatchObject({
      updateOffset: 8,
    });
    // A fresh notifier resumes from the stored offset.
    const again = fakeFetch((method) => {
      if (method === "getUpdates") clock = new Date(clock.getTime() + 60_000);
      return [];
    });
    await notifier(again).idle(30_000, new AbortController().signal);
    expect(again.calls[0]?.body).toMatchObject({ offset: 8 });
  });

  it("backs off after a polling error and returns when aborted", async () => {
    const controller = new AbortController();
    const f = fakeFetch(() => {
      throw { code: 409, desc: "Conflict: terminated by other getUpdates request" };
    });
    const sleeps: number[] = [];
    const logs: string[] = [];
    const n = notifier(f, {
      log: (l) => logs.push(l),
      sleep: async (ms) => {
        sleeps.push(ms);
        controller.abort();
      },
    });
    await n.idle(600_000, controller.signal);
    expect(sleeps).toEqual([30_000]);
    expect(logs.join("\n")).toContain("409");
    expect(logs.join("\n")).not.toContain(TOKEN);
  });
});

describe("console report and muted alerts", () => {
  let template: ReturnType<typeof migratedTemplate>;
  beforeAll(() => {
    template = migratedTemplate();
  }, 60_000);
  afterAll(() => template.cleanup());

  it("leaves muted alerts out of the default window but not out of --all", async () => {
    const db = await template.fresh();
    const now = new Date("2026-10-10T12:00:00Z");
    const { alert } = await raiseAlert(db, { key: "misc:1", level: "alert", message: "m" }, now);
    await muteAlert(db, alert.id, now);
    expect((await buildReport(db, { now })).other).toHaveLength(0);
    expect((await buildReport(db, { now, since: null })).other).toHaveLength(1);
  });
});
