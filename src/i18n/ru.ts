import type { UnreadableCause } from "../store/types.ts";
import { plural } from "./plural.ts";
import type { Messages } from "./types.ts";

const LOCALE = "ru-RU";
const DAYS = { one: "день", few: "дня", many: "дней", other: "дня" };

function unreadable({ code, arg }: UnreadableCause): string {
  switch (code) {
    case "pdf_no_text":
      return "PDF без текстового слоя (отсканированные страницы?)";
    case "video":
      return "видео: нужно посмотреть";
    case "audio":
      return "аудиозапись: нужно прослушать";
    case "form":
      return "Google Форма: ответов не видно";
    case "link":
      return `внешняя ссылка${arg ? ` (${arg})` : ""}: её содержимое не загружается`;
    case "legacy_ppt":
      return "старый формат PowerPoint (.ppt) не поддерживается";
    case "legacy_doc":
      return "старый формат Word (.doc) не поддерживается";
    case "legacy_xls":
      return "старый формат Excel (.xls) не поддерживается";
    case "too_large":
      return `файл слишком большой для загрузки (${arg} МБ)`;
    case "no_access":
      return `нет доступа к файлу (HTTP ${arg})`;
    case "extract_failed":
      return "файл не удалось прочитать (повреждён или нестандартный)";
    case "not_drive":
      return "это не файл с Google Диска";
    case "download_failed":
      return `не удалось загрузить (${arg})`;
    case "not_downloaded":
      return "файл ещё не загружен";
    case "copy_unreadable":
      return "загруженную копию не удалось прочитать";
    case "image_format":
      return `формат изображения ${arg} не поддерживается`;
    case "unsupported_format":
      return `неподдерживаемый формат файла${arg ? ` (${arg})` : ""}`;
  }
}

