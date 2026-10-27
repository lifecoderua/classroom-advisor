import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type LoginConfig,
  LoginService,
  type LoginState,
  loginBrowserArgs,
  loginBrowserPath,
  loginRequestPath,
  loginToken,
  loginUrl,
  readLoginState,
  takeLoginRequest,
  writeLoginRequest,
} from "../../src/login/index.ts";
import type { VncOptions } from "../../src/login/processes.ts";
import { fakeSpawner } from "./fake-proc.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ca-login-"));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

const KID1 = "student-one@school.example";
const KID2 = "student-two@school.example";

const config = (over: Partial<LoginConfig> = {}): LoginConfig => ({
  profileDir: "/profile",
  chromeChannel: "chromium",
  dataDir: dir,
  watchedAccounts: [KID1, KID2],
  loginMode: "local",
  loginPort: 6080,
  loginTimeoutMin: 30,
  ...over,
});

function setup(over: Partial<LoginConfig> = {}, loggedIn: string[] = [KID1, KID2]) {
  const { spawn, procs } = fakeSpawner();
  const states: LoginState[] = [];
  const checks: number[] = [];
  const vncStarts: VncOptions[] = [];
  let vncStopped = 0;
  const service = new LoginService({
    config: config(over),
    spawn,
    browserPath: "/bin/chrome",
    profileInUse: () => false,
    token: () => "Tok3nAbc",
    saveState: (s) => states.push(structuredClone(s)),
    checkAccounts: async () => {
      checks.push(1);
      return loggedIn;
    },
    startVnc: async (o) => {
      vncStarts.push(o);
      return {
        display: ":99",
        stop: async () => {
          vncStopped++;
        },
      };
    },
    log: () => {},
  });
  return {
    service,
    procs,
    states,
    checks,
    vncStarts,
    vncStopped: () => vncStopped,
  };
}

