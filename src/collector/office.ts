// OOXML (pptx/docx/xlsx) detection, text extraction and a compact structure summary (#38).
// Zip via fflate, XML via a small tag scanner: we only need text runs and element counts.

import { unzipSync } from "fflate";

export const OFFICE_FORMATS = ["pptx", "docx", "xlsx"] as const;
export type OfficeFormat = (typeof OFFICE_FORMATS)[number];

/** Animation preset classes we count as effects (`p:cTn presetClass`). */
export const ANIMATION_CLASSES = ["entr", "emph", "exit", "path"] as const;
export type AnimationClass = (typeof ANIMATION_CLASSES)[number];

export interface SlideSummary {
  /** 1-based, in presentation order. */
  index: number;
  text: string;
  /** `p:pic` elements (photos, clip art). */
  pictures: number;
  /** Shapes, connectors and graphic frames (tables, charts), pictures excluded. */
  shapes: number;
  /** Animation effects (`p:cTn` with an entr/emph/exit/path preset class). */
  animations: number;
  /** Effect count per preset class, e.g. `{ entr: 2, emph: 1 }`. */
  animationClasses: Partial<Record<AnimationClass, number>>;
  /** Transition effect name (`fade`, `push`...), `"yes"` when present without a named effect. */
  transition?: string;
}

export interface PptxSummary {
  format: "pptx";
  slides: SlideSummary[];
}

export interface DocxSummary {
  format: "docx";
  text: string;
  /** Inline/anchored drawings and VML pictures. */
  images: number;
  tables: number;
}

export interface XlsxSummary {
  format: "xlsx";
  sheets: { name: string; text: string; cells: number }[];
}

export type OfficeSummary = PptxSummary | DocxSummary | XlsxSummary;

/** Each XML part we read is capped (zip-bomb guard). */
const MAX_PART_BYTES = 32 * 1024 * 1024;

const MARKERS: ReadonlyArray<[string, OfficeFormat]> = [
  ["ppt/presentation.xml", "pptx"],
  ["word/document.xml", "docx"],
  ["xl/workbook.xml", "xlsx"],
];

function isZip(body: Uint8Array): boolean {
  return body.length > 4 && body[0] === 0x50 && body[1] === 0x4b && body[2] === 3 && body[3] === 4;
}

/** OOXML format of a file by its zip contents (mime types lie; legacy .ppt/.doc are not zips). */
export function officeFormat(body: Uint8Array): OfficeFormat | undefined {
  if (!isZip(body)) return undefined;
  const names = new Set<string>();
  try {
    unzipSync(body, {
      filter: (f) => {
        names.add(f.name);
        return false;
      },
    });
  } catch {
    return undefined;
  }
  return MARKERS.find(([name]) => names.has(name))?.[1];
}

type Parts = Record<string, string>;

function readParts(body: Uint8Array, want: (name: string) => boolean): Parts {
  const files = unzipSync(body, {
    filter: (f) => want(f.name) && f.originalSize <= MAX_PART_BYTES,
  });
  const dec = new TextDecoder();
  const out: Parts = {};
  for (const [name, data] of Object.entries(files)) out[name] = dec.decode(data);
  return out;
}

// ---------------------------------------------------------------------------------------------
// XML helpers

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

const TAG = /<(\/?)([A-Za-z_][\w.:-]*)([^>]*?)(\/?)>|([^<]+)/g;

interface TextRules {
  /** Element holding text runs (`a:t`, `w:t`). */
  text: string;
  /** Element whose end is a line break (`a:p`, `w:p`). */
  para: string;
  /** Self-closing elements rendered as `\t` / `\n`. */
  tab?: string;
  br?: string;
}

