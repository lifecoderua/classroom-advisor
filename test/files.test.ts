import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  attachmentKind,
  driveConfirmUrl,
  driveFileIdFromUrl,
  type FetchResult,
  fetchAttachment,
  fetchAttachmentContents,
  type HttpGet,
  type HttpResponse,
  officeSummaryPath,
  SessionExpiredError,
} from "../src/collector/files.ts";
import {
  type Db,
  listAttachments,
  syncAttachments,
  upsertAccount,
  upsertAssignment,
  upsertCourse,
} from "../src/store/index.ts";
import { makeDocx, makePptx, makeXlsx } from "./ooxml.ts";
import { migratedTemplate } from "./store/helpers.ts";

const ID = "1AbCdEfGhIjKlMnOp";
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const MOD = new Date("2026-10-01T08:00:00.000Z");

/** Minimal valid one-page PDF with a Helvetica text line. */
function makePdf(text: string): Buffer {
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

function res(body: string | Buffer, init: Partial<HttpResponse> & { type?: string } = {}) {
  return {
    status: init.status ?? 200,
    url: init.url ?? "https://example.invalid/",
    headers: { "content-type": init.type ?? "text/plain", ...init.headers },
    body: typeof body === "string" ? Buffer.from(body) : body,
  } satisfies HttpResponse;
}

function stub(handler: (url: string) => HttpResponse | Promise<HttpResponse>) {
  const calls: string[] = [];
  const get: HttpGet = async (url) => {
    calls.push(url);
    return handler(url);
  };
  return { get, calls };
}

function ok(r: FetchResult) {
  if (!r.ok || "metadataOnly" in r) throw new Error(`expected content, got ${JSON.stringify(r)}`);
  return r;
}

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "ca-files-"));
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

describe("helpers", () => {
  it("parses drive ids and kinds", () => {
    expect(driveFileIdFromUrl(`https://docs.google.com/document/d/${ID}/edit`)).toBe(ID);
    expect(driveFileIdFromUrl(`https://drive.google.com/open?id=${ID}`)).toBe(ID);
    expect(driveFileIdFromUrl("https://example.com/x")).toBeUndefined();
    expect(attachmentKind({ url: `https://docs.google.com/document/d/${ID}/edit` })).toBe("doc");
    expect(attachmentKind({ url: `https://docs.google.com/presentation/d/${ID}` })).toBe("slides");
    expect(attachmentKind({ url: `https://docs.google.com/spreadsheets/d/${ID}` })).toBe("sheet");
    expect(attachmentKind({ url: "https://docs.google.com/forms/d/e/x/viewform" })).toBe("form");
    expect(attachmentKind({ url: "https://youtu.be/abc" })).toBe("youtube");
    const file = `https://drive.google.com/file/d/${ID}/view`;
    expect(attachmentKind({ url: file, mime: "application/pdf" })).toBe("pdf");
    expect(attachmentKind({ url: file, mime: "image/png" })).toBe("image");
    expect(attachmentKind({ url: file })).toBe("other");
    // Classroom's internal names for Google-native files; videos are metadata only.
    expect(attachmentKind({ url: file, mime: "application/vnd.google-apps.kix" })).toBe("doc");
    expect(attachmentKind({ url: file, mime: "application/vnd.google-apps.punch" })).toBe("slides");
    expect(attachmentKind({ url: file, mime: "application/vnd.google-apps.ritz" })).toBe("sheet");
    expect(attachmentKind({ url: file, mime: "video/mp4" })).toBe("video");
    expect(attachmentKind({ url: "https://example.com/page" })).toBe("link");
  });

  it("builds the confirm url from Drive's virus-scan page", () => {
    const html = `<form id="download-form" action="https://drive.usercontent.google.com/download" method="get">
      <input type="hidden" name="id" value="${ID}"><input type="hidden" name="export" value="download">
      <input type="hidden" name="confirm" value="t"><input type="hidden" name="uuid" value="u-1"></form>`;
    const url = new URL(driveConfirmUrl(html, "https://drive.google.com/uc") ?? "");
    expect(url.host).toBe("drive.usercontent.google.com");
    expect(url.searchParams.get("confirm")).toBe("t");
    expect(url.searchParams.get("id")).toBe(ID);
    expect(driveConfirmUrl("<p>nope</p>", "https://drive.google.com/uc")).toBeUndefined();
  });
});

