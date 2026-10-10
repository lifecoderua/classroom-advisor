import type { BrowserContext } from "playwright";

export interface GoogleAccount {
  email: string;
  name?: string;
  /** Position in the multi-login cookie (`/u/<index>/`). Unstable; address accounts by email. */
  index: number;
  /** False when Google lists the account but its session needs a re-login. */
  valid: boolean;
}

export type DiscoveryMethod = "list-accounts" | "account-chooser";

export interface Discovery {
  accounts: GoogleAccount[];
  method: DiscoveryMethod;
}

export class SessionMissingError extends Error {
  override name = "SessionMissingError";
  constructor(detail = "no Google accounts are logged in") {
    super(
      `Session missing: ${detail}. Log in manually in the collector profile (see README setup); ` +
        "this tool never logs in.",
    );
  }
}

export const LIST_ACCOUNTS_URL =
  "https://accounts.google.com/ListAccounts?gpsia=1&source=ChromiumBrowser&json=standard";
export const ACCOUNT_CHOOSER_URL =
  "https://accounts.google.com/AccountChooser?continue=https%3A%2F%2Fclassroom.google.com%2F";

const EMAIL = /^[^\s@"'<>]+@[^\s@"'<>]+\.[^\s@"'<>]+$/;
const EMAIL_GLOBAL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

const isEmail = (v: unknown): v is string => typeof v === "string" && EMAIL.test(v);

function stripXssi(text: string): string {
  return text.replace(/^\)\]\}'[^\n]*\n?/, "").trim();
}

/**
 * Parses the `ListAccounts` body, as Chromium does:
 * `["gaia.l.a.r", [["gaia.l.a", 1, name, email, photo, ?, ?, ?, ?, valid, gaiaId, ?, ?, ?, signedOut], ...]]`.
 * Positions are kept loose: the email is the first email-looking string if [3] isn't one.
 * Signed-out accounts are dropped; the rest keep their cookie order as `index`.
 */
export function parseListAccounts(text: string): GoogleAccount[] {
  let data: unknown;
  try {
    data = JSON.parse(stripXssi(text));
  } catch {
    throw new Error("ListAccounts: response is not JSON");
  }
  if (!Array.isArray(data) || !Array.isArray(data[1])) {
    throw new Error("ListAccounts: unexpected shape");
  }
  const accounts: GoogleAccount[] = [];
  for (const entry of data[1] as unknown[]) {
    if (!Array.isArray(entry)) continue;
    const email = isEmail(entry[3]) ? entry[3] : entry.find(isEmail);
    if (!email) continue;
    if (entry[14] === true || entry[14] === 1) continue;
    const name = typeof entry[2] === "string" && entry[2] && !isEmail(entry[2]) ? entry[2] : null;
    accounts.push({
      email: email.toLowerCase(),
      ...(name ? { name } : {}),
      index: accounts.length,
      valid: entry[9] === undefined || entry[9] === 1 || entry[9] === true,
    });
  }
  return accounts;
}

/** Fallback: emails in document order from the account chooser HTML, deduped. */
export function parseAccountChooser(html: string): GoogleAccount[] {
  const fromAttrs = [...html.matchAll(/data-(?:identifier|email)="([^"]+)"/g)].map((m) => m[1]);
  const candidates = fromAttrs.length > 0 ? fromAttrs : (html.match(EMAIL_GLOBAL) ?? []);
  const seen = new Set<string>();
  const accounts: GoogleAccount[] = [];
  for (const raw of candidates) {
    const email = raw?.toLowerCase();
    if (!email || !isEmail(email) || seen.has(email)) continue;
    seen.add(email);
    accounts.push({ email, index: accounts.length, valid: true });
  }
  return accounts;
}

export interface DiscoveryDeps {
  /** GET with the profile's cookies. */
  fetchText(url: string): Promise<{ status: number; text: string }>;
  /** Loads a page read-only and returns its HTML. */
  pageHtml(url: string): Promise<string>;
}

export function contextDeps(context: BrowserContext): DiscoveryDeps {
  return {
    async fetchText(url) {
      const res = await context.request.get(url, { failOnStatusCode: false });
      return { status: res.status(), text: await res.text() };
    },
    async pageHtml(url) {
      const page = await context.newPage();
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
        return await page.content();
      } finally {
        await page.close();
      }
    },
  };
}

/**
 * Lists the Google accounts logged in to the profile. Tries `ListAccounts`, then the
 * account chooser page. Never logs in: throws {@link SessionMissingError} if none are found.
 */
export async function discoverAccounts(deps: DiscoveryDeps): Promise<Discovery> {
  const errors: string[] = [];
  try {
    const res = await deps.fetchText(LIST_ACCOUNTS_URL);
    if (res.status !== 200) throw new Error(`ListAccounts: HTTP ${res.status}`);
    const accounts = parseListAccounts(res.text);
    if (accounts.length > 0) return { accounts, method: "list-accounts" };
    errors.push("ListAccounts: no accounts");
  } catch (err) {
    errors.push((err as Error).message);
  }

  try {
    const accounts = parseAccountChooser(await deps.pageHtml(ACCOUNT_CHOOSER_URL));
    if (accounts.length > 0) return { accounts, method: "account-chooser" };
    errors.push("account chooser: no accounts");
  } catch (err) {
    errors.push(`account chooser: ${(err as Error).message}`);
  }

  throw new SessionMissingError(`no logged-in Google accounts found (${errors.join("; ")})`);
}

/** Builds a Classroom URL that targets one account with `authuser=<email>`. */
export function classroomUrl(email: string, path = "/"): string {
  const url = new URL(path.startsWith("/") ? path : `/${path}`, "https://classroom.google.com");
  url.searchParams.set("authuser", email);
  return url.toString();
}