/** Lets `run` reach the point where the browser is up. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("LoginService", () => {
  it("opens the plain browser locally and checks the accounts once it is closed", async () => {
    const t = setup({}, [KID1]);
    t.service.request();
    expect(t.service.pending()).toBe(true);
    const run = t.service.run(new AbortController().signal);
    await settle();
    expect(t.service.pending()).toBe(false);
    expect(t.service.active?.mode).toBe("local");
    expect(t.procs).toHaveLength(1);
    expect(t.procs[0]?.cmd).toBe("/bin/chrome");
    expect(t.procs[0]?.args).toContain("--user-data-dir=/profile");
    expect(t.procs[0]?.args).not.toContain("--remote-debugging-port");
    expect(t.states.at(-1)?.status).toBe("active");

    t.procs[0]?.exit(0);
    const res = await run;
    expect(res).toEqual({ end: "closed", loggedIn: [KID1], missing: [KID2] });
    expect(t.service.active).toBeUndefined();
    expect(t.states.at(-1)).toMatchObject({ status: "done", result: res });
    expect(t.vncStarts).toHaveLength(0);
  });

  it("runs on a noVNC display with a one-time password link in vnc mode", async () => {
    const t = setup({ loginMode: "vnc", loginBaseUrl: "https://box.example/" });
    t.service.request("phone");
    const run = t.service.run(new AbortController().signal);
    await settle();
    expect(t.vncStarts[0]).toMatchObject({ screen: "540x960x24", port: 6080 });
    const pwFile = t.vncStarts[0]?.passwordFile ?? "";
    expect(pwFile.startsWith(dir)).toBe(true);
    expect(existsSync(pwFile)).toBe(true);
    expect(t.procs[0]?.env?.DISPLAY).toBe(":99");
    expect(t.procs[0]?.args).toEqual(expect.arrayContaining(["--window-size=540,960"]));
    const active = t.states.at(-1);
    expect(active?.info.url).toBe(
      "https://box.example/vnc.html?autoconnect=1&resize=scale#password=Tok3nAbc",
    );

    expect(t.service.finish()).toBe(true);
    const res = await run;
    expect(res.end).toBe("done");
    expect(res.missing).toEqual([]);
    expect(t.procs[0]?.signals).toEqual(["SIGTERM"]);
    expect(t.vncStopped()).toBe(1);
    expect(existsSync(pwFile)).toBe(false);
    // The link (with its password) isn't kept once the login ended.
    expect(t.states.at(-1)?.info.url).toBeUndefined();
  });

  it("reports every state change to onState (the bot follows the login)", async () => {
    const seen: string[] = [];
    const { spawn, procs } = fakeSpawner();
    const service = new LoginService({
      config: config({ loginMode: "vnc" }),
      spawn,
      browserPath: "/bin/chrome",
      profileInUse: () => false,
      startVnc: async () => ({ display: ":99", stop: async () => {} }),
      saveState: () => {},
      onState: (s) => seen.push(`${s.status}:${s.info.url ? "link" : "-"}`),
      checkAccounts: async () => [KID1, KID2],
      log: () => {},
    });
    expect(service.mode).toBe("vnc");
    const run = service.run(new AbortController().signal);
    await settle();
    procs[0]?.exit(0);
    await run;
    expect(seen).toEqual(["active:link", "done:-"]);
  });

  it("ends by itself after the timeout", async () => {
    vi.useFakeTimers();
    const t = setup({ loginTimeoutMin: 1 });
    const run = t.service.run(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(60_000);
    const res = await run;
    expect(res.end).toBe("timeout");
    expect(t.checks).toHaveLength(1);
  });

  it("stops without checking the accounts when the loop stops", async () => {
    const t = setup();
    const controller = new AbortController();
    const run = t.service.run(controller.signal);
    await settle();
    controller.abort();
    const res = await run;
    expect(res.end).toBe("stopped");
    expect(t.checks).toHaveLength(0);
    expect(t.procs[0]?.done).toBe(true);
  });

  it("refuses to open a second browser on the profile", async () => {
    const { spawn, procs } = fakeSpawner();
    const service = new LoginService({
      config: config(),
      spawn,
      browserPath: "/bin/chrome",
      profileInUse: () => true,
      saveState: () => {},
      checkAccounts: async () => [],
      log: () => {},
    });
    const res = await service.run(new AbortController().signal);
    expect(res.error).toMatch(/already open/);
    expect(procs).toHaveLength(0);
  });

  it("wakes the loop on a request and ignores requests while a login is open", async () => {
    const t = setup();
    const wake = t.service.wakeSignal();
    expect(wake.aborted).toBe(false);
    t.service.request();
    expect(wake.aborted).toBe(true);
    const run = t.service.run(new AbortController().signal);
    await settle();
    expect(t.service.wakeSignal().aborted).toBe(false);
    t.service.request();
    expect(t.service.pending()).toBe(false);
    expect(t.service.wakeSignal().aborted).toBe(false);
    t.procs[0]?.exit(0);
    await run;
    expect(t.service.finish()).toBe(false);
  });

  it("takes start and done requests from the request file", async () => {
    const t = setup();
    writeLoginRequest(dir, { action: "start", at: new Date().toISOString() });
    t.service.pollRequests();
    expect(t.service.pending()).toBe(true);
    const run = t.service.run(new AbortController().signal);
    await settle();
    writeLoginRequest(dir, { action: "done", at: new Date().toISOString() });
    t.service.pollRequests();
    expect((await run).end).toBe("done");
    expect(existsSync(loginRequestPath(dir))).toBe(false);
  });

  it("marks a login left active by a dead loop as stopped", () => {
    writeFileSync(
      join(dir, "login.json"),
      JSON.stringify({
        status: "active",
        info: {
          mode: "vnc",
          layout: "desktop",
          startedAt: "2026-10-25T10:00:00.000Z",
          expiresAt: "2026-10-25T10:30:00.000Z",
          url: "http://localhost:6080/vnc.html#password=x",
        },
        updatedAt: "2026-10-25T10:00:00.000Z",
      }),
    );
    const service = new LoginService({ config: config(), log: () => {} });
    service.resetStale();
    const state = readLoginState(dir);
    expect(state?.status).toBe("done");
    expect(state?.result?.end).toBe("stopped");
    expect(state?.info.url).toBeUndefined();
  });
});

describe("takeLoginRequest", () => {
  const now = new Date("2026-10-25T12:00:00Z");

  it("returns and removes a fresh request", () => {
    writeLoginRequest(dir, { action: "start", layout: "phone", at: "2026-10-25T11:59:00Z" });
    expect(takeLoginRequest(dir, now)).toEqual({
      action: "start",
      layout: "phone",
      at: "2026-10-25T11:59:00Z",
    });
    expect(existsSync(loginRequestPath(dir))).toBe(false);
    expect(takeLoginRequest(dir, now)).toBeUndefined();
  });

  it("drops a stale or broken request", () => {
    writeLoginRequest(dir, { action: "start", at: "2026-10-25T11:00:00Z" });
    expect(takeLoginRequest(dir, now)).toBeUndefined();
    expect(existsSync(loginRequestPath(dir))).toBe(false);
    writeFileSync(loginRequestPath(dir), "{nope");
    expect(takeLoginRequest(dir, now)).toBeUndefined();
  });
});

describe("login helpers", () => {
  it("makes 8-character tokens (the VNC password limit)", () => {
    const a = loginToken();
    expect(a).toMatch(/^[A-Za-z0-9]{8}$/);
    expect(loginToken()).not.toBe(a);
  });

  it("puts the password in the link's fragment", () => {
    expect(loginUrl("http://localhost:6080", "abc")).toBe(
      "http://localhost:6080/vnc.html?autoconnect=1&resize=scale#password=abc",
    );
  });

  it("adds container flags only in vnc mode", () => {
    const local = loginBrowserArgs({ profileDir: "/p", mode: "local", layout: "desktop" });
    expect(local).not.toContain("--password-store=basic");
    expect(local.at(-1)).toBe("https://classroom.google.com/");
    const vnc = loginBrowserArgs({ profileDir: "/p", mode: "vnc", layout: "desktop" });
    expect(vnc).toEqual(
      expect.arrayContaining(["--no-sandbox", "--password-store=basic", "--window-size=1280,900"]),
    );
  });

  it("finds the plain browser per channel", () => {
    expect(loginBrowserPath("chrome", "linux")).toBe("/opt/google/chrome/chrome");
    expect(loginBrowserPath("chrome", "darwin")).toMatch(/Google Chrome\.app/);
    expect(loginBrowserPath("chromium", "linux")).toBeTruthy();
    expect(() => loginBrowserPath("msedge", "linux")).toThrow(/no browser path/);
  });
});