describe("fetchAttachment", () => {
  it("exports a Doc as text with authuser and caches by modifiedAt", async () => {
    const s = stub(() => res("Hello doc"));
    const target = { driveFileId: ID, url: "u", kind: "doc" as const, modifiedAt: MOD };
    const opts = { get: s.get, dataDir, authuser: "kid@school.example" };
    const first = ok(await fetchAttachment(target, opts));
    expect(s.calls).toEqual([
      `https://docs.google.com/document/d/${ID}/export?format=txt&authuser=kid%40school.example`,
    ]);
    expect(first.contentPath).toBe(`files/${ID}/2026-10-01T08-00-00-000Z.txt`);
    expect(first.cached).toBe(false);
    expect(readFileSync(join(dataDir, first.contentPath), "utf8")).toBe("Hello doc");
    expect(first.contentHash).toMatch(/^[0-9a-f]{64}$/);

    const second = ok(await fetchAttachment(target, opts));
    expect(s.calls).toHaveLength(1);
    expect(second).toMatchObject({ cached: true, contentHash: first.contentHash });

    const newer = ok(
      await fetchAttachment({ ...target, modifiedAt: new Date(MOD.getTime() + 1) }, opts),
    );
    expect(s.calls).toHaveLength(2);
    expect(newer.cached).toBe(false);
  });

  it("exports Sheets as csv", async () => {
    const s = stub(() => res("a,b\n1,2", { type: "text/csv" }));
    const sheet = ok(
      await fetchAttachment({ driveFileId: ID, url: "u", kind: "sheet" }, { get: s.get, dataDir }),
    );
    expect(s.calls).toEqual([`https://docs.google.com/spreadsheets/d/${ID}/export?format=csv`]);
    expect(sheet.contentPath).toBe(`files/${ID}/nomod.csv`);
  });

  it("exports Slides as pptx and stores text + structure", async () => {
    const deck = Buffer.from(
      makePptx([
        { texts: ["Тема"], transition: "fade" },
        { texts: ["Мій об'єкт"], pictures: 1, animations: ["entr", "emph"] },
      ]),
    );
    const s = stub(() => res(deck, { type: PPTX_MIME }));
    const target = { driveFileId: ID, url: "u", kind: "slides" as const, modifiedAt: MOD };
    const r = ok(await fetchAttachment(target, { get: s.get, dataDir }));
    expect(s.calls).toEqual([`https://docs.google.com/presentation/d/${ID}/export/pptx`]);
    const stem = `files/${ID}/2026-10-01T08-00-00-000Z`;
    expect(r).toMatchObject({ contentPath: `${stem}.txt`, rawPath: `${stem}.pptx` });
    expect(readFileSync(join(dataDir, r.contentPath), "utf8")).toBe("Тема\n\nМій об'єкт");
    const summary = JSON.parse(
      readFileSync(join(dataDir, officeSummaryPath(r.contentPath)), "utf8"),
    );
    expect(summary.slides[1]).toMatchObject({ pictures: 1, animations: 2 });

    const again = ok(await fetchAttachment(target, { get: s.get, dataDir }));
    expect(again).toMatchObject({ cached: true, contentPath: r.contentPath, rawPath: r.rawPath });
    expect(s.calls).toHaveLength(1);
  });

  it("falls back to the Slides text export when the pptx export fails", async () => {
    const s = stub((url) =>
      url.includes("/export/pptx") ? res(Buffer.alloc(20)) : res("Слайд 1", { type: "text/plain" }),
    );
    const r = ok(
      await fetchAttachment(
        { driveFileId: ID, url: "u", kind: "slides" },
        { get: s.get, dataDir, maxBytes: 15 },
      ),
    );
    expect(s.calls).toEqual([
      `https://docs.google.com/presentation/d/${ID}/export/pptx`,
      `https://docs.google.com/presentation/d/${ID}/export/txt`,
    ]);
    expect(r.contentPath).toBe(`files/${ID}/nomod.txt`);
    expect(r.rawPath).toBeUndefined();
  });

  it("recognizes uploaded Office files whatever the mime and extracts text", async () => {
    for (const [body, ext, text] of [
      [makeDocx(["Твір про осінь"], { images: 1 }), "docx", "Твір про осінь"],
      [makePptx([{ texts: ["Слайд"] }]), "pptx", "Слайд"],
      [makeXlsx("S", [["a", 1]]), "xlsx", "a\t1"],
    ] as const) {
      const dir = mkdtempSync(join(tmpdir(), "ca-files-office-"));
      try {
        const s = stub(() => res(Buffer.from(body), { type: "application/octet-stream" }));
        const target = { driveFileId: ID, url: "u", kind: "other" as const, modifiedAt: MOD };
        const r = ok(await fetchAttachment(target, { get: s.get, dataDir: dir }));
        const stem = `files/${ID}/2026-10-01T08-00-00-000Z`;
        expect(r).toMatchObject({ contentPath: `${stem}.txt`, rawPath: `${stem}.${ext}` });
        expect(readFileSync(join(dir, r.contentPath), "utf8")).toBe(text);
        expect(readdirSync(join(dir, "files", ID)).sort()).toEqual(
          [
            `2026-10-01T08-00-00-000Z.${ext}`,
            "2026-10-01T08-00-00-000Z.office.json",
            "2026-10-01T08-00-00-000Z.txt",
          ].sort(),
        );
        const again = ok(await fetchAttachment(target, { get: s.get, dataDir: dir }));
        expect(again).toMatchObject({
          cached: true,
          contentPath: r.contentPath,
          rawPath: r.rawPath,
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("upgrades a cached .bin that is an Office file without refetching", async () => {
    const dir = join(dataDir, "files", ID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "2026-10-01T08-00-00-000Z.bin"), makeDocx(["Старий файл"]));
    const s = stub(() => res("should not be fetched"));
    const target = { driveFileId: ID, url: "u", kind: "other" as const, modifiedAt: MOD };
    const r = ok(await fetchAttachment(target, { get: s.get, dataDir }));
    expect(s.calls).toHaveLength(0);
    expect(r).toMatchObject({
      cached: true,
      contentPath: `files/${ID}/2026-10-01T08-00-00-000Z.txt`,
      rawPath: `files/${ID}/2026-10-01T08-00-00-000Z.docx`,
    });
    expect(readFileSync(join(dataDir, r.contentPath), "utf8")).toBe("Старий файл");
  });

  it("keeps a non-Office .bin as it is", async () => {
    const dir = join(dataDir, "files", ID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "2026-10-01T08-00-00-000Z.bin"), "opaque");
    const s = stub(() => res("x"));
    const target = { driveFileId: ID, url: "u", kind: "other" as const, modifiedAt: MOD };
    const r = ok(await fetchAttachment(target, { get: s.get, dataDir }));
    expect(r).toMatchObject({
      cached: true,
      contentPath: `files/${ID}/2026-10-01T08-00-00-000Z.bin`,
    });
    expect(s.calls).toHaveLength(0);
  });

  it("rejects a Slides export that is not a pptx", async () => {
    const s = stub(() => res(Buffer.from("not a pptx"), { type: PPTX_MIME }));
    expect(
      await fetchAttachment({ driveFileId: ID, url: "u", kind: "slides" }, { get: s.get, dataDir }),
    ).toMatchObject({ ok: false, error: "Slides export is not a pptx file" });
  });

  it("refetches unversioned (nomod) files every time", async () => {
    const s = stub(() => res("x"));
    const target = { driveFileId: ID, url: "u", kind: "doc" as const };
    await fetchAttachment(target, { get: s.get, dataDir });
    await fetchAttachment(target, { get: s.get, dataDir });
    expect(s.calls).toHaveLength(2);
  });

  it("downloads a PDF and stores raw + extracted text", async () => {
    const pdf = makePdf("Hello fractions");
    const s = stub(() => res(pdf, { type: "application/pdf" }));
    const target = { driveFileId: ID, url: "u", kind: "pdf" as const, modifiedAt: MOD };
    const r = ok(await fetchAttachment(target, { get: s.get, dataDir }));
    expect(s.calls).toEqual([`https://drive.google.com/uc?export=download&id=${ID}`]);
    expect(r.contentPath).toBe(`files/${ID}/2026-10-01T08-00-00-000Z.txt`);
    expect(r.rawPath).toBe(`files/${ID}/2026-10-01T08-00-00-000Z.pdf`);
    expect(readFileSync(join(dataDir, r.contentPath), "utf8")).toContain("Hello fractions");
    expect(readFileSync(join(dataDir, r.rawPath ?? ""))).toEqual(pdf);

    const again = ok(await fetchAttachment(target, { get: s.get, dataDir }));
    expect(again).toMatchObject({ cached: true, contentPath: r.contentPath, rawPath: r.rawPath });
    expect(s.calls).toHaveLength(1);
  });

  it("extracts text from an untyped Drive file that turns out to be a PDF", async () => {
    const s = stub(() => res(makePdf("Surprise"), { type: "application/pdf" }));
    const target = { driveFileId: ID, url: "u", kind: "other" as const, modifiedAt: MOD };
    const r = ok(await fetchAttachment(target, { get: s.get, dataDir }));
    expect(r.contentPath.endsWith(".txt")).toBe(true);
    const again = ok(await fetchAttachment(target, { get: s.get, dataDir }));
    expect(again).toMatchObject({ cached: true, contentPath: r.contentPath, rawPath: r.rawPath });
  });

  it("keeps images as files in a per-file directory", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const s = stub(() => res(png, { type: "image/png" }));
    const target = { driveFileId: ID, url: "u", kind: "image" as const, modifiedAt: MOD };
    const r = ok(await fetchAttachment(target, { get: s.get, dataDir }));
    expect(r.contentPath).toBe(`files/${ID}/2026-10-01T08-00-00-000Z.png`);
    expect(readdirSync(join(dataDir, "files", ID))).toEqual(["2026-10-01T08-00-00-000Z.png"]);
    expect(ok(await fetchAttachment(target, { get: s.get, dataDir })).cached).toBe(true);
  });

  it("returns metadata only for forms, links and youtube", async () => {
    const s = stub(() => res("x"));
    for (const kind of ["form", "link", "youtube"] as const) {
      expect(await fetchAttachment({ url: "https://x", kind }, { get: s.get, dataDir })).toEqual({
        ok: true,
        kind,
        metadataOnly: true,
      });
    }
    expect(s.calls).toHaveLength(0);
  });

  it("follows Drive's large-file confirm page", async () => {
    const html = `<form id="download-form" action="https://drive.usercontent.google.com/download"><input type="hidden" name="confirm" value="t"></form>`;
    const s = stub((url) =>
      url.includes("confirm=t")
        ? res("bytes", { type: "application/octet-stream" })
        : res(html, { type: "text/html" }),
    );
    const r = ok(
      await fetchAttachment({ driveFileId: ID, url: "u", kind: "other" }, { get: s.get, dataDir }),
    );
    expect(s.calls).toHaveLength(2);
    expect(r.contentPath).toBe(`files/${ID}/nomod.bin`);
  });

  it("throws SessionExpiredError on a login redirect or login page", async () => {
    const redirect = stub(() =>
      res("<html></html>", {
        url: "https://accounts.google.com/v3/signin/identifier?x",
        type: "text/html",
      }),
    );
    await expect(
      fetchAttachment({ driveFileId: ID, url: "u", kind: "doc" }, { get: redirect.get, dataDir }),
    ).rejects.toBeInstanceOf(SessionExpiredError);
    const page = stub(() =>
      res('<form action="https://accounts.google.com/ServiceLogin">', { type: "text/html" }),
    );
    await expect(
      fetchAttachment({ driveFileId: ID, url: "u", kind: "pdf" }, { get: page.get, dataDir }),
    ).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it("records other failures instead of throwing", async () => {
    const run = (get: HttpGet, extra = {}) =>
      fetchAttachment({ driveFileId: ID, url: "u", kind: "pdf" }, { get, dataDir, ...extra });
    expect(await run(stub(() => res("nope", { status: 404 })).get)).toMatchObject({
      ok: false,
      error: "HTTP 404",
    });
    expect(await run(stub(() => res("<p>hi</p>", { type: "text/html" })).get)).toMatchObject({
      ok: false,
      error: expect.stringContaining("HTML page"),
    });
    expect(await run(stub(() => res(Buffer.alloc(11))).get, { maxBytes: 10 })).toMatchObject({
      ok: false,
      error: expect.stringContaining("too large"),
    });
    expect(await run(stub(() => res("not a pdf", { type: "application/pdf" })).get)).toMatchObject({
      ok: false,
      error: expect.stringContaining("PDF text extraction failed"),
    });
    const hang: HttpGet = () => new Promise(() => undefined);
    expect(await run(hang, { timeoutMs: 20 })).toMatchObject({
      ok: false,
      error: expect.stringContaining("timed out"),
    });
    const boom: HttpGet = () => Promise.reject(new Error("socket hang up"));
    expect(await run(boom)).toMatchObject({ ok: false, error: "socket hang up" });
    expect(
      await fetchAttachment(
        { url: "https://example.com/x", kind: "other" },
        { get: boom, dataDir },
      ),
    ).toMatchObject({ ok: false, error: "no Drive file id" });
  });
});

describe("fetchAttachmentContents", () => {
  let template: ReturnType<typeof migratedTemplate>;
  let db: Db;
  beforeAll(() => {
    template = migratedTemplate();
  }, 60_000);
  afterAll(() => template.cleanup());

  it("fetches rows and records content on the Attachment", async () => {
    db = await template.fresh();
    const account = await upsertAccount(db, { email: "student-one@school.example" });
    const course = await upsertCourse(db, {
      accountId: account.id,
      classroomId: "c1",
      name: "Math",
    });
    const { assignment } = await upsertAssignment(db, {
      accountId: account.id,
      courseId: course.id,
      classroomId: "a1",
      kind: "assignment",
      title: "Fractions",
      status: "assigned",
      hash: "h1",
      payload: {},
    });
    const rows = await syncAttachments(db, { owner: "material", assignmentId: assignment.id }, [
      { url: `https://docs.google.com/document/d/${ID}/edit`, modifiedAt: MOD },
      { url: "https://docs.google.com/forms/d/e/form1/viewform" },
      { url: "https://drive.google.com/file/d/1ZzZzZzZzZzZzZzZz/view", mime: "application/pdf" },
    ]);
    const s = stub((url) => (url.includes("uc?") ? res("x", { status: 403 }) : res("Doc body")));
    const out = await fetchAttachmentContents(db, rows, { get: s.get, dataDir });
    expect(out.map((o) => o.result.ok)).toEqual([true, true, false]);
    const stored = await listAttachments(db, assignment.id);
    expect(stored[0]?.contentPath).toBe(`files/${ID}/2026-10-01T08-00-00-000Z.txt`);
    expect(stored[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored[0]?.fetchedAt).not.toBeNull();
    expect(stored[1]?.contentPath).toBeNull();
    expect(stored[2]?.contentPath).toBeNull();
  }, 30_000);
});
