import type { UnreadableCause } from "../store/types.ts";
import { plural } from "./plural.ts";
import type { Messages } from "./types.ts";

const LOCALE = "uk-UA";
const DAYS = { one: "день", few: "дні", many: "днів", other: "дня" };

function unreadable({ code, arg }: UnreadableCause): string {
  switch (code) {
    case "pdf_no_text":
      return "PDF без текстового шару (скановані сторінки?)";
    case "video":
      return "відео: потрібно переглянути";
    case "audio":
      return "аудіозапис: потрібно прослухати";
    case "form":
      return "Google Форма: відповідей не видно";
    case "link":
      return `зовнішнє посилання${arg ? ` (${arg})` : ""}: його вміст не завантажується`;
    case "legacy_ppt":
      return "старий формат PowerPoint (.ppt) не підтримується";
    case "legacy_doc":
      return "старий формат Word (.doc) не підтримується";
    case "legacy_xls":
      return "старий формат Excel (.xls) не підтримується";
    case "too_large":
      return `файл завеликий для завантаження (${arg} МБ)`;
    case "no_access":
      return `немає доступу до файлу (HTTP ${arg})`;
    case "extract_failed":
      return "файл не вдалося прочитати (пошкоджений або нестандартний)";
    case "not_drive":
      return "це не файл з Google Диска";
    case "download_failed":
      return `не вдалося завантажити (${arg})`;
    case "not_downloaded":
      return "файл ще не завантажено";
    case "copy_unreadable":
      return "завантажену копію не вдалося прочитати";
    case "image_format":
      return `формат зображення ${arg} не підтримується`;
    case "unsupported_format":
      return `непідтримуваний формат файлу${arg ? ` (${arg})` : ""}`;
  }
}