/** Text of an XML part: text runs joined per paragraph, one paragraph per line, blank lines dropped. */
export function xmlText(xml: string, rules: TextRules): string {
  const lines: string[] = [];
  let line = "";
  let depth = 0;
  for (const m of xml.matchAll(TAG)) {
    const [, close, name, , selfClose, chars] = m;
    if (chars !== undefined) {
      if (depth > 0) line += decodeXml(chars);
      continue;
    }
    if (name === rules.text) {
      if (selfClose) continue;
      depth += close ? -1 : 1;
      if (depth < 0) depth = 0;
    } else if (name === rules.tab && !close) line += "\t";
    else if (name === rules.br && !close) line += "\n";
    else if (name === rules.para && (close || selfClose)) {
      lines.push(line);
      line = "";
    }
  }
  if (line) lines.push(line);
  return lines
    .map((l) => l.replace(/[ \t]+$/g, ""))
    .filter((l) => l.trim())
    .join("\n");
}

function count(xml: string, re: RegExp): number {
  return xml.match(re)?.length ?? 0;
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m?.[1];
}

/** `Target` by `Id` from a `.rels` part. */
function relTargets(rels: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of rels?.matchAll(/<Relationship\b[^>]*>/g) ?? []) {
    const id = attr(m[0], "Id");
    const target = attr(m[0], "Target");
    if (id && target) out.set(id, target);
  }
  return out;
}

