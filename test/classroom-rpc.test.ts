import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { frame } from "../scripts/anonymize.ts";
import {
  at,
  idToB64,
  ParseDriftError,
  reader,
  shapeOf,
} from "../src/collector/classroom/parse-util.ts";
import {
  assertReadOnly,
  basePathOf,
  buildRequest,
  type ClassroomSession,
  coursesArgs,
  createRpcClient,
  encodeArgs,
  num,
  type PageGlobals,
  RpcError,
  RpcNotAllowedError,
  sessionFromGlobals,
  submissionsArgs,
  todoArgs,
  unwrapResponse,
  userIdFromX3UoP,
} from "../src/collector/classroom/rpc.ts";
import { SessionExpiredError } from "../src/collector/files.ts";

const DIR = join(import.meta.dirname, "..", "fixtures", "classroom");
// biome-ignore lint/suspicious/noExplicitAny: positional protobuf-JSON arrays
type J = any;
const fixture = (name: string): { rpcid: string; request: J; response: J } =>
  JSON.parse(readFileSync(join(DIR, name), "utf8"));
const roundTrip = (args: unknown) => JSON.parse(encodeArgs(args));

const SESSION: ClassroomSession = {
  authuser: "user1@school.example",
  basePath: "/u/1",
  sourcePath: "/u/1/a/not-turned-in/all",
  at: "XSRF:123",
  fsid: "-42",
  bl: "boq_classroom-ui_20261001.00_p0",
  hl: "uk",
  userId: "831760658545",
};

describe("request templates match the recorded requests", () => {
  it("pONvgf", () => {
    const { request } = fixture("todo.pONvgf.json");
    const buckets = request[2][0][14];
    expect(roundTrip(todoArgs(["342275451769"], buckets))).toEqual(request);
    const next = roundTrip(todoArgs(["342275451769"], buckets, "TOKEN=="));
    expect(next[0][1]).toBe("TOKEN==");
  });

  it("gXtzob", () => {
    expect(roundTrip(coursesArgs())).toEqual(fixture("courses.gXtzob.json").request);
  });

  it("Zj93ge list and attachments masks", () => {
    for (const [name, attachments] of [
      ["submissions.Zj93ge.json", false],
      ["detail-submission.Zj93ge.json", false],
      ["detail-attachments.Zj93ge.json", true],
    ] as const) {
      const { request } = fixture(name);
      const keys = (request[2][2] as J[]).map((k) => ({
        studentId: String(k[0]),
        itemId: String(k[1][0]),
        courseId: String(k[1][1][0]),
      }));
      expect(roundTrip(submissionsArgs(keys, { attachments }))).toEqual(request);
    }
  });

  it("sends ids as bare JSON numbers, also beyond 2^53", () => {
    expect(encodeArgs([num("123456789012345678901"), "x"])).toBe('[123456789012345678901,"x"]');
    expect(() => num("12a")).toThrow();
  });
});

describe("buildRequest", () => {
  it("encodes url params and the form body", () => {
    const { url, body } = buildRequest("pONvgf", [[1, null]], SESSION, 284020);
    const u = new URL(url, "https://classroom.google.com");
    expect(u.pathname).toBe("/u/1/_/ClassroomUi/data/batchexecute");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      rpcids: "pONvgf",
      "source-path": "/u/1/a/not-turned-in/all",
      "f.sid": "-42",
      bl: SESSION.bl,
      hl: "uk",
      "soc-app": "1",
      "soc-platform": "1",
      "soc-device": "1",
      _reqid: "284020",
      rt: "c",
    });
    const form = new URLSearchParams(body);
    expect(form.get("at")).toBe("XSRF:123");
    expect(JSON.parse(form.get("f.req") ?? "")).toEqual([
      [["pONvgf", "[[1,null]]", null, "generic"]],
    ]);
  });

  it("account 0 has no /u/<n> prefix", () => {
    const { url } = buildRequest("gXtzob", [], { ...SESSION, basePath: "" }, 1);
    expect(url.startsWith("/_/ClassroomUi/data/batchexecute?")).toBe(true);
  });

  it("refuses rpcids outside the read-only allow-list", () => {
    for (const id of ["Xyz123", "", "pONvgf,Zj93ge", "gXtzob "]) {
      expect(() => buildRequest(id, [], SESSION, 1)).toThrow(RpcNotAllowedError);
      expect(() => assertReadOnly(id)).toThrow(RpcNotAllowedError);
    }
  });
});

