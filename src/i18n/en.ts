import type { UnreadableCause } from "../store/types.ts";
import type { Messages } from "./types.ts";

function unreadable({ code, arg }: UnreadableCause): string {
  switch (code) {
    case "pdf_no_text":
      return "PDF without a text layer (scanned pages?)";
    case "video":
      return "video: needs watching";
    case "audio":
      return "audio recording: needs listening";
    case "form":
      return "Google Form: the answers can't be read";
    case "link":
      return `external link${arg ? ` (${arg})` : ""}: its content isn't downloaded`;
    case "legacy_ppt":
      return "old PowerPoint format (.ppt) isn't supported";
    case "legacy_doc":
      return "old Word format (.doc) isn't supported";
    case "legacy_xls":
      return "old Excel format (.xls) isn't supported";
    case "too_large":
      return `file too large to download (${arg} MB)`;
    case "no_access":
      return `no access to the file (HTTP ${arg})`;
    case "extract_failed":
      return "the file couldn't be read (damaged or unusual)";
    case "not_drive":
      return "not a Drive file";
    case "download_failed":
      return `download failed (${arg})`;
    case "not_downloaded":
      return "the file hasn't been downloaded";
    case "copy_unreadable":
      return "the downloaded copy couldn't be read";
    case "image_format":
      return `image format ${arg} isn't supported`;
    case "unsupported_format":
      return `unsupported file format${arg ? ` (${arg})` : ""}`;
  }
}

