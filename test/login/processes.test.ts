import { describe, expect, it } from "vitest";
import { LoginDisplayError, startVnc, stopProc } from "../../src/login/processes.ts";
import { fakeProc, fakeSpawner } from "./fake-proc.ts";

describe("stopProc", () => {
  it("sends SIGTERM and waits for the exit", async () => {
    const p = fakeProc("chrome", []);
    await stopProc(p, 1000);
    expect(p.signals).toEqual(["SIGTERM"]);
    expect(p.done).toBe(true);
  });

  it("kills a process that ignores SIGTERM after the grace period", async () => {
    const p = fakeProc("chrome", [], undefined, { ignoreTerm: true });
    await stopProc(p, 20);
    expect(p.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("leaves an ended process alone", async () => {
    const p = fakeProc("chrome", []);
    p.exit(0);
    await stopProc(p, 1000);
    expect(p.signals).toEqual([]);
  });
});

describe("startVnc", () => {
  const ready = { displayReady: () => true, portReady: async () => true, readyTimeoutMs: 200 };

  it("starts Xvfb, x11vnc on the loopback with the password file, then noVNC", async () => {
    const { spawn, procs } = fakeSpawner();
    const vnc = await startVnc({
      screen: "1280x900x24",
      port: 6080,
      passwordFile: "/data/.pw",
      spawn,
      ...ready,
    });
    expect(vnc.display).toBe(":99");
    expect(procs.map((p) => p.cmd)).toEqual(["Xvfb", "x11vnc", "websockify"]);
    expect(procs[0]?.args).toEqual([":99", "-screen", "0", "1280x900x24", "-nolisten", "tcp"]);
    expect(procs[1]?.args).toContain("-localhost");
    expect(procs[1]?.args).toContain("rm:/data/.pw");
    expect(procs[2]?.args).toEqual(["--web", "/usr/share/novnc", "6080", "localhost:5900"]);
    await vnc.stop();
    expect(procs.every((p) => p.done)).toBe(true);
  });

  it("fails and stops what started when a process dies early", async () => {
    const { spawn, procs } = fakeSpawner();
    const dying: typeof spawn = (cmd, args, o) => {
      const p = spawn(cmd, args, o);
      if (cmd === "x11vnc") (p as ReturnType<typeof fakeProc>).exit(1);
      return p;
    };
    await expect(
      startVnc({
        screen: "1x1x24",
        port: 6080,
        passwordFile: "/pw",
        spawn: dying,
        displayReady: () => true,
        portReady: async () => false,
        readyTimeoutMs: 200,
      }),
    ).rejects.toThrow(LoginDisplayError);
    expect(procs.map((p) => p.cmd)).toEqual(["Xvfb", "x11vnc"]);
    expect(procs[0]?.signals).toEqual(["SIGTERM"]);
  });
});
