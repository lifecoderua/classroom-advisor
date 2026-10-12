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
  const fn: FetchFn = async (url, init) => {
    const method = url.split("/").pop() ?? "";
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ method, body });
    try {
      const result = respond(method, body);
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
  return { fn, calls, sent };
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
    const panic = await raiseAlert(
      db,
      {
        key: `deadline:${assignment.id}:due_soon`,
        level: "panic",
        message: `"Fractions & <decimals>" is due in 3h`,
      },
      clock,
    );
    const alert = await raiseAlert(
      db,
      { key: `deadline:${assignment.id}:untouched_24h`, level: "alert", message: "untouched" },
      clock,
    );
    const info = await raiseAlert(
      db,
      { key: "misc:1", level: "info", message: "something else" },
      clock,
    );
    return {
      account,
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

  it("sends panics right away with escaped text and an authuser link, the rest in the digest", async () => {
    const { panicId, alertId, infoId } = await seed();
    const f = fakeFetch();
    const n = notifier(f);

    await n.afterCycle();
    expect(f.sent()).toHaveLength(1);
    const text = String(f.sent()[0]?.body.text);
    expect(text).toContain("Urgent");
    expect(text).toContain("<b>Student &lt;One&gt;</b>");
    expect(text).toContain("&quot;Fractions &amp; &lt;decimals&gt;&quot;");
    // base64("111") = MTEx, base64("222") = MjIy
    expect(text).toContain(
      '<a href="https://classroom.google.com/c/MTEx/a/MjIy/details?authuser=student-one%40school.example">open</a>',
    );
    expect(text).toContain(`/ack_${panicId}`);
    expect(text).not.toContain("untouched");
    expect(await sentAt(panicId)).not.toBeNull();
    expect(await sentAt(alertId)).toBeNull();

    await n.afterCycle(); // nothing new before 19:00
    expect(f.sent()).toHaveLength(1);

    clock = at(19, 5);
    await n.afterCycle();
    expect(f.sent()).toHaveLength(2);
    const digest = String(f.sent()[1]?.body.text);
    expect(digest).toContain("Daily digest");
    expect(digest).toContain("untouched");
    expect(digest).toContain("<b>Other</b>");
    expect(digest).toContain("something else");
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

  it("puts 'check by hand' items in their own digest block, never right away; muted ones out", async () => {
    await seed();
    const assignment = await db.assignment.findFirstOrThrow();
    const { version } = await upsertSubmission(
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
    if (!version) throw new Error("seed failed");
    const byHand = await raiseAlert(
      db,
      {
        key: `quality:${version.id}:unchecked`,
        level: "info",
        message: 'Check by hand: "Fractions" (Math): "song.mp3": audio recording: needs listening',
      },
      clock,
    );
    const muted = await raiseAlert(
      db,
      { key: `quality:${version.id}:c9:unchecked`, level: "info", message: "Check by hand: muted" },
      clock,
    );
    await muteAlert(db, muted.alert.id, clock);
    const f = fakeFetch();
    const n = notifier(f);

    await n.afterCycle();
    expect(f.sent()).toHaveLength(1);
    expect(String(f.sent()[0]?.body.text)).not.toContain("Check by hand");
    expect(await sentAt(byHand.alert.id)).toBeNull();

    clock = at(19, 5);
    await n.afterCycle();
    const digest = String(f.sent()[1]?.body.text);
    expect(digest).toContain(
      "🔍 <i>Check by hand</i>\n🔍 Check by hand: &quot;Fractions&quot; (Math): &quot;song.mp3&quot;",
    );
    expect(digest.indexOf("untouched")).toBeLessThan(digest.indexOf("🔍 <i>Check by hand</i>"));
    expect(digest).not.toContain("muted");
    expect(await sentAt(byHand.alert.id)).not.toBeNull();
  });

  it("repeats open debts in every digest until acked, and counts them in /status", async () => {
    const { account } = await seed();
    await muteAlert(db, (await db.alert.findFirstOrThrow({ where: { level: "alert" } })).id, clock);
    await db.alert.updateMany({ data: { sentAt: clock } }); // nothing new pending
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
      { key: `deadline:${assignment.id}:missing`, level: "panic", message: "missing" },
      at(18, 0, 7),
    );
    await db.alert.update({ where: { id: missing.alert.id }, data: { sentAt: at(18, 0, 7) } });
    const f = fakeFetch();
    const n = notifier(f);

    clock = at(19, 5);
    await n.afterCycle();
    expect(f.sent()).toHaveLength(1);
    const digest = String(f.sent()[0]?.body.text);
    expect(digest).toContain("Daily digest");
    expect(digest).toContain(
      `📌 <i>Open debts</i>\n⏰ not turned in: &quot;Overdue &lt;map&gt;&quot; (Math) · 3 days · <a href="https://classroom.google.com/c/MTEx/a/MzMz/details?authuser=student-one%40school.example">open</a> · /ack_${missing.alert.id}`,
    );

    // Next day: repeated, a day older.
    clock = at(19, 5, 11);
    await n.afterCycle();
    expect(f.sent()).toHaveLength(2);
    expect(String(f.sent()[1]?.body.text)).toContain("· 4 days ·");

    const msg = (text: string): TgUpdate => ({
      update_id: 1,
      message: { message_id: 1, date: 0, chat: { id: Number(CHAT), type: "private" }, text },
    });
    await n.handleUpdate(msg("/status"));
    expect(String(f.sent()[2]?.body.text)).toContain("📌 Open debts: 1");

    // Acked: gone from the digest and /status.
    await n.handleUpdate(msg(`/ack_${missing.alert.id}`));
    await n.handleUpdate(msg("/digest"));
    expect(String(f.sent()[4]?.body.text)).toBe("Nothing pending.");
    await n.handleUpdate(msg("/status"));
    expect(String(f.sent()[5]?.body.text)).toContain("📌 Open debts: 0");
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
    const urgent = String(f.sent()[0]?.body.text);
    expect(urgent).toContain("🚨 <b>Терміново</b> · сб, 10 жовт., 15:00");
    expect(urgent).toContain("Прострочено: «Дроби» (Математика)");
    expect(urgent).toContain(">відкрити</a>");

    // 19:00 in Kyiv is 16:00 UTC.
    clock = at(15, 55);
    await n.afterCycle();
    expect(f.sent()).toHaveLength(1);
    clock = at(16, 5);
    await n.afterCycle();
    expect(f.sent()).toHaveLength(2);
    expect(String(f.sent()[1]?.body.text)).toContain("📋 <b>Підсумок дня</b>");

    const msg = (text: string): TgUpdate => ({
      update_id: 1,
      message: { message_id: 1, date: 0, chat: { id: Number(CHAT), type: "private" }, text },
    });
    await n.handleUpdate(msg("/status"));
    const status = String(f.sent()[2]?.body.text);
    expect(status).toContain("Остання синхронізація: ще не було");
    expect(status).toContain("хвости забуваються через 14 днів");
    await n.handleUpdate(msg("/help"));
    expect(String(f.sent()[3]?.body.text)).toContain("позначити сповіщення переглянутим");
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
    const digest = String(f.sent().at(-1)?.body.text);
    expect(digest).toContain("✔️ Closed automatically: 1");
    // Counted once: the next digest starts from this one.
    clock = at(19, 5, 11);
    await n.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: Number(CHAT), type: "private" },
        text: "/digest",
      },
    });
    expect(String(f.sent().at(-1)?.body.text)).toBe("Nothing pending.");
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
    expect(await n.sendPanics()).toBe(1);
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
    await notifier(f).sendPanics();
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

    await n.handleUpdate(msg(Number(CHAT), `/ack_${alertId}`));
    expect(String(f.sent()[1]?.body.text)).toContain(`Muted #${alertId}`);
    const muted = await db.alert.findUniqueOrThrow({ where: { id: alertId } });
    expect(muted.mutedAt).not.toBeNull();
    expect(muted.sentAt).not.toBeNull();
    await n.handleUpdate(msg(Number(CHAT), "/ack 99999"));
    expect(String(f.sent()[2]?.body.text)).toContain("No alert #99999");

    await n.handleUpdate(msg(Number(CHAT), "/digest"));
    const digest = String(f.sent()[3]?.body.text);
    expect(digest).toContain("Digest");
    expect(digest).not.toContain("untouched"); // muted
    await n.handleUpdate(msg(Number(CHAT), "/digest"));
    expect(String(f.sent()[4]?.body.text)).toBe("Nothing pending.");

    await n.handleUpdate(msg(Number(CHAT), "/start"));
    expect(String(f.sent()[5]?.body.text)).toContain("/ack");
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
    expect(gets[0]?.body).toMatchObject({ timeout: 50, allowed_updates: ["message"] });
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