export const en: Messages = {
  locale: "en-GB",
  quote: (t) => `"${t}"`,

  time: {
    inMinutes: (n) => `in ${n}m`,
    inHours: (n) => `in ${n}h`,
    inDays: (n) => `in ${n}d`,
    minutesAgo: (n) => `${n}m ago`,
    hoursAgo: (n) => `${n}h ago`,
    daysAgo: (n) => `${n}d ago`,
    today: "today",
    days: { one: "day", other: "days" },
  },

  alert: {
    missing: (item) => `Missing: ${item} is past due and not turned in.`,
    dueSoon: (item, due, rel) => `Due ${due} (${rel}): ${item} is not turned in yet.`,
    untouched: (item) => `Not started: ${item} was posted over a day ago and has no work yet.`,
    noDueDate: (item) => `Reminder: ${item} has no due date and is not turned in.`,
    teacherComment: (item, text) => `Teacher comment on ${item}: ${text}`,
    redoDue: {
      past: "Not turned in again since the teacher's request, and it is past due.",
      soon: "Not turned in again since the teacher's request, and it is due within a day.",
    },
    checkNow: "Check now",
    takeALook: "Take a look",
    missingParts: (list) => `Missing: ${list}.`,
    templateUnchanged: "turned in the template without changes",
    heuristicBasis: {
      unreadable: "heuristics only, nothing readable",
      fallback: "heuristics only, LLM review unavailable",
    },
    signal: {
      no_attachments: "nothing attached",
      fewer_attachments_than_expected: "fewer files than expected",
      template_unchanged: "a template turned in unchanged",
      empty_or_tiny_doc: "an empty or almost empty document",
    },
    notChecked: (list) => `Not checked automatically: ${list}.`,
    checkByHand: (item, list) => `Check by hand: ${item}: ${list}`,
    llmFailed: (item, n, provider, error) =>
      `Automatic review couldn't run: ${item} failed ${n} times (${provider}: ${error}). Check the work by hand.`,
    session: (account, state) =>
      `Sync stopped for ${account}: the Google session is ${state}. Log in by hand in the collector profile.`,
    drift: (account, rpcid, error) =>
      `Classroom data changed shape (${rpcid}) while syncing ${account}; the parser needs an update (${error}).`,
    empty: "(empty)",
  },

  unreadable,

  report: {
    title: "Classroom report",
    newAlerts: "new alerts",
    since: (t) => `since ${t}`,
    everything: "everything",
    noAccounts: "No watched accounts in the database yet (run a sync first).",
    panics: "🔴 Panics",
    alerts: "🟠 Alerts",
    turnedIn: "📥 Turned in",
    upcoming: (days) => `🟢 Coming up (next ${days} days)`,
    checkByHand: "🔍 Check by hand",
    debts: "📌 Open debts",
    info: "ℹ️  Info",
    other: "Other",
    nothing: "Nothing to report.",
    heuristicsOnly: "(heuristics only)",
    partsNotChecked: (n) => `🔍 ${n} part${n === 1 ? "" : "s"} not checked automatically`,
    autoClosed: (n) => `✔️ Closed automatically: ${n}`,
    muted: {
      manual: "(acked)",
      auto: "(closed automatically)",
      superseded: "(replaced by a newer turn-in)",
      no_work_expected: "(no homework in the post)",
    },
    verdict: {
      ok: "✅ ok",
      warn: "🟠 warn",
      panic: "🔴 panic",
      unchecked: "🔍 not checked automatically",
      pending: "⏳ not reviewed yet",
    },
    debt: {
      redo: "🔁 redo requested",
      missing: "⏰ not turned in",
      unchecked: "🔍 check by hand",
    },
  },

  telegram: {
    urgent: "🚨 <b>Urgent</b>",
    digest: "📋 <b>Digest</b>",
    dailyDigest: "📋 <b>Daily digest</b>",
    status: "📊 <b>Status</b>",
    other: "<b>Other</b>",
    noAccounts: "No watched accounts yet.",
    lastSync: (t) => `Last sync: ${t}`,
    never: "never",
    syncStatus: {
      ok: "ok",
      running: "running",
      error: "error",
      session_expired: "session expired",
      session_missing: "not logged in",
    },
    openCounts: (p, a, i, u) => `Open: 🔴 ${p} · 🟠 ${a} · ℹ️ ${i} (unsent ${u})`,
    debtCount: (n) => `📌 Open debts: ${n}`,
    upcomingCount: (n) => `🟢 Coming up: ${n}`,
    statusFooter: (time, days) =>
      `Daily digest at ${time}. Open = not marked seen, 7 days; debts are forgotten after ${days} days.`,
    nothingPending: "Nothing pending.",
    help: [
      "<b>classroom-advisor</b>",
      "/status – last sync and open alerts per kid",
      "/digest – send the pending digest now",
      "/refresh – sync and check now, then send a fresh digest here",
      "/recheck &lt;Classroom link&gt; – check an assignment again (or tap 🔄 on its card)",
    ].join("\n"),
    test: "✅ Test message: Telegram works.",
    commands: {
      status: "Last sync and open items per kid",
      digest: "Send the pending digest now",
      refresh: "Sync, check and send a fresh digest now",
      recheck: "Check an assignment again (number or Classroom link)",
      help: "Help",
    },
    refreshing: "🔄 Refreshing: sync and checks. I'll send the digest here.",
    alreadyRunning: "⏳ A refresh is already running; I'll send its digest when it's done.",
    cooldown: (left, every) =>
      `Please wait ${left} more min: a manual refresh can run once every ${every} min.`,
    freshDigest: "🔄 <b>Fresh digest</b>",
    recheckQueued: (item) => `🔁 ${item}: checking again, I'll reply with the result.`,
    recheckUsage: "Couldn't find that assignment. Send a Classroom assignment link.",
    recheckNotTurnedIn: (item) => `${item} isn't turned in yet: nothing to check.`,
    recheckDone: (item, verdict) => `🔁 Checked again: ${item} — ${verdict}`,
    recheckFailed: (item) => `Couldn't check ${item} again (the review failed). Try again later.`,
    view: {
      tag: {
        dueSoon: "due soon",
        overdue: "past due",
        missing: "not turned in",
        untouched: "not started",
        noDueDate: "no due date",
        comment: "teacher comment",
        redo: "needs rework",
        incomplete: "incomplete",
        checkByHand: "check by hand",
        notChecked: "not checked",
        sync: "sync problem",
        other: "notice",
      },
      dueShort: (d) => `due ${d}`,
      postedShort: (d) => `from ${d}`,
      dueFull: (t) => `due ${t}`,
      postedFull: (d) => `posted ${d}`,
      open: (n) => `open ${n}`,
      upcoming: (n) => `🟢 coming up ${n}`,
      otherKid: "Other",
      page: (p, n) => `page ${p}/${n}`,
      seen: "✅ Seen",
      newComment: "💬 <b>Teacher comment</b>",
      upcomingTitle: (days) => `🟢 <b>Coming up</b> (next ${days} days)`,
      button: {
        classroom: "🔎 Classroom",
        seen: "✅ Seen",
        recheck: "🔄 Recheck",
        back: "⬅ Back",
        refresh: "🔄 Refresh",
        upcoming: (n) => `🟢 Coming up (${n})`,
      },
      toast: {
        seen: "Marked as seen",
        seenKeepsDebt: "Marked as seen. The debt stays until the work is turned in.",
        stale: "This message is out of date: send /digest for a fresh one.",
        refreshing: "Refreshing: sync and checks. This message will update.",
        alreadyRunning: "A refresh is already running; this message will update when it's done.",
        cooldown: (left) => `Please wait ${left} more min before the next refresh.`,
        recheckQueued: "Checking again; I'll reply with the result.",
        notTurnedIn: "Not turned in yet: nothing to check.",
      },
    },
  },
};
