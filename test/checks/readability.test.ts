import { describe, expect, it } from "vitest";
import {
  fetchErrorReason,
  isTemporaryUnreadable,
  type ReadabilityInput,
  unreadableCause,
  unreadableReason,
} from "../../src/checks/readability.ts";
import { messages } from "../../src/i18n/index.ts";

const DRIVE = "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view";
const base = (over: Partial<ReadabilityInput>): ReadabilityInput => ({
  kind: "file",
  title: "work",
  url: DRIVE,
  ...over,
});

describe("unreadableReason", () => {
  it.each<[string, Partial<ReadabilityInput>, string | undefined]>([
    ["doc text", { kind: "doc", text: "Відповідь" }, undefined],
    ["empty doc (an empty document, not unreadable)", { kind: "doc", text: "" }, undefined],
    ["image", { kind: "image", imagePath: "/d/files/x/1.jpg" }, undefined],
    ["office structure without text", { kind: "file", hasStructure: true }, undefined],
    ["scanned pdf", { kind: "pdf", text: "  \n" }, "PDF without a text layer (scanned pages?)"],
    ["video by mime", { kind: "video", mime: "video/mp4" }, "video: needs watching"],
    [
      "youtube",
      { kind: "video", url: "https://youtu.be/abc", mime: null },
      "video: needs watching",
    ],
    [
      "audio by mime (downloaded as .bin)",
      { mime: "audio/mpeg", contentPath: "files/x/a.bin" },
      "audio recording: needs listening",
    ],
    ["audio by title", { title: "reading.m4a" }, "audio recording: needs listening"],
    ["form", { kind: "form" }, "Google Form: the answers can't be read"],
    [
      "external link",
      { kind: "link", url: "https://www.naurok.example/test/result/1" },
      "external link (naurok.example): its content isn't downloaded",
    ],
    [
      "legacy ppt by mime",
      { mime: "application/vnd.ms-powerpoint", contentPath: "files/x/a.bin" },
      "old PowerPoint format (.ppt) isn't supported",
    ],
    [
      "legacy doc by title",
      { title: "Твір.DOC", contentPath: "files/x/a.bin" },
      "old Word format (.doc) isn't supported",
    ],
    [
      "too large",
      { kind: "pdf", fetchError: "file too large (31457280 bytes > 26214400)" },
      "file too large to download (30 MB)",
    ],
    ["not downloaded", { kind: "doc" }, "the file hasn't been downloaded"],
    [
      "cached text that can't be read",
      { kind: "doc", contentPath: "files/x/a.txt" },
      "the downloaded copy couldn't be read",
    ],
    [
      "unsupported image",
      { kind: "image", title: "scan.bmp", contentPath: "files/x/a.bmp" },
      "image format .bmp isn't supported",
    ],
    [
      "unknown binary",
      { title: "project.zip", contentPath: "files/x/a.bin" },
      "unsupported file format (.zip)",
    ],
  ])("%s", (_name, over, reason) => {
    expect(unreadableReason(base(over))).toBe(reason);
  });

  it("keeps the cause structured, so the parent sees it in the digest language", () => {
    const cause = unreadableCause(base({ title: "project.zip", contentPath: "files/x/a.bin" }));
    expect(cause).toEqual({ code: "unsupported_format", arg: ".zip" });
    expect(messages("uk").unreadable(cause as NonNullable<typeof cause>)).toBe(
      "непідтримуваний формат файлу (.zip)",
    );
  });
});

describe("fetchErrorReason", () => {
  it.each([
    ["HTTP 403", "no access to the file (HTTP 403)"],
    ["HTTP 404", "no access to the file (HTTP 404)"],
    ["pptx text extraction failed: bad zip", "the file couldn't be read (damaged or unusual)"],
    ["no Drive file id", "not a Drive file"],
    ["timed out after 60000ms", "download failed (timed out after 60000ms)"],
  ])("%s", (error, reason) => {
    expect(fetchErrorReason(error)).toBe(reason);
  });
});

describe("isTemporaryUnreadable", () => {
  it.each<[string, Partial<ReadabilityInput>, boolean]>([
    ["not downloaded", { kind: "doc" }, true],
    ["server error", { kind: "pdf", fetchError: "HTTP 500" }, true],
    ["no access", { kind: "pdf", fetchError: "HTTP 403" }, true],
    ["timeout", { kind: "pdf", fetchError: "timed out after 60000ms" }, true],
    ["too large", { kind: "pdf", fetchError: "file too large (31457280 bytes > 26214400)" }, false],
    ["extraction failed", { fetchError: "pptx text extraction failed: bad zip" }, false],
    ["legacy format", { mime: "application/msword", contentPath: "files/x/a.bin" }, false],
    ["video", { kind: "video", mime: "video/mp4" }, false],
    ["unsupported format", { title: "a.zip", contentPath: "files/x/a.bin" }, false],
  ])("%s", (_name, over, temporary) => {
    expect(isTemporaryUnreadable(base(over))).toBe(temporary);
  });
});