export const uk: Messages = {
  locale: LOCALE,
  quote: (t) => `«${t}»`,

  time: {
    inMinutes: (n) => `через ${n} хв`,
    inHours: (n) => `через ${n} год`,
    inDays: (n) => `через ${n} дн.`,
    minutesAgo: (n) => `${n} хв тому`,
    hoursAgo: (n) => `${n} год тому`,
    daysAgo: (n) => `${n} дн. тому`,
    today: "сьогодні",
    days: DAYS,
  },

  alert: {
    missing: (item) => `Прострочено: ${item} — термін здачі минув, роботу не здано.`,
    dueSoon: (item, due, rel) => `Термін — ${due} (${rel}): ${item} ще не здано.`,
    untouched: (item) => `Не розпочато: ${item} задали понад добу тому, а роботи досі немає.`,
    noDueDate: (item) => `Нагадування: ${item} без терміну здачі й досі не здано.`,
    teacherComment: (item, text) => `Коментар учителя до ${item}: ${text}`,
    redoDue: {
      past: "Після прохання вчителя роботу повторно не здали, а термін уже минув.",
      soon: "Після прохання вчителя роботу повторно не здали, а термін спливає протягом доби.",
    },
    checkNow: "Перевірте зараз",
    takeALook: "Варто переглянути",
    missingParts: (list) => `Бракує: ${list}.`,
    templateUnchanged: "здано шаблон без змін",
    heuristicBasis: {
      unreadable: "лише автоматичні ознаки, нічого не вдалося прочитати",
      fallback: "лише автоматичні ознаки, перевірка ШІ недоступна",
    },
    signal: {
      no_attachments: "нічого не прикріплено",
      fewer_attachments_than_expected: "прикріплено менше файлів, ніж очікувалося",
      template_unchanged: "здано шаблон без змін",
      empty_or_tiny_doc: "документ порожній або майже порожній",
    },
    notChecked: (list) => `Не перевірено автоматично: ${list}.`,
    checkByHand: (item, list) => `Перевірте самостійно: ${item}: ${list}`,
    llmFailed: (item, n, provider, error) =>
      `Автоматична перевірка не вдалася: ${item}, спроб: ${n} (${provider}: ${error}). Перевірте роботу самостійно.`,
    session: (account, state) =>
      `Синхронізацію для ${account} зупинено: ${
        state === "expired" ? "сесія Google закінчилася" : "вхід у Google не виконано"
      }. Увійдіть в обліковий запис вручну в профілі Chrome збирача.`,
    drift: (account, rpcid, error) =>
      `Classroom змінив формат даних (${rpcid}) під час синхронізації ${account}; потрібно оновити парсер (${error}).`,
    empty: "(порожньо)",
  },

  unreadable,

  report: {
    title: "Звіт Classroom",
    newAlerts: "нові сповіщення",
    since: (t) => `з ${t}`,
    everything: "усе",
    noAccounts: "У базі ще немає облікових записів під наглядом (спершу запустіть синхронізацію).",
    panics: "🔴 Терміново",
    alerts: "🟠 Увага",
    turnedIn: "📥 Здано",
    upcoming: (days) => `🟢 До відома: термін попереду (${days} ${plural(LOCALE, days, DAYS)})`,
    checkByHand: "🔍 Перевірте самостійно",
    debts: "📌 Хвости",
    info: "ℹ️  Нагадування",
    other: "Інше",
    nothing: "Нічого нового.",
    heuristicsOnly: "(лише автоматичні ознаки)",
    autoClosed: (n) => `✔️ Закрито автоматично: ${n}`,
    muted: {
      manual: "(переглянуто)",
      auto: "(закрито автоматично)",
      superseded: "(замінено новішою здачею)",
      no_work_expected: "(у дописі немає домашнього завдання)",
    },
    partsNotChecked: (n) =>
      `🔍 не перевірено автоматично: ${n} ${plural(LOCALE, n, { one: "частина", few: "частини", many: "частин", other: "частини" })}`,
    verdict: {
      ok: "✅ гаразд",
      warn: "🟠 варто переглянути",
      panic: "🔴 проблема",
      unchecked: "🔍 не перевірено автоматично",
      pending: "⏳ ще не перевірено",
    },
    debt: {
      redo: "🔁 просять переробити",
      missing: "⏰ не здано",
      unchecked: "🔍 перевірте самостійно",
    },
  },

  telegram: {
    urgent: "🚨 <b>Терміново</b>",
    digest: "📋 <b>Підсумок</b>",
    dailyDigest: "📋 <b>Підсумок дня</b>",
    status: "📊 <b>Стан</b>",
    other: "<b>Інше</b>",
    noAccounts: "Ще немає облікових записів під наглядом.",
    lastSync: (t) => `Остання синхронізація: ${t}`,
    never: "ще не було",
    syncStatus: {
      ok: "успішно",
      running: "триває",
      error: "помилка",
      session_expired: "сесія закінчилася",
      session_missing: "немає входу",
    },
    openCounts: (p, a, i, u) => `Відкриті: 🔴 ${p} · 🟠 ${a} · ℹ️ ${i} (не надіслано: ${u})`,
    debtCount: (n) => `📌 Хвости: ${n}`,
    upcomingCount: (n) => `🟢 Термін попереду: ${n}`,
    statusFooter: (time, days) =>
      `Підсумок дня о ${time}. Відкриті — ще не позначені переглянутими, за 7 днів; хвости забуваються через ${days} ${plural(LOCALE, days, DAYS)}, старіші завдання не показуються.`,
    nothingPending: "Нічого нового.",
    help: [
      "<b>classroom-advisor</b>",
      "/status – стан синхронізації й відкриті сповіщення по кожній дитині",
      "/digest – надіслати підсумок зараз",
      "/refresh – оновити зараз (синхронізація й перевірка) і надіслати свіжий підсумок сюди",
      "/recheck &lt;посилання на Classroom&gt; – перевірити завдання заново (або 🔄 у його картці)",
    ].join("\n"),
    test: "✅ Тестове повідомлення: Telegram працює.",
    commands: {
      status: "Стан і відкриті сповіщення по кожній дитині",
      digest: "Надіслати підсумок зараз",
      refresh: "Оновити зараз: синхронізація, перевірка, підсумок",
      recheck: "Перевірити завдання заново (номер або посилання)",
      help: "Довідка",
    },
    refreshing: "🔄 Оновлюю: синхронізація й перевірка. Підсумок надішлю сюди.",
    alreadyRunning: "⏳ Оновлення вже триває — підсумок надішлю, щойно воно завершиться.",
    cooldown: (left, every) =>
      `Зачекайте ще ${left} хв: ручне оновлення можна запускати раз на ${every} хв.`,
    freshDigest: "🔄 <b>Свіжий підсумок</b>",
    recheckQueued: (item) => `🔁 ${item}: перевіряю заново, результат напишу сюди.`,
    recheckUsage: "Не знайшов такого завдання. Надішліть посилання на завдання в Classroom.",
    recheckNotTurnedIn: (item) => `${item} ще не здано — перевіряти нічого.`,
    recheckDone: (item, verdict) => `🔁 Перевірено заново: ${item} — ${verdict}`,
    recheckFailed: (item) =>
      `Не вдалося перевірити ${item} заново (перевірка ШІ не спрацювала). Спробуйте пізніше.`,
    view: {
      tag: {
        dueSoon: "наближається термін",
        overdue: "термін минув",
        missing: "не здано",
        untouched: "не розпочато",
        noDueDate: "без терміну",
        comment: "коментар вчителя",
        redo: "потрібне доопрацювання",
        incomplete: "неповне завдання",
        checkByHand: "перевірити вручну",
        notChecked: "не перевірено",
        sync: "проблема синхронізації",
        other: "повідомлення",
      },
      dueShort: (d) => `до ${d}`,
      postedShort: (d) => `від ${d}`,
      dueFull: (t) => `термін ${t}`,
      postedFull: (d) => `задано ${d}`,
      open: (n) => `відкрито ${n}`,
      upcoming: (n) => `🟢 попереду ${n}`,
      otherKid: "Інше",
      page: (p, n) => `стор. ${p}/${n}`,
      seen: "✅ Переглянуто",
      newComment: "💬 <b>Коментар вчителя</b>",
      upcomingTitle: (days) => `🟢 <b>Попереду</b> (${days} ${plural(LOCALE, days, DAYS)})`,
      button: {
        classroom: "🔎 Classroom",
        seen: "✅ Переглянуто",
        recheck: "🔄 Перевірити ще",
        back: "⬅ Назад",
        refresh: "🔄 Оновити",
        upcoming: (n) => `🟢 Попереду (${n})`,
      },
      toast: {
        seen: "Позначено як переглянуте",
        seenKeepsDebt: "Позначено. Хвіст лишиться, доки роботу не здадуть.",
        stale: "Повідомлення застаріло: надішліть /digest по свіжий підсумок.",
        refreshing: "Оновлюю: синхронізація й перевірка. Це повідомлення оновиться.",
        alreadyRunning: "Оновлення вже триває — повідомлення оновиться, щойно воно завершиться.",
        cooldown: (left) => `Зачекайте ще ${left} хв до наступного оновлення.`,
        recheckQueued: "Перевіряю заново, результат напишу сюди.",
        notTurnedIn: "Ще не здано — перевіряти нічого.",
      },
    },
  },
};
