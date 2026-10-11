import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { turnedInSignals } from "../src/checks/heuristics.ts";
import {
  commentsHaveMore,
  linkTemplates,
  parseAssignmentDetail,
  parseItem,
  parseItems,
  parseMaterials,
  parsePrivateComments,
  parseSubmissions,
  toHeuristicsInput,
} from "../src/collector/classroom/detail.ts";
import { ParseDriftError } from "../src/collector/classroom/parse-util.ts";

const DIR = join(import.meta.dirname, "..", "fixtures", "classroom");
// biome-ignore lint/suspicious/noExplicitAny: positional protobuf-JSON arrays
type J = any;
const load = (name: string): J => JSON.parse(readFileSync(join(DIR, name), "utf8"));
const response = (name: string): J => load(name).response;
const clone = <T>(v: T): T => structuredClone(v);

const ITEM = "100900507604";
const COURSE = "342275451769";
const STUDENT = "831760658545";

describe("parseItems (tQShAc)", () => {
  it("parses the assignment with instructions, due date and points", () => {
    const [item] = parseItems(response("detail.tQShAc.json"));
    expect(item).toMatchObject({ id: ITEM, courseId: COURSE, kind: "assignment", maxPoints: 100 });
    expect(item?.title).toMatch(/^dolor sit amet/);
    expect(item?.instructions).toContain("incididunt\nut labore");
    expect(item?.instructionsHtml).toMatch(/^<div>/);
    expect(item?.dueAt?.toISOString()).toBe(new Date(1758042000000).toISOString());
    expect(item?.createdAt?.getTime()).toBe(1757442789890);
    expect(item?.updatedAt.getTime()).toBe(1759861512381);
    expect(item?.materialIds).toEqual(["983435226449", "277324711494"]);
  });

  it("parses a material post (type 7, body at [5])", () => {
    const [item] = parseItems(response("material-detail.tQShAc.json"));
    expect(item).toMatchObject({ kind: "material", dueAt: null, instructions: "" });
    expect(item?.maxPoints).toBeUndefined();
    expect(item?.materialIds).toEqual(["728416518019"]);
  });

  it("parses every item of the To-do and classwork lists (same item shape)", () => {
    const todo = response("todo.pONvgf.json")[2].map((it: J) => parseItem(it, "pONvgf"));
    expect(todo).toHaveLength(12);
    expect(todo.every((i: J) => i.kind === "assignment")).toBe(true);
    expect(todo.some((i: J) => i.dueAt === null)).toBe(true);
    const cw = response("classwork.dpT4Vd.json")[2].map((it: J) => parseItem(it, "dpT4Vd"));
    expect(cw.map((i: J) => i.kind).sort()).toContain("material");
  });

  it("drift: the minimal mask leaves out the title", () => {
    expect(() => parseItems(response("detail-lite.tQShAc.json"))).toThrow(ParseDriftError);
    try {
      parseItems(response("detail-lite.tQShAc.json"));
    } catch (e) {
      expect(e).toMatchObject({ rpcid: "tQShAc", path: "[1][0][2][1][0][5]" });
    }
  });

  it("drift: wrong tag, wrong types, empty list", () => {
    const p = response("detail.tQShAc.json");
    expect(() => parseItems(["hrq.sub", p[1]])).toThrow(/expected tag "hrsi.lr"/);
    const badDue = clone(p);
    badDue[1][0][2][1][1][0] = "soon";
    expect(() => parseItems(badDue)).toThrow(/expected number at \[1\]\[0\]\[2\]\[1\]\[1\]\[0\]/);
    expect(() => parseItems(["hrsi.lr", []])).toThrow(/no items/);
    const badRt = clone(p);
    badRt[1][0][2][1][0][27][0][6][0] = "edu.xx";
    expect(() => parseItems(badRt)).toThrow(ParseDriftError);
  });

  it("type 5 is a question (assumed body at [1]; never captured)", () => {
    const item = clone(response("detail.tQShAc.json")[1][0][2]);
    item[0] = 5;
    expect(parseItem(item).kind).toBe("question");
  });
});

