import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  formatAge,
  formatAgo,
  formatIn,
  formatTime,
  LANGS,
  messages,
  renderAlert,
  zonedClock,
} from "../src/i18n/index.ts";
import { type AlertContent, UNREADABLE_CODES } from "../src/store/index.ts";

const T = new Date("2026-10-10T12:00:00Z");
const item = { title: "Дроби", course: "Математика" };

const SAMPLES: AlertContent[] = [
  { code: "text", params: { text: "free text" } },
  { code: "deadline.missing", params: item },
  { code: "deadline.due_soon", params: { ...item, dueAt: "2026-10-10T17:00:00Z" } },
  { code: "deadline.untouched_24h", params: item },
  { code: "deadline.no_due_date", params: item },
  { code: "comment.teacher", params: { ...item, text: "Переробіть", redoDue: "past" } },
  {
    code: "quality.review",
    params: {
      ...item,
      verdict: "panic",
      summary: "Завдання 3 не виконано.",
      missing: ["Вправа 3"],
      template: true,
      unchecked: [
        { what: '"song.mp3"', why: "audio recording: needs listening", cause: { code: "audio" } },
      ],
      redoDue: "soon",
    },
  },
  {
    code: "quality.review",
    params: {
      ...item,
      verdict: "warn",
      heuristic: { basis: "fallback", signals: ["no_attachments", "empty_or_tiny_doc"] },
    },
  },
  {
    code: "quality.unchecked",
    params: { ...item, items: [{ what: "Тест на Naurok", why: "результат лише на платформі" }] },
  },
  {
    code: "quality.llm_failed",
    params: { ...item, failures: 3, provider: "fake", error: "timeout" },
  },
  { code: "sync.session", params: { account: "student-one", state: "expired" } },
  { code: "sync.drift", params: { account: "student-one", rpcid: "pONvgf", error: "x" } },
];

describe("renderAlert", () => {
  it.each(LANGS)("renders every alert code in %s", (lang) => {
    for (const c of SAMPLES) {
      const text = renderAlert(c, T, { lang, timeZone: "Europe/Kyiv" });
      expect(text.length).toBeGreaterThan(5);
      expect(text).not.toMatch(/undefined|\[object/);
    }
  });

  it("renders natural Ukrainian, Russian and English", () => {
    const due = SAMPLES[2] as AlertContent;
    const kyiv = (lang: "uk" | "ru" | "en") => ({ lang, timeZone: "Europe/Kyiv" });
    expect(renderAlert(due, T, kyiv("uk"))).toBe(
      "Термін — сб, 10 жовт., 20:00 (через 5 год): «Дроби» (Математика) ще не здано.",
    );
    expect(renderAlert(due, T, kyiv("ru"))).toBe(
      "Срок — сб, 10 окт., 20:00 (через 5 ч): «Дроби» (Математика) ещё не сдано.",
    );
    expect(renderAlert(due, T, kyiv("en"))).toBe(
      'Due Sat 10 Oct, 20:00 (in 5h): "Дроби" (Математика) is not turned in yet.',
    );
    expect(renderAlert(SAMPLES[6] as AlertContent, T, kyiv("uk"))).toBe(
      "Перевірте зараз: «Дроби» (Математика): Завдання 3 не виконано. Бракує: Вправа 3. " +
        '(здано шаблон без змін) Не перевірено автоматично: "song.mp3": аудіозапис: потрібно ' +
        "прослухати. Після прохання вчителя роботу повторно не здали, а термін спливає протягом доби.",
    );
    expect(renderAlert(SAMPLES[7] as AlertContent, T, kyiv("ru"))).toBe(
      "Стоит посмотреть: «Дроби» (Математика): ничего не прикреплено; документ пустой или почти " +
        "пустой [только автоматические признаки, проверка ИИ недоступна]",
    );
    expect(renderAlert(SAMPLES[5] as AlertContent, T, kyiv("uk"))).toBe(
      "Коментар учителя до «Дроби» (Математика): Переробіть Після прохання вчителя роботу " +
        "повторно не здали, а термін уже минув.",
    );
  });

  it("has a text for every unreadable cause in every language", () => {
    for (const lang of LANGS) {
      for (const code of UNREADABLE_CODES) {
        const text = messages(lang).unreadable({ code, arg: ".x" });
        expect(text.length).toBeGreaterThan(3);
      }
    }
    expect(messages("uk").unreadable({ code: "too_large", arg: "30" })).toBe(
      "файл завеликий для завантаження (30 МБ)",
    );
  });
});

describe("time and plurals", () => {
  it("formats times in the configured zone and language", () => {
    expect(formatTime(T, { lang: "uk", timeZone: "Europe/Kyiv" })).toBe("сб, 10 жовт., 15:00");
    expect(formatTime(T, { lang: "ru", timeZone: "Europe/Kyiv" })).toBe("сб, 10 окт., 15:00");
    expect(formatTime(T, { lang: "en", timeZone: "UTC" })).toBe("Sat 10 Oct, 12:00");
  });

  it("uses uk/ru plural forms for ages", () => {
    expect([0, 1, 2, 5, 11, 21, 22].map((d) => formatAge(d, "uk"))).toEqual([
      "сьогодні",
      "1 день",
      "2 дні",
      "5 днів",
      "11 днів",
      "21 день",
      "22 дні",
    ]);
    expect([1, 3, 5].map((d) => formatAge(d, "ru"))).toEqual(["1 день", "3 дня", "5 дней"]);
    expect([1, 3].map((d) => formatAge(d, "en"))).toEqual(["1 day", "3 days"]);
    expect(formatIn(45 * 60_000, "uk")).toBe("через 45 хв");
    expect(formatAgo(72 * 3_600_000, "ru")).toBe("3 дн. назад");
  });

  it("reads the clock and the day in a zone", () => {
    // 21:30 UTC is already the next day in Kyiv (UTC+3 in October).
    const late = new Date("2026-10-10T21:30:00Z");
    expect(zonedClock(late, "Europe/Kyiv")).toEqual({ minutes: 30, day: "2026-10-11" });
    expect(zonedClock(late, "UTC")).toEqual({ minutes: 21 * 60 + 30, day: "2026-10-10" });
  });
});

describe("alert_content migration", () => {
  it("turns stored English messages into `text` alerts", () => {
    const dir = resolve(import.meta.dirname, "../prisma/migrations");
    const names = readdirSync(dir)
      .filter((n) => /^\d+_/.test(n))
      .sort();
    const db = new DatabaseSync(":memory:");
    for (const name of names) {
      if (name.endsWith("_alert_content")) {
        db.prepare(
          `INSERT INTO "Alert" ("key", "level", "message", "createdAt") VALUES ('k', 'alert', 'Old "text"', 0)`,
        ).run();
      }
      db.exec(readFileSync(join(dir, name, "migration.sql"), "utf8"));
    }
    const row = db.prepare(`SELECT "code", "params" FROM "Alert"`).get() as {
      code: string;
      params: string;
    };
    expect(row.code).toBe("text");
    expect(JSON.parse(row.params)).toEqual({ text: 'Old "text"' });
    db.close();
  });
});
