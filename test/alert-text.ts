// Test helpers: an alert's text rendered in English (UTC), as the parent would read it.

import { type Locale, renderAlert } from "../src/i18n/index.ts";
import { type AlertContent, alertContent } from "../src/store/index.ts";

export const EN: Locale = { lang: "en", timeZone: "UTC" };

/** Text of a stored alert row (or "" when there's none). */
export function rowText(
  row: { code: string; params: string; createdAt: Date } | null | undefined,
  loc: Locale = EN,
): string {
  return row ? renderAlert(alertContent(row), row.createdAt, loc) : "";
}

/** Text of an alert's content (e.g. a `reviewSubmission` result), or "" without one. */
export function contentText(
  content: AlertContent | undefined,
  loc: Locale = EN,
  at: Date = new Date(),
): string {
  return content ? renderAlert(content, at, loc) : "";
}
