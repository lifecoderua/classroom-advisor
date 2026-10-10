/**
 * Anonymizes Classroom RPC captures into synthetic fixtures that keep the exact structure
 * (array shapes, positions, types, encodings) but none of the values that could identify anyone.
 *
 *   pnpm tsx scripts/anonymize.ts --out fixtures/classroom <input.json|input.txt>...
 *
 * `.json` inputs are any JSON (e.g. `{rpcid, request, response}`); `.txt` inputs are raw
 * batchexecute response bodies and are re-framed after anonymizing. One shared mapping is used
 * for all inputs of a run, so the same id stays the same across files. The run fails if any
 * replaced value still appears in the output.
 *
 * Rules: ids (numbers >= 1e5, digit strings, base64-encoded digit strings, Drive/YouTube-style
 * tokens, UUIDs) are mapped to random values of the same shape; epoch-ms timestamps are shifted
 * by a whole number of weeks (time of day and weekday stay); emails, names and free text become
 * fake text; URLs keep their host (Google hosts) or become `example.com`, with ids inside mapped.
 * Short enum-like strings (`hrq.sub`, `edu.rt`, mime types, colors) are kept.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseFrames } from "../src/collector/classroom/rpc.ts";

export { parseFrames };

const LOREM =
  "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat".split(
    " ",
  );

const GOOGLE_HOST =
  /(^|\.)(google\.com|googleusercontent\.com|gstatic\.com|youtube\.com|ytimg\.com|googleapis\.com)$/;

/** Epoch ms between 2010 and 2040. */
const isTimestamp = (n: number) => n >= 1_262_304_000_000 && n <= 2_208_988_800_000;
const WEEK_MS = 7 * 24 * 3600 * 1000;

export interface AnonymizerOptions {
  seed?: number;
  /** Shift applied to timestamps, in weeks (negative = earlier). */
  shiftWeeks?: number;
}

export class Anonymizer {
  private rand: () => number;
  private ids = new Map<string, string>();
  private tokens = new Map<string, string>();
  private emails = new Map<string, string>();
  private texts = new Map<string, string>();
  private shift: number;
  /** Every original value that was replaced; used to verify the output. */
  readonly replaced = new Set<string>();

  constructor(options: AnonymizerOptions = {}) {
    let s = options.seed ?? 42;
    // mulberry32
    this.rand = () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    this.shift = (options.shiftWeeks ?? -52) * WEEK_MS;
  }

  private pick(chars: string): string {
    return chars[Math.floor(this.rand() * chars.length)] ?? "x";
  }

  /** Same digit count, no leading zero; stable per original. */
  id(digits: string): string {
    const hit = this.ids.get(digits);
    if (hit) return hit;
    let out: string;
    do {
      out = this.pick("123456789");
      for (let i = 1; i < digits.length; i++) out += this.pick("0123456789");
    } while (out === digits || [...this.ids.values()].includes(out));
    this.ids.set(digits, out);
    if (digits.length >= 5) this.replaced.add(digits);
    return out;
  }

  /** Same length and character classes (case, digits, punctuation kept in place). */
  token(original: string): string {
    const hit = this.tokens.get(original);
    if (hit) return hit;
    const hex = /^[0-9a-fA-F-]+$/.test(original);
    let out = "";
    for (const ch of original) {
      if (/[a-z]/.test(ch)) out += this.pick(hex ? "abcdef" : "abcdefghijklmnopqrstuvwxyz");
      else if (/[A-Z]/.test(ch)) out += this.pick(hex ? "ABCDEF" : "ABCDEFGHIJKLMNOPQRSTUVWXYZ");
      else if (/[0-9]/.test(ch)) out += this.pick("0123456789");
      else out += ch;
    }
    this.tokens.set(original, out);
    this.replaced.add(original);
    return out;
  }

  email(original: string): string {
    const key = original.toLowerCase();
    const hit = this.emails.get(key);
    if (hit) return hit;
    const out = `user${this.emails.size + 1}@school.example`;
    this.emails.set(key, out);
    this.replaced.add(original);
    return out;
  }

