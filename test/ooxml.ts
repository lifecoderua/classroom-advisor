// Synthetic OOXML builders for tests: minimal pptx/docx/xlsx zips made with fflate.

import { strToU8, zipSync } from "fflate";

const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const NS_S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_MC = "http://schemas.openxmlformats.org/markup-compatibility/2006";
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function zip(files: Record<string, string>): Uint8Array {
  const out: Record<string, Uint8Array> = {};
  for (const [name, body] of Object.entries(files)) out[name] = strToU8(body);
  return zipSync(out);
}

export interface SlideSpec {
  /** One text box per entry; `\n` inside becomes an `a:br`. */
  texts?: string[];
  pictures?: number;
  /** Preset class per effect (`entr`, `emph`, `exit`, `path`, or anything else). */
  animations?: string[];
  /** Transition effect element name (`fade`, `push`...). */
  transition?: string;
}

let shapeId = 10;

function textShape(text: string): string {
  const runs = text
    .split("\n")
    .map((t) => `<a:r><a:rPr lang="uk-UA"/><a:t>${esc(t)}</a:t></a:r>`)
    .join("<a:br/>");
  return `<p:sp><p:nvSpPr><p:cNvPr id="${shapeId++}" name="TextBox"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p>${runs}</a:p><a:p><a:endParaRPr/></a:p></p:txBody></p:sp>`;
}

function picture(i: number): string {
  return `<p:pic><p:nvPicPr><p:cNvPr id="${shapeId++}" name="Picture ${i}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId${i + 2}"/></p:blipFill><p:spPr/></p:pic>`;
}

function effect(cls: string, id: number): string {
  // Click-group → with-previous → effect node, as PowerPoint and Google Slides write it.
  return `<p:par><p:cTn id="${id}" fill="hold"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst><p:childTnLst><p:par><p:cTn id="${id + 1}" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst><p:par><p:cTn id="${id + 2}" presetID="10" presetClass="${cls}" presetSubtype="0" fill="hold" nodeType="clickEffect"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst><p:animEffect transition="in" filter="fade"><p:cBhvr><p:cTn id="${id + 3}" dur="500"/><p:tgtEl><p:spTgt spid="10"/></p:tgtEl></p:cBhvr></p:animEffect></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>`;
}

function timing(classes: string[]): string {
  if (classes.length === 0) return "";
  const effects = classes.map((c, i) => effect(c, 3 + i * 4)).join("");
  return `<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst><p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>${effects}</p:childTnLst></p:cTn><p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst></p:seq></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>`;
}

function transition(name: string | undefined): string {
  if (!name) return "";
  const t = `<p:transition spd="slow"><p:${name}/></p:transition>`;
  return `<mc:AlternateContent xmlns:mc="${NS_MC}"><mc:Choice xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" Requires="p14">${t}</mc:Choice><mc:Fallback>${t}</mc:Fallback></mc:AlternateContent>`;
}

export function slideXml(s: SlideSpec): string {
  const shapes = (s.texts ?? []).map(textShape).join("");
  const pics = Array.from({ length: s.pictures ?? 0 }, (_, i) => picture(i + 1)).join("");
  return `${XML}<p:sld xmlns:a="${NS_A}" xmlns:p="${NS_P}" xmlns:r="${NS_R}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes}${pics}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>${transition(s.transition)}${timing(s.animations ?? [])}</p:sld>`;
}

/**
 * A pptx with the given slides. `order` lists file numbers (1-based) in presentation order, to
 * check that `p:sldIdLst` wins over file names; defaults to 1..n.
 */
export function makePptx(slides: SlideSpec[], order?: number[]): Uint8Array {
  const files: Record<string, string> = {
    "[Content_Types].xml": `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
  };
  const nums = order ?? slides.map((_, i) => i + 1);
  const rels = slides
    .map(
      (_, i) =>
        `<Relationship Id="rId${i + 10}" Type="${NS_R}/slide" Target="slides/slide${i + 1}.xml"/>`,
    )
    .join("");
  files["ppt/_rels/presentation.xml.rels"] =
    `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`;
  const ids = nums.map((n, i) => `<p:sldId id="${256 + i}" r:id="rId${n + 9}"/>`).join("");
  files["ppt/presentation.xml"] =
    `${XML}<p:presentation xmlns:a="${NS_A}" xmlns:p="${NS_P}" xmlns:r="${NS_R}"><p:sldIdLst>${ids}</p:sldIdLst></p:presentation>`;
  slides.forEach((s, i) => {
    files[`ppt/slides/slide${i + 1}.xml`] = slideXml(s);
  });
  return zip(files);
}

export function makeDocx(paragraphs: string[], opts: { images?: number; tables?: number } = {}) {
  const paras = paragraphs
    .map((p) => {
      const [first, ...rest] = p.split("\t");
      const runs = [first ?? "", ...rest]
        .map((t) => `<w:r><w:t xml:space="preserve">${esc(t)}</w:t></w:r>`)
        .join("<w:r><w:tab/></w:r>");
      return `<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr>${runs}</w:p>`;
    })
    .join("");
  const images = Array.from(
    { length: opts.images ?? 0 },
    () =>
      `<w:p><w:r><w:drawing><wp:inline xmlns:wp="x"><a:graphic xmlns:a="${NS_A}"/></wp:inline></w:drawing></w:r></w:p>`,
  ).join("");
  const tables = Array.from(
    { length: opts.tables ?? 0 },
    () => `<w:tbl><w:tr><w:tc><w:p><w:r><w:t>cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`,
  ).join("");
  return zip({
    "[Content_Types].xml": `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
    "word/document.xml": `${XML}<w:document xmlns:w="${NS_W}"><w:body>${paras}${images}${tables}<w:sectPr/></w:body></w:document>`,
  });
}

/** One sheet; strings go through sharedStrings, numbers stay inline. */
export function makeXlsx(name: string, rows: (string | number)[][]): Uint8Array {
  const shared: string[] = [];
  const rowXml = rows
    .map((r, ri) => {
      const cells = r
        .map((v, ci) => {
          const ref = `${String.fromCharCode(65 + ci)}${ri + 1}`;
          if (typeof v === "number") return `<c r="${ref}"><v>${v}</v></c>`;
          shared.push(v);
          return `<c r="${ref}" t="s"><v>${shared.length - 1}</v></c>`;
        })
        .join("");
      return `<row r="${ri + 1}">${cells}</row>`;
    })
    .join("");
  return zip({
    "[Content_Types].xml": `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
    "xl/workbook.xml": `${XML}<workbook xmlns="${NS_S}" xmlns:r="${NS_R}"><sheets><sheet name="${esc(name)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${NS_R}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    "xl/sharedStrings.xml": `${XML}<sst xmlns="${NS_S}">${shared.map((s) => `<si><t>${esc(s)}</t></si>`).join("")}</sst>`,
    "xl/worksheets/sheet1.xml": `${XML}<worksheet xmlns="${NS_S}"><sheetData>${rowXml}</sheetData></worksheet>`,
  });
}