describe("parseMaterials (t51ITc)", () => {
  it("link + Drive video", () => {
    const [link, video] = parseMaterials(response("detail-materials.t51ITc.json"));
    expect(link).toMatchObject({ itemId: ITEM, materialId: "983435226449" });
    expect(link?.attachment).toMatchObject({ origin: "material", type: "link", kind: "link" });
    expect(link?.attachment.url).toMatch(/^https:\/\/example\.com\//);
    expect(video?.attachment).toMatchObject({
      origin: "material",
      type: "drive",
      kind: "video",
      mime: "video/mp4",
      driveFileId: "5BXNQ1DoZIgFMkIN4BMtDah2LxWQk6fxf",
    });
    expect(video?.attachment.url).toContain(video?.attachment.driveFileId);
  });

  it("YouTube + link", () => {
    const [yt, link] = parseMaterials(response("materials-youtube-link.t51ITc.json"));
    expect(yt?.attachment).toMatchObject({ type: "youtube", kind: "youtube" });
    expect(yt?.attachment.url).toBe("https://www.youtube.com/watch?v=Z2ISfXnSDXn");
    expect(link?.attachment.kind).toBe("link");
  });

  it("Google Forms links become forms", () => {
    const p = clone(response("detail-materials.t51ITc.json"));
    p[1][0][0][6] = "https://docs.google.com/forms/d/e/abc/viewform";
    expect(parseMaterials(p)[0]?.attachment).toMatchObject({ type: "form", kind: "form" });
  });

  it("drift: type is not a number, id missing", () => {
    const p = clone(response("detail-materials.t51ITc.json"));
    p[1][0][0][3] = "2";
    expect(() => parseMaterials(p)).toThrow(/t51ITc: .*expected number at \[1\]\[0\]\[0\]\[3\]/);
    const q = clone(response("detail-materials.t51ITc.json"));
    q[1][1][0][2] = null;
    expect(() => parseMaterials(q)).toThrow(ParseDriftError);
  });
});

describe("parseSubmissions (Zj93ge)", () => {
  it("maps state and bucket for every observed bucket", () => {
    const subs = parseSubmissions(response("submissions.Zj93ge.json"));
    const by = Object.fromEntries(subs.map((s) => [s.itemId, s.submission]));
    expect(by["200322958360"]).toMatchObject({ state: "new", bucket: "assigned", late: false });
    expect(by["535241786656"]).toMatchObject({ state: "new", bucket: "missing" });
    expect(by["664328137076"]).toMatchObject({ state: "turned_in", bucket: "turned_in" });
    expect(by["550213121836"]).toMatchObject({
      state: "turned_in",
      bucket: "done_late",
      late: true,
    });
    expect(by["748819981434"]).toMatchObject({ state: "returned", bucket: "returned" });
    expect(by["978938961705"]).toMatchObject({ state: "returned", bucket: "graded", grade: 9 });
    expect(by["188209416331"]).toMatchObject({ bucket: "graded_late", grade: 8, late: true });
    expect(by["233229031112"]).toMatchObject({ bucket: "excused", excused: true });
    expect(by["664328137076"]?.turnedInAt?.getTime()).toBe(1760087960482);
    expect(by["978938961705"]?.returnedAt?.getTime()).toBe(1759913237146);
    expect(by["200322958360"]?.turnedInAt).toBeUndefined();
  });

  it("merges the list-mask and attachments-mask rows", () => {
    const [s] = parseSubmissions(
      response("detail-submission.Zj93ge.json"),
      response("detail-attachments.Zj93ge.json"),
    );
    expect(s).toMatchObject({ studentId: STUDENT, itemId: ITEM, courseId: COURSE });
    expect(s?.submission).toMatchObject({ state: "turned_in", bucket: "excused", excused: true });
    expect(s?.submission.attachments).toHaveLength(2);
    expect(s?.submission.attachments[0]).toMatchObject({
      origin: "student",
      type: "drive",
      kind: "image",
      mime: "image/jpeg",
      bytes: 4947882,
    });
  });

  it("teacher-annotated copy points at the student's file", () => {
    const p = clone(response("annotated-attachment.Zj93ge.json"));
    p[2][0][5] = 3; // the fixture uses the attachments mask; add a state
    const [s] = parseSubmissions(p);
    const [own, annotated] = s?.submission.attachments ?? [];
    expect(own?.origin).toBe("student");
    expect(annotated).toMatchObject({
      origin: "teacher_annotated",
      kind: "image",
      annotatedSourceId: own?.driveFileId,
    });
  });

  it("drift: attachments mask alone has no state; unknown enums don't throw", () => {
    expect(() => parseSubmissions(response("detail-attachments.Zj93ge.json"))).toThrow(
      /Zj93ge: .*at \[5\]: submission state missing/,
    );
    const p = clone(response("detail-submission.Zj93ge.json"));
    p[2][0][5] = 99;
    p[2][0][20] = 6;
    expect(parseSubmissions(p)[0]?.submission).toMatchObject({
      state: "unknown",
      bucket: "unknown",
    });
    p[2][0][5] = "2";
    expect(() => parseSubmissions(p)).toThrow(ParseDriftError);
    expect(() => parseSubmissions(["hrq.cmt", [false], []])).toThrow(/expected tag "hrq.sub"/);
  });
});

describe("parsePrivateComments (sLc6hf)", () => {
  it("text, html, time and author role", () => {
    const cs = parsePrivateComments(response("private-comments.sLc6hf.json"));
    expect(cs).toHaveLength(4);
    expect(cs[0]).toMatchObject({
      id: "980832795918",
      authorRole: "teacher",
      itemId: "188209416331",
      html: "<div>incididunt ut labore et dolore magna aliqua enim</div>",
    });
    expect(cs[0]?.text).toMatch(/^consectetur/);
    expect(cs[0]?.at.getTime()).toBe(1759686124263);
    expect(cs[1]?.authorRole).toBe("student");
  });

  it("a batch over several submissions keeps each comment's submission key", () => {
    const p = response("private-comments-batch.sLc6hf.json");
    const cs = parsePrivateComments(p);
    expect(cs.map((c) => [c.id, c.itemId, c.courseId, c.studentId, c.authorRole])).toEqual([
      ["111111111101", "200322958360", COURSE, STUDENT, "teacher"],
      ["111111111102", "200322958360", COURSE, STUDENT, "student"],
      ["111111111103", "664328137076", COURSE, STUDENT, "teacher"],
    ]);
    expect(cs[2]?.text).toBe("sed do eiusmod tempor");
    expect(commentsHaveMore(p)).toBe(false);
    expect(commentsHaveMore(["hrq.cmt", [true], []])).toBe(true);
    expect(commentsHaveMore(["hrq.cmt"])).toBe(false);
    expect(() => commentsHaveMore(["hrq.cmt", ["x"]])).toThrow(ParseDriftError);
    expect(() => commentsHaveMore(["hrq.sub", [false]])).toThrow(/expected tag "hrq.cmt"/);
  });

  it("drift on a bad comment id or time", () => {
    const p = clone(response("private-comments-batch.sLc6hf.json"));
    p[2][1][0][0] = "abc";
    expect(() => parsePrivateComments(p)).toThrow(/sLc6hf: .*\[2\]\[1\]\[0\]\[0\]/);
    const q = clone(response("private-comments-batch.sLc6hf.json"));
    q[2][0][1] = "soon";
    expect(() => parsePrivateComments(q)).toThrow(ParseDriftError);
  });

  it("empty response; drift on bad rich text", () => {
    expect(parsePrivateComments(response("class-comments-empty.sLc6hf.json"))).toEqual([]);
    const p = clone(response("private-comments.sLc6hf.json"));
    p[2][0][11] = "plain";
    expect(() => parsePrivateComments(p)).toThrow(/sLc6hf: .*\[2\]\[0\]\[11\]\[0\]/);
  });
});

describe("parseAssignmentDetail", () => {
  const full = () =>
    parseAssignmentDetail({
      item: response("detail.tQShAc.json"),
      materials: response("detail-materials.t51ITc.json"),
      submissions: [
        response("detail-submission.Zj93ge.json"),
        response("detail-attachments.Zj93ge.json"),
      ],
      studentId: STUDENT,
    });

  it("assembles the detail page RPCs", () => {
    const d = full();
    expect(d).toMatchObject({ id: ITEM, courseId: COURSE, kind: "assignment", maxPoints: 100 });
    expect(d.materials.map((m) => m.kind)).toEqual(["link", "video"]);
    expect(d.submission?.attachments).toHaveLength(2);
    expect(d.privateComments).toEqual([]);
    expect("materialIds" in d).toBe(false);
  });

  it("comments of the same item are kept, others dropped", () => {
    const todo = response("todo.pONvgf.json")[2].map((it: J) => parseItem(it, "pONvgf"));
    const graded = todo.find((i: J) => i.id === "188209416331");
    const d = parseAssignmentDetail({
      item: graded,
      submissions: [response("submissions.Zj93ge.json")],
      comments: response("private-comments.sLc6hf.json"),
    });
    expect(d.submission).toMatchObject({ bucket: "graded_late", grade: 8 });
    expect(d.privateComments).toHaveLength(4);
    const other = parseAssignmentDetail({
      item: response("detail.tQShAc.json"),
      comments: response("private-comments.sLc6hf.json"),
    });
    expect(other.privateComments).toEqual([]);
    expect(other.submission).toBeNull();
  });

  it("an assignment with a Forms material is a quiz", () => {
    const m = clone(response("detail-materials.t51ITc.json"));
    m[1][0][0][6] = "https://forms.gle/abc";
    const d = parseAssignmentDetail({ item: response("detail.tQShAc.json"), materials: m });
    expect(d.kind).toBe("quiz");
  });

  it("drift: materials of another item, missing submission", () => {
    expect(() =>
      parseAssignmentDetail({
        item: response("detail.tQShAc.json"),
        materials: response("materials-youtube-link.t51ITc.json"),
      }),
    ).toThrow(/material of item 233229031112/);
    expect(() =>
      parseAssignmentDetail({
        item: response("detail.tQShAc.json"),
        submissions: [response("submissions.Zj93ge.json")],
      }),
    ).toThrow(/expected 1 submission/);
  });

  // SYNTHETIC: "make a copy for each student" was never captured (see the fixture's note).
  it("links a student copy to its template (synthetic fixture)", () => {
    const syn = load("synthetic-template-copy.json");
    expect(syn.synthetic).toBe(true);
    const d = parseAssignmentDetail({
      item: response("detail.tQShAc.json"),
      materials: syn.materials.response,
      submissions: [syn.submission.response],
    });
    const [tpl] = d.materials;
    const [copy] = d.submission?.attachments ?? [];
    expect(tpl).toMatchObject({ kind: "doc", isTemplate: true });
    expect(copy).toMatchObject({
      kind: "doc",
      origin: "student",
      templateSourceId: tpl?.driveFileId,
    });
    expect(d.submission).toMatchObject({ state: "turned_in", bucket: "turned_in", late: false });
  });

  it("links by [14][3] source id regardless of title (synthetic)", () => {
    const syn = load("synthetic-template-copy.json");
    const sub = clone(syn.submission.response);
    const att = sub[2][0][4][0];
    att[0] = "Renamed";
    att[14][3] = [2, "1SyntheticTemplateDocId000000000000000000000"];
    const d = parseAssignmentDetail({
      item: response("detail.tQShAc.json"),
      materials: syn.materials.response,
      submissions: [sub],
    });
    expect(d.submission?.attachments[0]?.templateSourceId).toBe(
      "1SyntheticTemplateDocId000000000000000000000",
    );
    expect(d.materials[0]?.isTemplate).toBe(true);
  });

  it("no template link for non-Google files or different titles", () => {
    const [video] = parseMaterials(response("detail-materials.t51ITc.json")).slice(1);
    const [photo] =
      parseSubmissions(
        response("detail-submission.Zj93ge.json"),
        response("detail-attachments.Zj93ge.json"),
      )[0]?.submission.attachments ?? [];
    if (!video || !photo) throw new Error("fixture");
    const out = linkTemplates([video.attachment], [photo]);
    expect(out.materials[0]?.isTemplate).toBeUndefined();
    expect(out.attachments[0]?.templateSourceId).toBeUndefined();
  });
});

describe("toHeuristicsInput", () => {
  it("maps kinds, texts and drops teacher-annotated copies", () => {
    const syn = load("synthetic-template-copy.json");
    const d = parseAssignmentDetail({
      item: response("detail.tQShAc.json"),
      materials: syn.materials.response,
      submissions: [syn.submission.response],
    });
    const tplText = "Name: ____ Answer the questions one two three four five six.";
    const input = toHeuristicsInput(d, {
      "1SyntheticTemplateDocId000000000000000000000": tplText,
      "1SyntheticStudentCopyId0000000000000000000000": tplText,
    });
    expect(input.assignment).toMatchObject({ kind: "assignment", title: d.title });
    expect(input.assignment.materials[0]).toMatchObject({ kind: "doc", isTemplate: true });
    expect(input.submission).toMatchObject({ state: "turned_in" });
    expect(input.submission.attachments[0]?.templateSourceId).toBeTruthy();
    const res = turnedInSignals(input);
    expect(res.signals.map((s) => s.code)).toContain("template_unchanged");
    expect(res.directVerdict?.level).toBe("panic");
  });

  it("youtube → video, annotated copies left out", () => {
    const yt = parseAssignmentDetail({
      item: { ...parseItems(response("detail.tQShAc.json"))[0], id: "233229031112" },
      materials: response("materials-youtube-link.t51ITc.json"),
    });
    expect(toHeuristicsInput(yt).assignment.materials.map((m) => m.kind)).toEqual([
      "video",
      "link",
    ]);

    const p = clone(response("annotated-attachment.Zj93ge.json"));
    p[2][0][5] = 3;
    p[2][0][0][1][0] = ITEM;
    const d = parseAssignmentDetail({ item: response("detail.tQShAc.json"), submissions: [p] });
    expect(d.submission?.attachments).toHaveLength(2);
    const input = toHeuristicsInput(d, new Map());
    expect(input.submission.attachments).toHaveLength(1);
    expect(input.submission.state).toBe("returned");
  });
});