  /** Lorem words in place of each word; whitespace, a file extension and length class kept. */
  text(original: string): string {
    const hit = this.texts.get(original);
    if (hit) return hit;
    const ext = /\.(jpe?g|png|gif|pdf|docx?|xlsx?|pptx?|mp4|mov|mp3|txt|heic)$/i.exec(
      original,
    )?.[0];
    const body = ext ? original.slice(0, -ext.length) : original;
    let n = 0;
    const out =
      body.replace(/\S+/g, () => {
        const w = LOREM[(this.texts.size * 7 + n++) % LOREM.length] ?? "lorem";
        return w;
      }) + (ext ?? "");
    this.texts.set(original, out);
    if (out !== original) this.replaced.add(original);
    return out;
  }

  /** `ODcy...` style ids: base64 of a decimal id. */
  private base64Id(seg: string): string | undefined {
    if (!/^[A-Za-z0-9+/_-]{8,}={0,2}$/.test(seg)) return undefined;
    try {
      const decoded = Buffer.from(seg, "base64").toString("utf8");
      if (!/^\d{6,}$/.test(decoded)) return undefined;
      this.replaced.add(seg);
      return Buffer.from(this.id(decoded)).toString("base64").replace(/=+$/, "");
    } catch {
      return undefined;
    }
  }

  /** Replaces ids, tokens and emails inside a URL or path, keeping its structure. */
  url(original: string): string {
    // Hosts, also of URLs nested in query strings (plain or %-encoded).
    let out = original.replace(
      /(^|https?:|https?%3A)(\/\/|%2F%2F)([A-Za-z0-9.-]+)/gi,
      (_m, proto: string, sep: string, host: string) => {
        const keep = GOOGLE_HOST.test(host.toLowerCase());
        if (!keep) this.replaced.add(host);
        return `${proto}${sep}${keep ? host : "example.com"}`;
      },
    );
    out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (m) => this.email(m));
    out = out.replace(/[a-z]{3}-[a-z]{4}-[a-z]{3}/g, (m) => this.token(m)); // Meet codes
    out = out.replace(/[A-Za-z0-9_-]{8,}={0,2}/g, (m) => {
      if (/^\d+$/.test(m)) return this.id(m);
      return this.base64Id(m) ?? (/\d/.test(m) || m.length >= 20 ? this.token(m) : m);
    });
    out = out.replace(/(?<![A-Za-z0-9])\d{5,}(?![A-Za-z0-9])/g, (m) => this.id(m));
    if (out !== original) this.replaced.add(original);
    return out;
  }

  string(s: string): string {
    if (s === "") return s;
    // Enum-like: `hrq.sub`, `edu.rt`, `rubric.list`, `wrb.fr`, `generic`.
    if (/^[a-z]+(\.[a-z]+)*$/.test(s) && s.length <= 16) return s;
    if (/^[a-z]+\/[A-Za-z0-9.+-]+$/.test(s)) return s; // mime type
    if (/^#[0-9a-fA-F]{6}$/.test(s)) return s; // color
    if (/^[A-Za-z0-9+/]{2,14}={1,2}$/.test(s)) return s; // short padded base64 etags
    if (/^-?\d+$/.test(s)) {
      const neg = s.startsWith("-");
      const d = neg ? s.slice(1) : s;
      if (d.length < 5) return s;
      const n = Number(d);
      if (d.length === 13 && isTimestamp(n)) return String(n + this.shift);
      return (neg ? "-" : "") + this.id(d);
    }
    if (/^(https?:)?\/\/\S+$/.test(s) || /^\/[A-Za-z]\S*$/.test(s)) return this.url(s);
    if (/^[^\s@"'<>]+@[^\s@"'<>]+\.[^\s@"'<>]+$/.test(s)) return this.email(s);
    if (/^[cs]:\d/.test(s)) return s.replace(/\d{5,}/g, (m) => this.id(m)); // stream keys
    if (/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(s))
      return this.token(s);
    if (/^[A-Za-z0-9_-]{10,}$/.test(s) && /\d|[A-Z].*[a-z]|[a-z].*[A-Z]/.test(s))
      return this.token(s);
    if (/^[A-Za-z0-9+/=_-]{16,}$/.test(s)) return this.token(s); // page tokens
    if (/^\s*</.test(s)) return this.html(s);
    return this.text(s);
  }

  /** Keeps tags, replaces text nodes and attribute values that look like ids/urls. */
  html(s: string): string {
    const out = s.replace(/>([^<]+)</g, (_m, t: string) => {
      const decoded = t.trim();
      return `>${decoded ? t.replace(decoded, this.text(decoded)) : t}<`;
    });
    const final = out.replace(
      /(href|src)="([^"]*)"/g,
      (_m, a: string, v: string) => `${a}="${this.url(v)}"`,
    );
    if (final !== s) this.replaced.add(s);
    return final;
  }

  number(n: number): number {
    if (!Number.isInteger(n) || Math.abs(n) < 100_000) return n;
    if (isTimestamp(Math.abs(n))) return n + this.shift;
    const neg = n < 0;
    const mapped = Number(this.id(String(Math.abs(n))));
    return neg ? -mapped : mapped;
  }

  value(v: unknown): unknown {
    if (typeof v === "string") return this.string(v);
    if (typeof v === "number") return this.number(v);
    if (Array.isArray(v)) return v.map((x) => this.value(x));
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [k, k === "rpcid" ? x : this.value(x)]),
      );
    }
    return v;
  }

  /** Raw batchexecute body: anonymizes each JSON chunk (and the JSON inside `wrb.fr` rows). */
  batchexecute(body: string): string {
    const rows = parseFrames(body);
    const chunks = rows.map((chunk) =>
      (chunk as unknown[]).map((row) => {
        if (Array.isArray(row) && row[0] === "wrb.fr" && typeof row[2] === "string") {
          const inner = JSON.stringify(this.value(JSON.parse(row[2])));
          return ["wrb.fr", row[1], inner, ...(this.value(row.slice(3)) as unknown[])];
        }
        return this.value(row);
      }),
    );
    return frame(chunks);
  }

  /** Throws if any replaced original value survives in `output`. */
  verify(output: string, label: string): void {
    const leaks = [...this.replaced].filter(
      (v) =>
        v.length >= 5 && (output.includes(v) || output.includes(JSON.stringify(v).slice(1, -1))),
    );
    if (leaks.length > 0) {
      const detail = process.env.ANON_DEBUG
        ? `: ${leaks.map((l) => l.slice(0, 40)).join(" | ")}`
        : "";
      throw new Error(`${label}: ${leaks.length} original value(s) still present${detail}`);
    }
  }
}

