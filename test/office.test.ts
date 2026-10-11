import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  decodeXml,
  extractOffice,
  isOfficeSummary,
  officeFormat,
  officeLabelledText,
  officePlainText,
  officeStats,
  officeStructure,
  type PptxSummary,
  xmlText,
} from "../src/collector/office.ts";
import { makeDocx, makePptx, makeXlsx } from "./ooxml.ts";

const pptx = () =>
  makePptx(
    [
      { texts: ["Анімація об'єктів", "Тема & план"], transition: "fade" },
      { texts: ["Мій об'єкт"], pictures: 2, animations: ["entr", "entr", "emph", "path"] },
      { texts: [] },
    ],
    // Slide files 2, 1, 3 in presentation order.
    [2, 1, 3],
  );

describe("officeFormat", () => {
  it("detects pptx/docx/xlsx by zip contents, not mime", () => {
    expect(officeFormat(pptx())).toBe("pptx");
    expect(officeFormat(makeDocx(["x"]))).toBe("docx");
    expect(officeFormat(makeXlsx("S", [["x"]]))).toBe("xlsx");
  });

  it("rejects non-zips, other zips and broken zips", () => {
    expect(officeFormat(strToU8("plain text"))).toBeUndefined();
    expect(officeFormat(zipSync({ "a.txt": strToU8("x") }))).toBeUndefined();
    // Legacy .ppt (OLE compound file) is not OOXML.
    expect(officeFormat(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).toBe(
      undefined,
    );
    const broken = pptx().slice(0, 40);
    expect(officeFormat(broken)).toBeUndefined();
  });
});

describe("pptx", () => {
  it("summarises slides in presentation order with pictures, animations and transitions", () => {
    const s = extractOffice(pptx(), "pptx") as PptxSummary;
    expect(s.slides).toHaveLength(3);
    const [first, second, third] = s.slides;
    // sldIdLst puts slide2.xml first.
    expect(first).toMatchObject({
      index: 1,
      text: "Мій об'єкт",
      pictures: 2,
      shapes: 1,
      animations: 4,
      animationClasses: { entr: 2, emph: 1, path: 1 },
    });
    expect(first?.transition).toBeUndefined();
    expect(second).toMatchObject({
      index: 2,
      text: "Анімація об'єктів\nТема & план",
      pictures: 0,
      shapes: 2,
      animations: 0,
      transition: "fade",
    });
    expect(third).toMatchObject({ index: 3, text: "", shapes: 0, animations: 0 });
    expect(officeStats(s)).toEqual({
      slides: 3,
      pictures: 2,
      shapes: 3,
      animations: 4,
      slidesWithTransition: 1,
    });
  });

  it("ignores non-effect timing nodes and unknown preset classes", () => {
    const s = extractOffice(
      makePptx([{ texts: ["a"], animations: ["entr", "verb", "mediacall", "exit"] }]),
      "pptx",
    ) as PptxSummary;
    expect(s.slides[0]).toMatchObject({ animations: 2, animationClasses: { entr: 1, exit: 1 } });
  });

  it("keeps line breaks inside a paragraph", () => {
    const s = extractOffice(makePptx([{ texts: ["рядок 1\nрядок 2"] }]), "pptx") as PptxSummary;
    expect(s.slides[0]?.text).toBe("рядок 1\nрядок 2");
  });

  it("falls back to file numbering without a slide list", () => {
    const files = {
      "ppt/presentation.xml": strToU8("<p:presentation/>"),
      "ppt/slides/slide10.xml": strToU8(
        "<p:spTree><a:p><a:r><a:t>ten</a:t></a:r></a:p></p:spTree>",
      ),
      "ppt/slides/slide2.xml": strToU8("<p:spTree><a:p><a:r><a:t>two</a:t></a:r></a:p></p:spTree>"),
    };
    const s = extractOffice(zipSync(files), "pptx") as PptxSummary;
    expect(s.slides.map((x) => x.text)).toEqual(["two", "ten"]);
  });

  it("renders plain text, labelled text and a compact structure", () => {
    const s = extractOffice(pptx(), "pptx");
    expect(officePlainText(s)).toBe("Мій об'єкт\n\nАнімація об'єктів\nТема & план");
    expect(officeLabelledText(s)).toBe(
      "[slide 1]\nМій об'єкт\n\n[slide 2]\nАнімація об'єктів\nТема & план\n\n[slide 3]",
    );
    expect(officeStructure(s)).toBe(
      [
        "presentation: 3 slides, 2 pictures, 3 shapes, 4 animation effects (entr 2, emph 1, path 1), transitions on 1 slides",
        "slide 1: 2 pictures, 1 shapes, 4 animations (entr 2, emph 1, path 1), no transition",
        "slide 2: 0 pictures, 2 shapes, no animations, transition fade",
        "slide 3: 0 pictures, 0 shapes, no animations, no transition",
      ].join("\n"),
    );
  });
});

describe("docx and xlsx", () => {
  it("extracts docx text with tabs, images and tables", () => {
    const s = extractOffice(
      makeDocx(["Перший абзац", "a\tb", ""], { images: 2, tables: 1 }),
      "docx",
    );
    expect(s).toMatchObject({ format: "docx", images: 2, tables: 1 });
    expect(officePlainText(s)).toBe("Перший абзац\na\tb\ncell");
    expect(officeStructure(s)).toBe("document: 2 images, 1 tables");
  });

  it("extracts xlsx cells via shared strings", () => {
    const s = extractOffice(
      makeXlsx("Лист 1", [
        ["Ім'я", "Бал"],
        ["A & B", 12],
      ]),
      "xlsx",
    );
    expect(officePlainText(s)).toBe("Ім'я\tБал\nA & B\t12");
    expect(officeStructure(s)).toBe("workbook: 1 sheets (Лист 1: 4 filled cells)");
    expect(officeLabelledText(s)).toContain("[sheet Лист 1]");
  });
});

describe("xml helpers", () => {
  it("decodes entities", () => {
    expect(decodeXml("&lt;a&gt; &amp; &quot;&apos; &#1078; &#x416;")).toBe("<a> & \"' ж Ж");
  });

  it("only collects text inside text runs", () => {
    const xml =
      '<a:p><a:pPr algn="l"/><a:r><a:t>a</a:t></a:r><a:fld><a:t>b</a:t></a:fld></a:p>noise<a:p/><a:p><a:r><a:t xml:space="preserve"> c </a:t></a:r></a:p>';
    expect(xmlText(xml, { text: "a:t", para: "a:p" })).toBe("ab\n c");
  });

  it("validates summaries read from disk", () => {
    expect(isOfficeSummary({ format: "pptx", slides: [] })).toBe(true);
    expect(isOfficeSummary({ format: "docx" })).toBe(false);
    expect(isOfficeSummary(null)).toBe(false);
  });
});
