import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFrames } from "../scripts/anonymize.ts";

/**
 * Pins the positional field paths documented in docs/CLASSROOM-INTERNALS.md against the
 * anonymized fixtures, so the doc and the fixtures stay in sync.
 */
const DIR = join(import.meta.dirname, "..", "fixtures", "classroom");
// biome-ignore lint/suspicious/noExplicitAny: positional protobuf-JSON arrays
type J = any;
const fixture = (name: string): { rpcid: string; request: J; response: J } =>
  JSON.parse(readFileSync(join(DIR, name), "utf8"));

const isId = (v: unknown) => typeof v === "string" && /^\d{6,}$/.test(v);
const isMs = (v: unknown) => typeof v === "number" && v > 1.2e12 && v < 2.3e12;

describe("classroom fixtures", () => {
  it("envelope: batchexecute framing with a wrb.fr row", () => {
    const chunks = parseFrames(readFileSync(join(DIR, "envelope.Zj93ge.txt"), "utf8")) as J[];
    const row = chunks[0][0];
    expect(row[0]).toBe("wrb.fr");
    expect(row[1]).toBe("Zj93ge");
    expect(JSON.parse(row[2])[0]).toBe("hrq.sub");
  });

  it("pONvgf: to-do stream items", () => {
    const { request, response } = fixture("todo.pONvgf.json");
    expect(response[0]).toBe("hrsi.qr");
    expect(typeof response[1][0]).toBe("boolean"); // has more pages
    expect(typeof response[1][1][0]).toBe("string"); // next page token, sent back at request[0][1]
    expect(request[0][0]).toBe(100); // page size
    expect(Array.isArray(request[2][0][14])).toBe(true); // to-do bucket filter
    for (const item of response[2]) {
      expect(item[0]).toBe(2); // ASSIGNMENT
      const [base, work] = item[1];
      expect(isId(base[0][0]) && isId(base[0][1][0])).toBe(true); // [itemId, [courseId]]
      expect(isMs(base[1]) && isMs(base[2])).toBe(true); // created, updated
      expect(typeof base[5]).toBe("string"); // title
      expect(base[13]).toBe(`c:${base[0][1][0]}:s:${base[0][0]}`);
      expect(work[0] === null || isMs(work[0])).toBe(true); // due (UTC epoch ms)
      expect(work[3] === null || typeof work[3] === "number").toBe(true); // max points
      expect([1, 2, 3]).toContain(work[18]);
      expect(typeof item[1][2][0]).toBe("string"); // Drive folder id
    }
  });

  it("Zj93ge: submission state and to-do bucket", () => {
    const { response } = fixture("submissions.Zj93ge.json");
    expect(response[0]).toBe("hrq.sub");
    const buckets = new Set<number>();
    for (const s of response[2]) {
      expect(isId(s[0][0]) && isId(s[0][1][0]) && isId(s[0][1][1][0])).toBe(true);
      expect([2, 3, 4, 5]).toContain(s[5]);
      buckets.add(s[20]);
      if (s[8] !== null) expect(typeof s[8]).toBe("number"); // grade
    }
    expect([...buckets].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 7, 8, 10, 11]);
  });

  it("Zj93ge (attachments mask): student files", () => {
    const { response } = fixture("detail-attachments.Zj93ge.json");
    const att = response[2][0][4][0];
    expect(att[3]).toBe(2); // Drive file
    expect(typeof att[2]).toBe("string"); // Drive file id
    expect(att[4]).toMatch(/\//); // mime
    expect(att[6]).toContain(att[2]);
    expect(att[15]).toBe(2); // student-owned
    const annotated = fixture("annotated-attachment.Zj93ge.json").response[2][0][4];
    expect(annotated.map((a: J) => a[15])).toContain(3);
  });

  it("t51ITc: materials", () => {
    const types = new Set<number>();
    for (const name of ["detail-materials.t51ITc.json", "materials-youtube-link.t51ITc.json"]) {
      for (const m of fixture(name).response[1]) {
        types.add(m[0][3]);
        expect(m[0][15]).toBe(1); // teacher material
        expect(m[2][1]).toBe(m[0][17]); // material id
      }
    }
    expect([...types].sort()).toEqual([2, 3, 4]);
  });

  it("tQShAc: item by id, assignment and material", () => {
    const a = fixture("detail.tQShAc.json").response[1][0];
    expect(a[2][0]).toBe(2);
    expect(a[2][1][0][27][0][6][0]).toBe("edu.rt"); // description rich text
    const m = fixture("material-detail.tQShAc.json").response[1][0];
    expect(m[2][0]).toBe(7); // MATERIAL: body at [5]
    expect(isId(m[2][5][0][0][0])).toBe(true);
  });

  it("sLc6hf: private comments", () => {
    const { response } = fixture("private-comments.sLc6hf.json");
    for (const c of response[2]) {
      expect(c[0][3]).toBe(3); // private (on a submission)
      expect(c[11][0]).toBe("edu.rt");
      expect(isMs(c[1])).toBe(true);
    }
  });

  it("gXtzob / UG41I: courses and users", () => {
    const course = fixture("courses.gXtzob.json").response[2][0];
    expect(isId(course[0][0]) && typeof course[5]).toBeTruthy();
    const user = fixture("self.UG41I.json").response[2][0];
    expect(isId(user[0][0])).toBe(true);
  });
});
