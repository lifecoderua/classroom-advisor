import { describe, expect, it } from "vitest";
import {
  addedWordCount,
  expectedPartsFromInstructions,
  type HeuristicAttachment,
  type HeuristicMaterial,
  kindFromMime,
  type Signal,
  similarity,
  structureAdded,
  type TurnedInInput,
  tokenize,
  turnedInSignals,
} from "../../src/checks/heuristics.ts";
import type { PptxSummary, SlideSummary } from "../../src/collector/office.ts";

// Synthetic samples only.
const TEMPLATE_UK =
  "Робочий аркуш. Прочитай текст і дай відповіді на запитання. " +
  "1. Хто головний герой оповідання? Відповідь: ____ " +
  "2. Де відбуваються події? Відповідь: ____ " +
  "3. Що тобі найбільше сподобалося? Відповідь: ____";
const FILLED_UK = TEMPLATE_UK.replace(
  /____/g,
  "головний герой це маленький їжачок який шукав дорогу додому через темний ліс разом із друзями",
);

const template = (over: Partial<HeuristicMaterial> = {}): HeuristicMaterial => ({
  kind: "doc",
  title: "Робочий аркуш",
  driveFileId: "tpl-1",
  text: TEMPLATE_UK,
  isTemplate: true,
  ...over,
});
const doc = (text: string | undefined, over: Partial<HeuristicAttachment> = {}) => ({
  kind: "doc",
  title: "Учень - Робочий аркуш",
  text,
  ...over,
});
const photo: HeuristicAttachment = { kind: "image", title: "IMG_0001.jpg", bytes: 120_000 };
const link: HeuristicMaterial = { kind: "link", title: "Тест" };

type Over = {
  assignment?: Partial<TurnedInInput["assignment"]>;
  submission?: Partial<TurnedInInput["submission"]>;
};
function input(over: Over = {}): TurnedInInput {
  return {
    assignment: {
      kind: "assignment",
      title: "Читання",
      instructions: "",
      materials: [],
      ...over.assignment,
    },
    submission: { state: "turned_in", attachments: [], ...over.submission },
  };
}

const find = (signals: Signal[], code: string) => signals.filter((s) => s.code === code);
const one = (signals: Signal[], code: string) => {
  const found = find(signals, code);
  expect(found, code).toHaveLength(1);
  return found[0] as Signal;
};

describe("text helpers", () => {
  it("tokenizes Ukrainian with apostrophes", () => {
    expect(tokenize("П’ять м'ячів, сім’я!")).toEqual(["пять", "мячів", "сімя"]);
  });

  it.each([
    ["identical", TEMPLATE_UK, TEMPLATE_UK, 1, 1],
    ["case/punctuation only", TEMPLATE_UK, TEMPLATE_UK.toUpperCase().replace(/\./g, "!"), 1, 1],
    ["filled in", TEMPLATE_UK, FILLED_UK, 0, 0.7],
    ["unrelated", "Котик спить на дивані", "Математика: два плюс два", 0, 0],
    ["both empty", "", "  ", 1, 1],
  ])("similarity: %s", (_name, a, b, min, max) => {
    const s = similarity(a, b);
    expect(s).toBeGreaterThanOrEqual(min);
    expect(s).toBeLessThanOrEqual(max);
  });

  it("counts only words not in the base", () => {
    expect(addedWordCount("один два три", "один два")).toBe(1);
    expect(addedWordCount("так так так", "так")).toBe(2);
    expect(addedWordCount("hello world")).toBe(2);
  });

  it.each([
    ["Надішли 3 фото виконаних вправ", 3],
    ["Виконай 2 завдання на сторінці 45", 2],
    ["Send 4 photos of pages", 4],
    ["Виконай вправу 5 на ст. 45", 0],
    ["Завдання:\n1. Прочитай текст\n2) Дай відповіді\n3. Намалюй малюнок", 3],
    ["Do 99 tasks", 10],
    ["", 0],
  ])("expected parts: %j → %i", (text, n) => {
    expect(expectedPartsFromInstructions(text)).toBe(n);
  });

  it.each([
    ["application/vnd.google-apps.document", "", "doc"],
    ["application/vnd.google-apps.spreadsheet", "", "sheet"],
    ["application/vnd.google-apps.form", "", "form"],
    ["application/pdf", "", "pdf"],
    ["image/jpeg", "", "image"],
    [null, "https://www.youtube.com/watch?v=x", "video"],
    [null, "https://docs.google.com/forms/d/x", "form"],
    [null, "https://naurok.example/test", "link"],
    ["application/zip", "", "file"],
  ])("kindFromMime(%s, %s) = %s", (mime, url, kind) => {
    expect(kindFromMime(mime, url)).toBe(kind);
  });
});

