// Value sets stored as plain strings in SQLite. Statuses/states stay open (`string & {}`)
// until the collector pins down what Classroom actually returns.

export const ASSIGNMENT_KINDS = ["assignment", "question", "material", "quiz", "unknown"] as const;
export type AssignmentKind = (typeof ASSIGNMENT_KINDS)[number];

export type AssignmentStatus = "assigned" | "turned_in" | "missing" | "returned" | (string & {});

export type SubmissionState =
  | "new"
  | "created"
  | "turned_in"
  | "returned"
  | "reclaimed"
  | (string & {});

export const ATTACHMENT_OWNERS = ["material", "submission"] as const;
export type AttachmentOwner = (typeof ATTACHMENT_OWNERS)[number];

export const COMMENT_AUTHOR_ROLES = ["teacher", "student", "unknown"] as const;
export type CommentAuthorRole = (typeof COMMENT_AUTHOR_ROLES)[number];

/** `unchecked`: nothing could be checked automatically (see `UncheckedItem`). */
export const VERDICTS = ["ok", "warn", "panic", "unchecked"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** `heuristic` or `llm:<provider>`. */
export type CheckSource = "heuristic" | `llm:${string}`;

export const ALERT_LEVELS = ["info", "alert", "panic"] as const;
export type AlertLevel = (typeof ALERT_LEVELS)[number];

/** Result of an upsert that tracks content versions. */
export type Change = "new" | "updated" | "unchanged";

export const EVENT_TYPES = [
  "assignment.new",
  "assignment.updated",
  "assignment.missing",
  "submission.turned_in",
  "submission.unsubmitted",
  "submission.returned",
  "comment.new",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export type SyncRunStatus = "running" | "ok" | "session_expired" | "session_missing" | "error";

/** Why an attachment can't be read automatically (rendered per language, see `src/i18n/`). */
export const UNREADABLE_CODES = [
  "pdf_no_text",
  "video",
  "audio",
  "form",
  "link",
  "legacy_ppt",
  "legacy_doc",
  "legacy_xls",
  "too_large",
  "no_access",
  "extract_failed",
  "not_drive",
  "download_failed",
  "not_downloaded",
  "copy_unreadable",
  "image_format",
  "unsupported_format",
] as const;
export type UnreadableCode = (typeof UNREADABLE_CODES)[number];

export interface UnreadableCause {
  code: UnreadableCode;
  /** Detail: host, size in MB, HTTP status, file extension or a short error. */
  arg?: string;
}

/** A part of the work that wasn't checked automatically, and why ("check by hand"). */
export interface UncheckedItem {
  /** E.g. an attachment title in quotes, or "test result on Naurok". */
  what: string;
  /** Free text: the LLM's reason (in the digest language), or the English attachment reason. */
  why: string;
  /** Unreadable attachments: the structured reason, rendered in the digest language. */
  cause?: UnreadableCause;
}

/** Item reference in an alert: assignment title and course name. */
export interface AlertItem {
  title: string;
  course: string;
}

/** Redo request still open and the work is past due / due within a day. */
export type RedoDue = "past" | "soon";

/**
 * What an alert says, as a code plus params (stored as `Alert.code` + JSON `Alert.params`) and
 * rendered in the configured language at print/send time (`renderAlert`, D18). `text` is free
 * text that isn't translated (and what alerts from before #49 became).
 */
export type AlertContent =
  | { code: "text"; params: { text: string } }
  | { code: "deadline.missing"; params: AlertItem }
  | { code: "deadline.due_soon"; params: AlertItem & { dueAt: string } }
  | { code: "deadline.untouched_24h"; params: AlertItem }
  | { code: "deadline.no_due_date"; params: AlertItem }
  | { code: "comment.teacher"; params: AlertItem & { text: string; redoDue?: RedoDue } }
  | {
      code: "quality.review";
      params: AlertItem & {
        verdict: "warn" | "panic";
        /** LLM review: its summary and missing parts (already in the configured language). */
        summary?: string;
        missing?: string[];
        /** A heuristic forced the panic: every attachment is the template, unchanged. */
        template?: boolean;
        /** No LLM verdict: why the heuristics flagged it (signal codes) and why there's no LLM. */
        heuristic?: { basis: "unreadable" | "fallback"; signals: string[] };
        unchecked?: UncheckedItem[];
        redoDue?: RedoDue;
      };
    }
  | { code: "quality.unchecked"; params: AlertItem & { items: UncheckedItem[] } }
  | {
      code: "quality.llm_failed";
      params: AlertItem & { failures: number; provider: string; error: string };
    }
  | { code: "sync.session"; params: { account: string; state: "expired" | "missing" } }
  | { code: "sync.drift"; params: { account: string; rpcid: string; error: string } };

export type AlertCode = AlertContent["code"];