export const ru: Messages = {
  locale: LOCALE,
  quote: (t) => `«${t}»`,

  time: {
    inMinutes: (n) => `через ${n} мин`,
    inHours: (n) => `через ${n} ч`,
    inDays: (n) => `через ${n} дн.`,
    minutesAgo: (n) => `${n} мин назад`,
    hoursAgo: (n) => `${n} ч назад`,
    daysAgo: (n) => `${n} дн. назад`,
    today: "сегодня",
    days: DAYS,
  },

  alert: {
    missing: (item) => `Просрочено: ${item} — срок сдачи прошёл, работа не сдана.`,
    dueSoon: (item, due, rel) => `Срок — ${due} (${rel}): ${item} ещё не сдано.`,
    untouched: (item) => `Не начато: ${item} задали больше суток назад, а работы до сих пор нет.`,
    noDueDate: (item) => `Напоминание: ${item} без срока сдачи и до сих пор не сдано.`,
    teacherComment: (item, text) => `Комментарий учителя к ${item}: ${text}`,
    redoDue: {
      past: "После просьбы учителя работу повторно не сдали, а срок уже прошёл.",
      soon: "После просьбы учителя работу повторно не сдали, а срок истекает в течение суток.",
    },
    checkNow: "Проверьте сейчас",
    takeALook: "Стоит посмотреть",
    missingParts: (list) => `Не хватает: ${list}.`,
    templateUnchanged: "сдан шаблон без изменений",
    heuristicBasis: {
      unreadable: "только автоматические признаки, ничего не удалось прочитать",
      fallback: "только автоматические признаки, проверка ИИ недоступна",
    },
    signal: {
      no_attachments: "ничего не прикреплено",
      fewer_attachments_than_expected: "прикреплено меньше файлов, чем ожидалось",
      template_unchanged: "сдан шаблон без изменений",
      empty_or_tiny_doc: "документ пустой или почти пустой",
    },
    notChecked: (list) => `Не проверено автоматически: ${list}.`,
    checkByHand: (item, list) => `Проверьте сами: ${item}: ${list}`,
    llmFailed: (item, n, provider, error) =>
      `Автоматическая проверка не удалась: ${item}, попыток: ${n} (${provider}: ${error}). Проверьте работу сами.`,
    session: (account, state) =>
      `Синхронизация для ${account} остановлена: ${
        state === "expired" ? "сессия Google истекла" : "вход в Google не выполнен"
      }. Войдите в аккаунт вручную в профиле Chrome сборщика.`,
    drift: (account, rpcid, error) =>
      `Classroom изменил формат данных (${rpcid}) при синхронизации ${account}; нужно обновить парсер (${error}).`,
    empty: "(пусто)",
  },

  unreadable,

  report: {
    title: "Отчёт Classroom",
    newAlerts: "новые уведомления",
    since: (t) => `с ${t}`,
    everything: "всё",
    noAccounts: "В базе ещё нет отслеживаемых аккаунтов (сначала запустите синхронизацию).",
    panics: "🔴 Срочно",
    alerts: "🟠 Внимание",
    turnedIn: "📥 Сдано",
    upcoming: (days) => `🟢 К сведению: срок впереди (${days} ${plural(LOCALE, days, DAYS)})`,
    checkByHand: "🔍 Проверьте сами",
    debts: "📌 Хвосты",
    info: "ℹ️  Напоминания",
    other: "Другое",
    nothing: "Ничего нового.",
    heuristicsOnly: "(только автоматические признаки)",
    autoClosed: (n) => `✔️ Закрыто автоматически: ${n}`,
    muted: {
      manual: "(просмотрено)",
      auto: "(закрыто автоматически)",
      superseded: "(заменено более новой сдачей)",
    },
    partsNotChecked: (n) =>
      `🔍 не проверено автоматически: ${n} ${plural(LOCALE, n, { one: "часть", few: "части", many: "частей", other: "части" })}`,
    verdict: {
      ok: "✅ в порядке",
      warn: "🟠 стоит посмотреть",
      panic: "🔴 проблема",
      unchecked: "🔍 не проверено автоматически",
      pending: "⏳ ещё не проверено",
    },
    debt: {
      redo: "🔁 просят переделать",
      missing: "⏰ не сдано",
      unchecked: "🔍 проверьте сами",
    },
  },

  telegram: {
    urgent: "🚨 <b>Срочно</b>",
    digest: "📋 <b>Сводка</b>",
    dailyDigest: "📋 <b>Сводка дня</b>",
    status: "📊 <b>Состояние</b>",
    open: "открыть",
    checkByHand: "🔍 <i>Проверьте сами</i>",
    debts: "📌 <i>Хвосты</i>",
    other: "<b>Другое</b>",
    noAccounts: "Отслеживаемых аккаунтов пока нет.",
    lastSync: (t) => `Последняя синхронизация: ${t}`,
    never: "ещё не было",
    syncStatus: {
      ok: "успешно",
      running: "идёт",
      error: "ошибка",
      session_expired: "сессия истекла",
      session_missing: "нет входа",
    },
    openCounts: (p, a, i, u) => `Открытые: 🔴 ${p} · 🟠 ${a} · ℹ️ ${i} (не отправлено: ${u})`,
    debtCount: (n) => `📌 Хвосты: ${n}`,
    upcoming: (days) =>
      `🟢 <i>К сведению: срок впереди (${days} ${plural(LOCALE, days, DAYS)})</i>`,
    upcomingCount: (n) => `🟢 Срок впереди: ${n}`,
    statusFooter: (time, days) =>
      `Сводка дня в ${time}. Открытые — ещё не отмеченные через /ack, за 7 дней; хвосты забываются через ${days} ${plural(LOCALE, days, DAYS)}.`,
    nothingPending: "Ничего нового.",
    acked: (id) => `🔕 #${id} отмечено как просмотренное`,
    noAlert: (id) => `Уведомление #${id} не найдено`,
    ackUsage: "Использование: /ack &lt;id&gt; (число после /ack_ в сообщении)",
    help: [
      "<b>classroom-advisor</b>",
      "/status – состояние синхронизации и открытые уведомления по каждому ребёнку",
      "/digest – отправить сводку сейчас",
      "/ack &lt;id&gt; – отметить уведомление просмотренным (или нажмите /ack_&lt;id&gt; под ним)",
    ].join("\n"),
    test: "✅ Тестовое сообщение: Telegram работает.",
  },
};