describe("turnedInSignals: no attachments", () => {
  it.each<[string, Over, number, number]>([
    [
      "asks for a photo (uk)",
      { assignment: { instructions: "Виконай вправу 3 у зошиті і надішли фото." } },
      0.7,
      0.8,
    ],
    [
      "asks to attach (en)",
      { assignment: { instructions: "Please attach your essay." } },
      0.7,
      0.8,
    ],
    ["template provided", { assignment: { materials: [template()] } }, 0.8, 0.95],
    [
      "online test on an external site",
      { assignment: { instructions: "Пройди тест на Naurok за посиланням.", materials: [link] } },
      0.05,
      0.1,
    ],
    ["quiz kind", { assignment: { kind: "quiz", instructions: "Дай відповіді." } }, 0.2, 0.2],
    ["question post", { assignment: { kind: "question", instructions: "Скільки?" } }, 0.2, 0.2],
    ["no instructions, no materials", {}, 0.25, 0.25],
    ["plain lesson post", { assignment: { instructions: "Тема уроку: Дроби." } }, 0.5, 0.5],
  ])("%s", (_name, over, min, max) => {
    const { signals, directVerdict } = turnedInSignals(input(over));
    const s = one(signals, "no_attachments");
    expect(s.confidence).toBeGreaterThanOrEqual(min);
    expect(s.confidence).toBeLessThanOrEqual(max);
    expect(directVerdict).toBeUndefined();
  });
});

describe("turnedInSignals: kind hints", () => {
  it.each<[string, Over, string[]]>([
    ["quiz kind", { assignment: { kind: "quiz" } }, ["quiz"]],
    [
      "form material",
      { assignment: { materials: [{ kind: "form", title: "Форма" }] } },
      ["quiz", "link_only"],
    ],
    [
      "online test keyword + link only",
      { assignment: { title: "Онлайн-тест з природознавства", materials: [link] } },
      ["online_test", "link_only"],
    ],
    ["english test", { assignment: { instructions: "Take the online quiz." } }, ["online_test"]],
    ["plain homework", { assignment: { instructions: "Виконай вправу 3." } }, []],
  ])("%s", (_name, over, hints) => {
    const { signals } = turnedInSignals(input(over));
    expect(find(signals, "kind_hint").map((s) => s.detail)).toEqual(hints);
  });

  it("material posts get only the hint", () => {
    const { signals } = turnedInSignals(input({ assignment: { kind: "material" } }));
    expect(signals).toEqual([{ code: "kind_hint", confidence: 1, detail: "material" }]);
  });

  it("ignores submissions that are not turned in", () => {
    for (const state of ["created", "new", "reclaimed"]) {
      expect(turnedInSignals(input({ submission: { state } }))).toEqual({ signals: [] });
    }
  });
});

describe("turnedInSignals: attachments", () => {
  it.each<[string, Over, number | undefined]>([
    [
      "fewer than templates",
      {
        assignment: {
          materials: [template(), template({ driveFileId: "tpl-2", title: "Аркуш 2" })],
        },
        submission: { attachments: [doc(FILLED_UK)] },
      },
      0.6,
    ],
    [
      "fewer than photos asked",
      {
        assignment: { instructions: "Надішли 3 фото сторінок зошита." },
        submission: { attachments: [photo] },
      },
      0.3,
    ],
    [
      "enough photos",
      {
        assignment: { instructions: "Надішли 2 фото." },
        submission: { attachments: [photo, { ...photo, title: "IMG_0002.jpg" }] },
      },
      undefined,
    ],
  ])("fewer_attachments_than_expected: %s", (_name, over, confidence) => {
    const found = find(turnedInSignals(input(over)).signals, "fewer_attachments_than_expected");
    expect(found.map((s) => s.confidence)).toEqual(confidence === undefined ? [] : [confidence]);
  });

  it("panics on an untouched template", () => {
    const res = turnedInSignals(
      input({
        assignment: { materials: [template()] },
        submission: { attachments: [doc(`  ${TEMPLATE_UK.toUpperCase()}\n`)] },
      }),
    );
    expect(one(res.signals, "template_unchanged").confidence).toBe(0.99);
    expect(find(res.signals, "empty_or_tiny_doc")).toEqual([]);
    expect(res.directVerdict).toEqual({
      level: "panic",
      reason: "Turned in the template without changes.",
    });
  });

  it("only signals an untouched template when other work is attached", () => {
    const res = turnedInSignals(
      input({
        assignment: { materials: [template()] },
        submission: { attachments: [doc(TEMPLATE_UK), photo] },
      }),
    );
    one(res.signals, "template_unchanged");
    expect(res.directVerdict).toBeUndefined();
  });

  it("only signals a near-identical template (one word added)", () => {
    const long = Array.from({ length: 60 }, (_, i) => `Речення ${i} про слово${i} та інше${i}.`);
    const text = long.join(" ");
    const res = turnedInSignals(
      input({
        assignment: { materials: [template({ text })] },
        submission: { attachments: [doc(`${text} так`)] },
      }),
    );
    expect(one(res.signals, "template_unchanged").confidence).toBe(0.8);
    expect(res.directVerdict).toBeUndefined();
  });

  it("accepts a filled-in template", () => {
    const res = turnedInSignals(
      input({
        assignment: { materials: [template()] },
        submission: { attachments: [doc(FILLED_UK)] },
      }),
    );
    expect(res).toEqual({ signals: [] });
  });

  it("flags a template with only a few words added", () => {
    const res = turnedInSignals(
      input({
        assignment: { materials: [template()] },
        submission: { attachments: [doc(TEMPLATE_UK.replace("____", "їжачок не знаю"))] },
      }),
    );
    expect(find(res.signals, "template_unchanged")).toEqual([]);
    expect(one(res.signals, "empty_or_tiny_doc").detail).toContain("3 own words");
  });

  it.each<[string, HeuristicAttachment, string | undefined]>([
    ["empty doc", doc(""), "empty_or_tiny_doc"],
    ["tiny doc (en)", doc("My answer is five."), "empty_or_tiny_doc"],
    ["zero-byte file", { kind: "file", title: "a.zip", bytes: 0 }, "empty_or_tiny_doc"],
    ["doc not fetched", doc(undefined), "fetch_failed"],
    ["slides not fetched", { kind: "slides", title: "S", text: null }, "fetch_failed"],
    ["photo without text", photo, undefined],
    ["pdf without text", { kind: "pdf", title: "scan.pdf" }, undefined],
    [
      "long own text",
      doc(
        "Мій улюблений день був у суботу коли ми з татом ходили до лісу збирати гриби " +
          "і бачили білку яка стрибала з гілки на гілку",
      ),
      undefined,
    ],
  ])("%s", (_name, att, code) => {
    const { signals } = turnedInSignals(input({ submission: { attachments: [att] } }));
    expect(signals.map((s) => s.code)).toEqual(code ? [code] : []);
  });

  it("returned work is checked like turned-in work", () => {
    const { signals } = turnedInSignals(input({ submission: { state: "returned" } }));
    one(signals, "no_attachments");
  });
});

