import { describe, expect, it, vi } from "vitest";
import { accountRows, formatRows } from "../src/cli/accounts.ts";
import {
  ACCOUNT_CHOOSER_URL,
  classroomUrl,
  type DiscoveryDeps,
  discoverAccounts,
  LIST_ACCOUNTS_URL,
  parseAccountChooser,
  parseListAccounts,
  SessionMissingError,
} from "../src/collector/accounts.ts";

const entry = (name: string, email: string, index: number, valid = 1, signedOut?: boolean) => {
  const e: unknown[] = [
    "gaia.l.a",
    1,
    name,
    email,
    "https://lh3.example/photo",
    1,
    1,
    index,
    null,
    valid,
  ];
  e[10] = "1234567890";
  if (signedOut !== undefined) e[14] = signedOut;
  return e;
};

const listBody = (...entries: unknown[][]) => JSON.stringify(["gaia.l.a.r", entries]);

describe("parseListAccounts", () => {
  it("returns signed-in accounts in cookie order", () => {
    const body = listBody(
      entry("Kid One", "Kid1@school.example", 0),
      entry("Kid Two", "kid2@school.example", 1, 0),
      entry("Gone", "gone@school.example", 2, 1, true),
      entry("Out of order", "kid4@school.example", 5),
    );
    expect(parseListAccounts(body)).toEqual([
      { email: "kid1@school.example", name: "Kid One", index: 0, valid: true },
      { email: "kid2@school.example", name: "Kid Two", index: 1, valid: false },
      { email: "kid4@school.example", name: "Out of order", index: 5, valid: true },
    ]);
  });

  it("strips the XSSI prefix and tolerates shifted positions", () => {
    const shifted = ["gaia.l.a", 1, "", null, "kid3@school.example"];
    expect(parseListAccounts(`)]}'\n${listBody(shifted)}`)).toEqual([
      { email: "kid3@school.example", index: 0, valid: true },
    ]);
  });

  it("returns [] when no one is logged in", () => {
    expect(parseListAccounts('["gaia.l.a.r",[]]')).toEqual([]);
  });

  it("throws on drift", () => {
    expect(() => parseListAccounts("<html>")).toThrow(/not JSON/);
    expect(() => parseListAccounts('{"a":1}')).toThrow(/unexpected shape/);
  });
});

describe("parseAccountChooser", () => {
  it("prefers data-identifier attributes and dedupes", () => {
    const html =
      '<div data-identifier="kid1@school.example"></div><div data-identifier="KID1@school.example"></div>' +
      '<div data-email="kid2@school.example"></div> footer help@other.example';
    expect(parseAccountChooser(html).map((a) => a.email)).toEqual([
      "kid1@school.example",
      "kid2@school.example",
    ]);
  });

  it("falls back to emails in text", () => {
    expect(parseAccountChooser("<p>kid1@school.example</p>")).toEqual([
      { email: "kid1@school.example", index: 0, valid: true },
    ]);
  });
});

describe("discoverAccounts", () => {
  const deps = (over: Partial<DiscoveryDeps>): DiscoveryDeps => ({
    postText: vi.fn(async () => ({ status: 200, text: '["gaia.l.a.r",[]]' })),
    pageHtml: vi.fn(async () => ""),
    ...over,
  });

  it("uses ListAccounts first", async () => {
    const d = deps({
      postText: vi.fn(async () => ({
        status: 200,
        text: listBody(entry("A", "kid1@school.example", 0)),
      })),
    });
    const result = await discoverAccounts(d);
    expect(result.method).toBe("list-accounts");
    expect(result.accounts).toHaveLength(1);
    expect(d.postText).toHaveBeenCalledWith(LIST_ACCOUNTS_URL);
    expect(d.pageHtml).not.toHaveBeenCalled();
  });

  it("falls back to the account chooser", async () => {
    const d = deps({
      postText: vi.fn(async () => ({ status: 403, text: "" })),
      pageHtml: vi.fn(async () => '<li data-identifier="kid2@school.example">'),
    });
    const result = await discoverAccounts(d);
    expect(result).toEqual({
      method: "account-chooser",
      accounts: [{ email: "kid2@school.example", index: 0, valid: true }],
    });
    expect(d.pageHtml).toHaveBeenCalledWith(ACCOUNT_CHOOSER_URL);
  });

  it("reports a missing session instead of logging in", async () => {
    await expect(discoverAccounts(deps({}))).rejects.toThrow(SessionMissingError);
    await expect(discoverAccounts(deps({}))).rejects.toThrow(/log in manually/i);
  });
});

describe("classroomUrl", () => {
  it("addresses an account by email", () => {
    expect(classroomUrl("kid1@school.example")).toBe(
      "https://classroom.google.com/?authuser=kid1%40school.example",
    );
    expect(classroomUrl("kid1@school.example", "a/missing/all")).toBe(
      "https://classroom.google.com/a/missing/all?authuser=kid1%40school.example",
    );
  });
});

describe("accountRows", () => {
  it("merges logged-in accounts with the watch list", () => {
    const rows = accountRows(
      [
        { email: "kid1@school.example", name: "Kid One", index: 0, valid: true },
        { email: "kid2@school.example", index: 1, valid: false },
      ],
      ["KID1@school.example", "kid3@school.example"],
    );
    expect(rows).toEqual([
      { email: "kid1@school.example", name: "Kid One", loggedIn: true, watched: true, valid: true },
      { email: "kid2@school.example", loggedIn: true, watched: false, valid: false },
      { email: "kid3@school.example", loggedIn: false, watched: true, valid: false },
    ]);
    const lines = formatRows(rows);
    expect(lines[0]).toMatch(/^watched\s+logged in\s+kid1@school\.example \(Kid One\)$/);
    expect(lines[1]).toMatch(/SESSION EXPIRED/);
    expect(lines[2]).toMatch(/NOT LOGGED IN/);
  });
});