/** Resolves a relationship target against the directory of its source part. */
function resolvePart(baseDir: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = baseDir.split("/").filter(Boolean);
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

const byNumber = (a: string, b: string) =>
  Number(/(\d+)\.xml$/.exec(a)?.[1] ?? 0) - Number(/(\d+)\.xml$/.exec(b)?.[1] ?? 0);

// ---------------------------------------------------------------------------------------------
// pptx

const SLIDE_PART = /^ppt\/slides\/slide\d+\.xml$/;

/** Slide part names in presentation order (`p:sldIdLst`), falling back to file numbering. */
function slideOrder(parts: Parts): string[] {
  const found = Object.keys(parts).filter((n) => SLIDE_PART.test(n));
  const rels = relTargets(parts["ppt/_rels/presentation.xml.rels"]);
  const list = /<p:sldIdLst>([\s\S]*?)<\/p:sldIdLst>/.exec(parts["ppt/presentation.xml"] ?? "");
  const ordered: string[] = [];
  for (const m of list?.[1]?.matchAll(/<p:sldId\b[^>]*>/g) ?? []) {
    const rid = attr(m[0], "r:id");
    const target = rid && rels.get(rid);
    const name = target && resolvePart("ppt", target);
    if (name && parts[name] !== undefined && !ordered.includes(name)) ordered.push(name);
  }
  return ordered.length ? ordered : found.sort(byNumber);
}

const TRANSITION = /<p:transition\b[^>]*?(\/?)>([\s\S]*?)(?:<\/p:transition>|$)/;

function transitionOf(xml: string): string | undefined {
  const m = TRANSITION.exec(xml);
  if (!m) return undefined;
  if (m[1]) return "yes";
  // First child element that is an effect (skip sound actions and extension lists).
  for (const c of (m[2] ?? "").matchAll(/<([A-Za-z]+):([A-Za-z]+)\b/g)) {
    const local = c[2] ?? "";
    if (local !== "sndAc" && local !== "extLst" && local !== "stSnd" && local !== "endSnd") {
      return local;
    }
  }
  return "yes";
}

export function slideSummary(xml: string, index: number): SlideSummary {
  // Animations live in p:timing; Google Slides and PowerPoint both use presetClass on p:cTn.
  const timing = /<p:timing\b[\s\S]*?<\/p:timing>/.exec(xml)?.[0] ?? "";
  const animationClasses: Partial<Record<AnimationClass, number>> = {};
  let animations = 0;
  for (const m of timing.matchAll(/<p:cTn\b[^>]*>/g)) {
    const cls = attr(m[0], "presetClass") as AnimationClass | undefined;
    if (!cls || !ANIMATION_CLASSES.includes(cls)) continue;
    animations++;
    animationClasses[cls] = (animationClasses[cls] ?? 0) + 1;
  }
  // Text and shapes only from the shape tree (not from timing or alternate-content fallbacks).
  const tree = /<p:spTree\b[\s\S]*<\/p:spTree>/.exec(xml)?.[0] ?? "";
  const transition = transitionOf(xml);
  return {
    index,
    text: xmlText(tree, { text: "a:t", para: "a:p", br: "a:br" }),
    pictures: count(tree, /<p:pic[\s>]/g),
    shapes: count(tree, /<p:(?:sp|cxnSp|graphicFrame)[\s>]/g),
    animations,
    animationClasses,
    ...(transition ? { transition } : {}),
  };
}

export function extractPptx(body: Uint8Array): PptxSummary {
  const parts = readParts(
    body,
    (n) =>
      n === "ppt/presentation.xml" || n === "ppt/_rels/presentation.xml.rels" || SLIDE_PART.test(n),
  );
  const slides = slideOrder(parts).map((name, i) => slideSummary(parts[name] ?? "", i + 1));
  return { format: "pptx", slides };
}

// ---------------------------------------------------------------------------------------------
// docx

export function extractDocx(body: Uint8Array): DocxSummary {
  const xml = readParts(body, (n) => n === "word/document.xml")["word/document.xml"] ?? "";
  const bodyXml = /<w:body\b[\s\S]*<\/w:body>/.exec(xml)?.[0] ?? xml;
  return {
    format: "docx",
    text: xmlText(bodyXml, { text: "w:t", para: "w:p", tab: "w:tab", br: "w:br" }),
    images: count(bodyXml, /<w:drawing[\s>]/g) + count(bodyXml, /<w:pict[\s>]/g),
    tables: count(bodyXml, /<w:tbl[\s>]/g),
  };
}

// ---------------------------------------------------------------------------------------------
// xlsx

export function extractXlsx(body: Uint8Array): XlsxSummary {
  const parts = readParts(
    body,
    (n) =>
      n === "xl/workbook.xml" ||
      n === "xl/_rels/workbook.xml.rels" ||
      n === "xl/sharedStrings.xml" ||
      /^xl\/worksheets\/sheet\d+\.xml$/.test(n),
  );
  const shared: string[] = [];
  for (const m of (parts["xl/sharedStrings.xml"] ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    shared.push(xmlText(`<x:p>${m[1] ?? ""}</x:p>`, { text: "t", para: "x:p" }));
  }
  const rels = relTargets(parts["xl/_rels/workbook.xml.rels"]);
  const sheetRefs: { name: string; part: string }[] = [];
  for (const m of (parts["xl/workbook.xml"] ?? "").matchAll(/<sheet\b[^>]*>/g)) {
    const rid = attr(m[0], "r:id");
    const target = rid && rels.get(rid);
    if (target) {
      sheetRefs.push({
        name: decodeXml(attr(m[0], "name") ?? ""),
        part: resolvePart("xl", target),
      });
    }
  }
  if (sheetRefs.length === 0) {
    for (const part of Object.keys(parts).filter((n) => n.startsWith("xl/worksheets/"))) {
      sheetRefs.push({ name: part.replace(/^.*\//, "").replace(/\.xml$/, ""), part });
    }
  }
  const sheets = sheetRefs.map(({ name, part }) => {
    const rows: string[] = [];
    let cells = 0;
    for (const r of (parts[part] ?? "").matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const values: string[] = [];
      for (const c of (r[1] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const type = attr(c[1] ?? "", "t");
        const inner = c[2] ?? "";
        let v: string | undefined;
        if (type === "inlineStr") v = xmlText(`<x:p>${inner}</x:p>`, { text: "t", para: "x:p" });
        else {
          const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
          if (raw !== undefined) v = type === "s" ? shared[Number(raw)] : decodeXml(raw);
        }
        if (v?.trim()) {
          values.push(v.trim());
          cells++;
        }
      }
      if (values.length) rows.push(values.join("\t"));
    }
    return { name, text: rows.join("\n"), cells };
  });
  return { format: "xlsx", sheets };
}

/** Extracts the summary of an OOXML file; throws on a broken zip. */
export function extractOffice(body: Uint8Array, format: OfficeFormat): OfficeSummary {
  switch (format) {
    case "pptx":
      return extractPptx(body);
    case "docx":
      return extractDocx(body);
    case "xlsx":
      return extractXlsx(body);
  }
}

// ---------------------------------------------------------------------------------------------
// Rendering

/** Plain text of the file (what heuristics compare and count words in). */
export function officePlainText(s: OfficeSummary): string {
  switch (s.format) {
    case "pptx":
      return s.slides
        .map((x) => x.text)
        .filter(Boolean)
        .join("\n\n");
    case "docx":
      return s.text;
    case "xlsx":
      return s.sheets
        .map((x) => x.text)
        .filter(Boolean)
        .join("\n\n");
  }
}

/** Text for the LLM: like the plain text, with slide/sheet headers so parts can be referenced. */
export function officeLabelledText(s: OfficeSummary): string {
  switch (s.format) {
    case "pptx":
      return s.slides.map((x) => `[slide ${x.index}]\n${x.text}`.trimEnd()).join("\n\n");
    case "docx":
      return s.text;
    case "xlsx":
      return s.sheets.map((x) => `[sheet ${x.name}]\n${x.text}`.trimEnd()).join("\n\n");
  }
}

export interface OfficeStats {
  slides: number;
  pictures: number;
  shapes: number;
  animations: number;
  slidesWithTransition: number;
}

export function officeStats(s: OfficeSummary): OfficeStats {
  if (s.format === "pptx") {
    return {
      slides: s.slides.length,
      pictures: s.slides.reduce((n, x) => n + x.pictures, 0),
      shapes: s.slides.reduce((n, x) => n + x.shapes, 0),
      animations: s.slides.reduce((n, x) => n + x.animations, 0),
      slidesWithTransition: s.slides.filter((x) => x.transition).length,
    };
  }
  return {
    slides: 0,
    pictures: s.format === "docx" ? s.images : 0,
    shapes: 0,
    animations: 0,
    slidesWithTransition: 0,
  };
}

function classList(c: Partial<Record<AnimationClass, number>>): string {
  return ANIMATION_CLASSES.filter((k) => c[k])
    .map((k) => `${k} ${c[k]}`)
    .join(", ");
}

/**
 * Compact structure lines for the LLM: totals, then one line per slide with picture, shape and
 * animation counts and the transition. No text (that goes in `text`).
 */
export function officeStructure(s: OfficeSummary): string {
  switch (s.format) {
    case "pptx": {
      const t = officeStats(s);
      const all: Partial<Record<AnimationClass, number>> = {};
      for (const x of s.slides) {
        for (const k of ANIMATION_CLASSES) {
          if (x.animationClasses[k]) all[k] = (all[k] ?? 0) + (x.animationClasses[k] ?? 0);
        }
      }
      const head =
        `presentation: ${t.slides} slides, ${t.pictures} pictures, ${t.shapes} shapes, ` +
        `${t.animations} animation effects${t.animations ? ` (${classList(all)})` : ""}, ` +
        `transitions on ${t.slidesWithTransition} slides`;
      const lines = s.slides.map((x) => {
        const bits = [`${x.pictures} pictures`, `${x.shapes} shapes`];
        bits.push(
          x.animations
            ? `${x.animations} animations (${classList(x.animationClasses)})`
            : "no animations",
        );
        bits.push(x.transition ? `transition ${x.transition}` : "no transition");
        return `slide ${x.index}: ${bits.join(", ")}`;
      });
      return [head, ...lines].join("\n");
    }
    case "docx":
      return `document: ${s.images} images, ${s.tables} tables`;
    case "xlsx":
      return `workbook: ${s.sheets.length} sheets (${s.sheets
        .map((x) => `${x.name}: ${x.cells} filled cells`)
        .join("; ")})`;
  }
}

/** Light shape check for summaries read back from disk. */
export function isOfficeSummary(v: unknown): v is OfficeSummary {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (o.format === "pptx") return Array.isArray(o.slides);
  if (o.format === "docx") return typeof o.text === "string";
  if (o.format === "xlsx") return Array.isArray(o.sheets);
  return false;
}