describe("turnedInSignals: presentations and Office files", () => {
  const slide = (over: Partial<SlideSummary> = {}): SlideSummary => ({
    index: 1,
    text: "",
    pictures: 0,
    shapes: 1,
    animations: 0,
    animationClasses: {},
    ...over,
  });
  const deck = (...slides: SlideSummary[]): PptxSummary => ({
    format: "pptx",
    slides: slides.map((s, i) => ({ ...s, index: i + 1 })),
  });
  const TPL_TEXT =
    "Анімація об'єктів презентації. Додай ефекти анімації до кожного об'єкта на слайдах";
  const tplDeck = deck(slide({ text: TPL_TEXT, pictures: 2 }));
  const slidesTemplate = template({ kind: "slides", text: TPL_TEXT, office: tplDeck });
  const submit = (att: HeuristicAttachment, materials: HeuristicMaterial[] = []) =>
    turnedInSignals(input({ assignment: { materials }, submission: { attachments: [att] } }));

  it("structureAdded lists pictures/effects beyond the template", () => {
    const own = deck(
      slide({ pictures: 3, animations: 4, animationClasses: { entr: 4 }, transition: "fade" }),
      slide(),
    );
    expect(structureAdded(own, tplDeck)).toEqual([
      "+1 slides",
      "+1 pictures",
      "+1 shapes",
      "+4 animation effects",
      "+1 slide transitions",
    ]);
    expect(structureAdded(own)).toEqual([
      "3 pictures",
      "4 animation effects",
      "1 slide transitions",
    ]);
    expect(structureAdded(undefined)).toEqual([]);
    expect(structureAdded(tplDeck, tplDeck)).toEqual([]);
  });

  it("a template copy with added animations is not an untouched template", () => {
    const own = deck(
      slide({ text: TPL_TEXT, pictures: 2, animations: 5, animationClasses: { entr: 5 } }),
    );
    const res = submit({ kind: "slides", title: "Учень - Анімація", text: TPL_TEXT, office: own }, [
      slidesTemplate,
    ]);
    expect(res.directVerdict).toBeUndefined();
    const s = one(res.signals, "template_unchanged");
    expect(s.confidence).toBe(0.3);
    expect(s.detail).toContain("+5 animation effects");
  });

  it("an identical template copy (same structure) still panics", () => {
    const res = submit({ kind: "slides", title: "Копія", text: TPL_TEXT, office: tplDeck }, [
      slidesTemplate,
    ]);
    expect(res.directVerdict?.level).toBe("panic");
  });

  it("slides with pictures and few words are a weak empty_or_tiny_doc", () => {
    const own = deck(slide({ text: "Мій кіт", pictures: 2 }), slide({ pictures: 1 }));
    const { signals } = submit({ kind: "file", title: "kit.pptx", text: "Мій кіт", office: own });
    const s = one(signals, "empty_or_tiny_doc");
    expect(s.confidence).toBe(0.3);
    expect(s.detail).toContain("3 pictures");
  });

  it("an empty presentation is still empty", () => {
    const { signals } = submit({ kind: "file", title: "x.pptx", text: "", office: deck(slide()) });
    expect(one(signals, "empty_or_tiny_doc").confidence).toBe(0.8);
  });
});
