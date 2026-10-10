import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { ClaudeCliProvider, type ReviewInput, reviewOutputSchema } from "../src/llm/index.ts";

// Opt-in: calls the real `claude` CLI (costs tokens). Run with `CA_LLM_IT=1 pnpm test llm.integration`.
const enabled = process.env.CA_LLM_IT === "1";
const bin = process.env.CA_CLAUDE_BIN || "claude";
const model = process.env.CA_CLAUDE_MODEL || "haiku";

/** Solid-color RGB PNG, built by hand so the test needs no image deps. */
function solidPng(w: number, h: number, rgb: [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = (crcTable[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const td = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(w).fill(rgb).flat())]);
  const raw = Buffer.concat(Array(h).fill(row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe.skipIf(!enabled)("claude-cli integration", () => {
  const dir = mkdtempSync(join(tmpdir(), "ca-llm-it-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const provider = new ClaudeCliProvider({ bin, model, timeoutMs: 180_000 });

  it("reviews a synthetic text submission", async () => {
    const input: ReviewInput = {
      assignment: {
        title: "Addition warm-up",
        instructions: "Write the answers to: 2+2, 3+5, 10+7.",
        kind: "assignment",
        courseName: "Synthetic Math",
      },
      materials: [],
      submission: {
        attachments: [{ title: "answers.txt", kind: "doc", text: "2+2=4\n3+5=8" }],
        turnedInAt: "2026-01-01T10:00:00Z",
      },
      signals: [],
      locale: "en",
    };
    const out = await provider.review(input);
    expect(reviewOutputSchema.parse(out)).toEqual(out);
    expect(out.verdict).not.toBe("ok"); // 10+7 is missing
  }, 200_000);

  it("reads an attachment image by path", async () => {
    const imagePath = join(dir, "drawing.png");
    writeFileSync(imagePath, solidPng(64, 64, [255, 0, 0]));
    const input: ReviewInput = {
      assignment: {
        title: "Color task",
        instructions: "Upload a picture filled entirely with the color red.",
        kind: "assignment",
        courseName: "Synthetic Art",
      },
      materials: [],
      submission: {
        attachments: [{ title: "drawing.png", kind: "image", imagePath }],
        turnedInAt: "2026-01-01T10:00:00Z",
      },
      signals: [],
      locale: "en",
    };
    const out = await provider.review(input, {
      instructions:
        "View the attached image. If it is a solid red picture, the work is complete: verdict ok and addressesAssignment true.",
    });
    expect(out.addressesAssignment).toBe(true);
    expect(out.verdict).toBe("ok");
  }, 200_000);
});