/** Inverse of {@link parseFrames}: the length counts UTF-16 units of `"\n" + json + "\n"`. */
export function frame(chunks: unknown[]): string {
  return `)]}'\n${chunks
    .map((c) => {
      const json = JSON.stringify(c);
      return `\n${json.length + 2}\n${json}`;
    })
    .join("")}\n`;
}

function main(argv: string[]): void {
  const outIdx = argv.indexOf("--out");
  const outDir = outIdx >= 0 ? argv[outIdx + 1] : undefined;
  const inputs = argv.filter((a, i) => a !== "--out" && i !== outIdx + 1);
  if (!outDir || inputs.length === 0) {
    console.error("usage: tsx scripts/anonymize.ts --out <dir> <input.json|input.txt>...");
    process.exit(2);
  }
  mkdirSync(outDir, { recursive: true });
  const anon = new Anonymizer();
  const outputs: [string, string][] = [];
  for (const input of inputs) {
    const raw = readFileSync(input, "utf8");
    const text = input.endsWith(".txt")
      ? anon.batchexecute(raw)
      : `${JSON.stringify(anon.value(JSON.parse(raw)), null, 1)}\n`;
    outputs.push([join(outDir, basename(input)), text]);
  }
  // Verify after all inputs, since later files may add originals seen earlier.
  for (const [path, text] of outputs) {
    if (process.env.ANON_DEBUG) writeFileSync(path, text);
    anon.verify(text, path);
    writeFileSync(path, text);
  }
  console.log(`wrote ${outputs.length} file(s) to ${outDir}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