describe("unwrapResponse", () => {
  it("decodes the recorded envelope", () => {
    const body = readFileSync(join(DIR, "envelope.Zj93ge.txt"), "utf8");
    const payload = unwrapResponse(body, "Zj93ge") as J;
    expect(payload[0]).toBe("hrq.sub");
    expect(payload[2][0][0][1][0]).toMatch(/^\d+$/);
  });

  it("throws RpcError with the code of an error row", () => {
    const body = frame([[["wrb.fr", "t51ITc", null, null, null, [3], "generic"]], [["di", 42]]]);
    const err = (() => {
      try {
        unwrapResponse(body, "t51ITc");
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).code).toEqual([3]);
  });

  it("detects a login page as an expired session", () => {
    const html = '<html><form action="https://accounts.google.com/v3/signin/identifier">';
    expect(() => unwrapResponse(html, "gXtzob")).toThrow(SessionExpiredError);
  });

  it("raises drift on non-framing bodies and missing rows", () => {
    expect(() => unwrapResponse("<html>oops</html>", "gXtzob")).toThrow(ParseDriftError);
    expect(() => unwrapResponse(")]}'\n\nxx\n", "gXtzob")).toThrow(ParseDriftError);
    const other = frame([[["wrb.fr", "UG41I", '["hrq.usr"]', null, null, null, "generic"]]]);
    expect(() => unwrapResponse(other, "gXtzob")).toThrow(/no wrb.fr row/);
  });
});

describe("createRpcClient", () => {
  it("sends through the transport with increasing _reqid", async () => {
    const seen: string[] = [];
    const client = createRpcClient(async (url) => {
      seen.push(url);
      return frame([[["wrb.fr", "gXtzob", '["hrq.crs",[false],[]]', null, null, null, "generic"]]]);
    }, SESSION);
    expect(await client.call("gXtzob", coursesArgs())).toEqual(["hrq.crs", [false], []]);
    await client.call("gXtzob", coursesArgs());
    const ids = seen.map((u) => Number(new URL(u, "https://x").searchParams.get("_reqid")));
    expect((ids[1] ?? 0) - (ids[0] ?? 0)).toBe(100_000);
  });

  it("never reaches the transport for a disallowed rpcid", async () => {
    let called = false;
    const client = createRpcClient(async () => {
      called = true;
      return "";
    }, SESSION);
    // biome-ignore lint/suspicious/noExplicitAny: deliberately bypassing the type
    await expect(client.call("Turn1n" as any, [])).rejects.toThrow(RpcNotAllowedError);
    expect(called).toBe(false);
  });
});

describe("page session", () => {
  const globals: PageGlobals = {
    href: "https://classroom.google.com/u/2/a/not-turned-in/all",
    lang: "uk",
    at: "AT",
    fsid: "123",
    bl: "BL",
    user: '%.@.["831760658545","Lorem Ipsum",null,1]',
    emailMatches: true,
    loginPage: false,
  };

  it("reads tokens, prefix and user id", () => {
    expect(sessionFromGlobals("a@b.example", globals)).toEqual({
      authuser: "a@b.example",
      basePath: "/u/2",
      sourcePath: "/u/2/a/not-turned-in/all",
      at: "AT",
      fsid: "123",
      bl: "BL",
      hl: "uk",
      userId: "831760658545",
    });
    expect(basePathOf("/a/missing/all")).toBe("");
    expect(basePathOf("/u/10/c/abc")).toBe("/u/10");
    expect(userIdFromX3UoP('%.@.["42","x"')).toBe("42");
    expect(userIdFromX3UoP(null)).toBeNull();
  });

  it("treats a sign-in redirect or another account as an expired session", () => {
    expect(() =>
      sessionFromGlobals("a@b.example", {
        ...globals,
        href: "https://accounts.google.com/v3/signin/identifier?continue=x",
      }),
    ).toThrow(SessionExpiredError);
    expect(() => sessionFromGlobals("a@b.example", { ...globals, emailMatches: false })).toThrow(
      SessionExpiredError,
    );
  });

  it("raises drift when tokens are missing", () => {
    expect(() => sessionFromGlobals("a@b.example", { ...globals, at: null })).toThrow(
      /WIZ_global_data.*SNlM0e/,
    );
  });
});

describe("parse-util", () => {
  it("walks paths without throwing", () => {
    expect(at([[1, [2, 3]]], 0, 1, 1)).toBe(3);
    expect(at([null], 0, 5, 2)).toBeUndefined();
    expect(at("str", 0)).toBeUndefined();
  });

  it("typed getters report path and shape, never the value", () => {
    const r = reader("pONvgf");
    const row = [["secret title"], 5];
    expect(r.str(row, [0, 0])).toBe("secret title");
    expect(r.optStr(row, [9])).toBeNull();
    expect(r.id(["123"], [0])).toBe("123");
    expect(r.id([123], [0])).toBe("123");
    expect(() => r.id(["12x"], [0])).toThrow(ParseDriftError);
    expect(r.optMs([1760000000000], [0])).toBe(1760000000000);
    expect(() => r.ms([5], [0])).toThrow(/epoch ms/);
    let err: ParseDriftError | undefined;
    try {
      r.num(row, [0, 0], "item#3");
    } catch (e) {
      err = e as ParseDriftError;
    }
    expect(err?.message).toBe(
      "pONvgf: payload drift (expected number at item#3[0][0], got string(12))",
    );
    expect(err?.message).not.toContain("secret");
    expect(err?.rpcid).toBe("pONvgf");
    expect(err?.path).toBe("item#3[0][0]");
  });

  it("shapeOf and idToB64", () => {
    expect(shapeOf([1, 2])).toBe("array(2)");
    expect(shapeOf(undefined)).toBe("missing");
    expect(idToB64("123456789012")).toBe("MTIzNDU2Nzg5MDEy");
  });
});
