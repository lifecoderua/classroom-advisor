import { describe, expect, it } from "vitest";
import { Anonymizer, frame, parseFrames } from "../scripts/anonymize.ts";

const input = {
  rpcid: "Zj93ge",
  sourcePath: "/c/MTIzNDU2Nzg5MDEy/a/OTg3NjU0MzIxMDk4/details",
  response: [
    "hrq.sub",
    [false],
    [
      [
        ["111122223333", ["123456789012", ["555566667777"]]],
        null,
        1791311088344,
        "Jane Example",
        [
          [
            "Homework photo.jpg",
            null,
            "1AbCdEfGhIjKlMnOpQrStUvWxYz012345",
            2,
            "image/jpeg",
            "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/view?usp=drive_web",
          ],
        ],
        "jane.example@real-school.example.org",
        "<div>Read <b>page 12</b></div>",
        "fA==",
        "#9334e6",
        "c:555566667777:s:123456789012",
        "https://other.example.net/resource/94348883?x=1",
        9,
      ],
    ],
  ],
};

describe("Anonymizer", () => {
  const anon = new Anonymizer({ seed: 1 });
  const out = anon.value(input) as typeof input;
  const text = JSON.stringify(out);

  it("keeps structure, enums and small numbers", () => {
    expect(out.rpcid).toBe("Zj93ge");
    const sub = out.response[2] as unknown[][];
    const row = sub[0] as unknown[];
    expect(row).toHaveLength((input.response[2] as unknown[][])[0]?.length ?? 0);
    expect(out.response[0]).toBe("hrq.sub");
    expect(row[7]).toBe("fA==");
    expect(row[8]).toBe("#9334e6");
    expect(row[11]).toBe(9);
    expect((row[4] as unknown[][])[0]?.[4]).toBe("image/jpeg");
  });

  it("maps ids consistently and keeps their shape", () => {
    const row = (out.response[2] as unknown[][])[0] as unknown[];
    const key = row[0] as [string, [string, [string]]];
    expect(key[0]).toMatch(/^\d{12}$/);
    expect(key[0]).not.toBe("111122223333");
    expect(row[9]).toBe(`c:${key[1][1][0]}:s:${key[1][0]}`);
    const fileId = (row[4] as unknown[][])[0]?.[2] as string;
    expect(fileId).toHaveLength(33);
    expect((row[4] as unknown[][])[0]?.[5]).toContain(`/file/d/${fileId}/view`);
    // Base64 ids in paths decode to the mapped decimal ids.
    const seg = out.sourcePath.split("/")[2] ?? "";
    expect(Buffer.from(seg, "base64").toString()).toBe(key[1][0]);
  });

  it("shifts timestamps by whole weeks", () => {
    const row = (out.response[2] as unknown[][])[0] as unknown[];
    const delta = 1791311088344 - (row[2] as number);
    expect(delta % (7 * 24 * 3600 * 1000)).toBe(0);
  });

  it("replaces names, emails, text, html and foreign hosts", () => {
    for (const real of [
      "Jane",
      "Homework",
      "real-school",
      "page 12",
      "other.example.net",
      "94348883",
    ]) {
      expect(text).not.toContain(real);
    }
    expect(text).toContain("@school.example");
    expect(text).toMatch(/<div>\w+ <b>\w+ \w+<\/b><\/div>/);
    expect(text).toContain(".jpg");
    expect(() => anon.verify(text, "out")).not.toThrow();
    expect(() => anon.verify("Jane Example", "leak")).toThrow(/still present/);
  });

  it("re-frames batchexecute bodies", () => {
    const body = frame([
      [["wrb.fr", "Zj93ge", JSON.stringify(input.response), null, null, null, "generic"]],
    ]);
    const parsed = parseFrames(new Anonymizer().batchexecute(body)) as unknown[][][];
    const row = parsed[0]?.[0] as unknown[];
    expect(row[1]).toBe("Zj93ge");
    expect(JSON.parse(row[2] as string)[0]).toBe("hrq.sub");
    expect(body.startsWith(")]}'\n")).toBe(true);
  });
});
