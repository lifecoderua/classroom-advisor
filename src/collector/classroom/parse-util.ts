/**
 * Defensive accessors for Classroom's positional (protobuf-as-JSON) payloads.
 *
 * Everything returns `unknown` until a typed getter checks it. A failed check throws
 * {@link ParseDriftError}, whose message names the rpc, the path and the *shape* of what was
 * found (`string`, `array(21)`, `null`...). It never includes the value itself, so drift
 * reports can't leak titles, names or emails.
 */

export type PathSegment = number | string;
export type Path = readonly PathSegment[];

export interface DriftContext {
  /** rpcid or other source label, e.g. `pONvgf` or `WIZ_global_data`. */
  rpcid: string;
  /** Where in the payload, e.g. `[2][3][1][0][5]` or `item#3[1][0][5]`. */
  path?: string;
  /** What we expected, e.g. `string`, `id`, `epoch ms`. */
  expected?: string;
  /** Shape of what we found (see {@link shapeOf}). Never a raw value. */
  shape?: string;
  detail?: string;
}

export class ParseDriftError extends Error {
  override name = "ParseDriftError";
  readonly rpcid: string;
  readonly path: string | undefined;
  readonly shape: string | undefined;
  constructor(ctx: DriftContext) {
    const where = ctx.path ? ` at ${ctx.path}` : "";
    const what = ctx.expected ? `expected ${ctx.expected}${where}, got ${ctx.shape ?? "?"}` : "";
    const msg = [what || (where ? `unexpected data${where}` : ""), ctx.detail]
      .filter(Boolean)
      .join(": ");
    super(`${ctx.rpcid}: payload drift${msg ? ` (${msg})` : ""}`);
    this.rpcid = ctx.rpcid;
    this.path = ctx.path;
    this.shape = ctx.shape;
  }
}

/** Type/shape of a value without its content: `null`, `string(12)`, `array(21)`, `object`. */
export function shapeOf(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "missing";
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === "string") return `string(${value.length})`;
  return typeof value;
}

export function formatPath(path: Path): string {
  return path.map((p) => (typeof p === "number" ? `[${p}]` : `.${p}`)).join("");
}

/** Walks `path` into nested arrays/objects. Missing steps yield `undefined`, never a throw. */
export function at(root: unknown, ...path: PathSegment[]): unknown {
  let cur: unknown = root;
  for (const p of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<PathSegment, unknown>)[p];
  }
  return cur;
}

const isNil = (v: unknown): v is null | undefined => v === null || v === undefined;

/** Plausible epoch ms: 2008..2100. */
const isEpochMs = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 1.2e12 && v < 4.1e12;

/**
 * Typed getters bound to one rpc label. `label` (optional) prefixes the path in errors, e.g.
 * `item#3`. Required getters throw on null/missing; `opt*` getters return `null` for those
 * and still throw on a wrong type.
 */
export interface Reader {
  readonly rpcid: string;
  at(root: unknown, path: Path): unknown;
  drift(path: Path, expected: string, got: unknown, label?: string): ParseDriftError;
  str(root: unknown, path: Path, label?: string): string;
  optStr(root: unknown, path: Path, label?: string): string | null;
  num(root: unknown, path: Path, label?: string): number;
  optNum(root: unknown, path: Path, label?: string): number | null;
  int(root: unknown, path: Path, label?: string): number;
  optInt(root: unknown, path: Path, label?: string): number | null;
  bool(root: unknown, path: Path, label?: string): boolean;
  optBool(root: unknown, path: Path, label?: string): boolean | null;
  arr(root: unknown, path: Path, label?: string): unknown[];
  optArr(root: unknown, path: Path, label?: string): unknown[] | null;
  /** Decimal id; accepts a digit string or a safe integer, returns the string. */
  id(root: unknown, path: Path, label?: string): string;
  optId(root: unknown, path: Path, label?: string): string | null;
  /** Epoch milliseconds (UTC). */
  ms(root: unknown, path: Path, label?: string): number;
  optMs(root: unknown, path: Path, label?: string): number | null;
}

export function reader(rpcid: string): Reader {
  const fmt = (path: Path, label?: string) => `${label ?? ""}${formatPath(path)}`;
  const drift = (path: Path, expected: string, got: unknown, label?: string) =>
    new ParseDriftError({ rpcid, path: fmt(path, label), expected, shape: shapeOf(got) });

  function getter<T>(expected: string, check: (v: unknown) => T | undefined) {
    const req = (root: unknown, path: Path, label?: string): T => {
      const v = at(root, ...path);
      const out = isNil(v) ? undefined : check(v);
      if (out === undefined) throw drift(path, expected, v, label);
      return out;
    };
    const opt = (root: unknown, path: Path, label?: string): T | null => {
      const v = at(root, ...path);
      if (isNil(v)) return null;
      const out = check(v);
      if (out === undefined) throw drift(path, expected, v, label);
      return out;
    };
    return [req, opt] as const;
  }

  const [str, optStr] = getter("string", (v) => (typeof v === "string" ? v : undefined));
  const [num, optNum] = getter("number", (v) =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined,
  );
  const [int, optInt] = getter("integer", (v) =>
    typeof v === "number" && Number.isInteger(v) ? v : undefined,
  );
  const [bool, optBool] = getter("boolean", (v) => (typeof v === "boolean" ? v : undefined));
  const [arr, optArr] = getter("array", (v) => (Array.isArray(v) ? v : undefined));
  const [id, optId] = getter("id", (v) => {
    if (typeof v === "string" && /^\d+$/.test(v)) return v;
    if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return String(v);
    return undefined;
  });
  const [ms, optMs] = getter("epoch ms", (v) => (isEpochMs(v) ? v : undefined));

  return {
    rpcid,
    at: (root, path) => at(root, ...path),
    drift,
    str,
    optStr,
    num,
    optNum,
    int,
    optInt,
    bool,
    optBool,
    arr,
    optArr,
    id,
    optId,
    ms,
    optMs,
  };
}

/**
 * Cursor-style reader: a position in a payload that remembers its path, so nested parsers
 * report full paths (`[1][0][2][1][1][0]`). Optional getters return `undefined` for
 * null/missing. Throws the same {@link ParseDriftError} as {@link reader}.
 */
export class Cursor {
  constructor(
    readonly rpcid: string,
    readonly root: unknown,
    readonly base: Path = [],
  ) {}

  child(path: Path): Cursor {
    return new Cursor(this.rpcid, at(this.root, ...path), [...this.base, ...path]);
  }

  private where(path: Path): string {
    return formatPath([...this.base, ...path]) || "<root>";
  }

  /** Throws a drift error with a free-text detail (ids at most, never content). */
  drift(path: Path, detail: string): never {
    throw new ParseDriftError({ rpcid: this.rpcid, path: this.where(path), detail });
  }

  /** Throws "expected X at path, got <shape>". */
  expected(path: Path, expected: string, got: unknown = this.get(path)): never {
    throw new ParseDriftError({
      rpcid: this.rpcid,
      path: this.where(path),
      expected,
      shape: shapeOf(got),
    });
  }

  get(path: Path): unknown {
    return at(this.root, ...path);
  }

  str(path: Path): string {
    const v = this.get(path);
    return typeof v === "string" ? v : this.expected(path, "string", v);
  }

  optStr(path: Path): string | undefined {
    const v = this.get(path);
    if (isNil(v)) return undefined;
    return typeof v === "string" ? v : this.expected(path, "string", v);
  }

  num(path: Path): number {
    const v = this.get(path);
    return typeof v === "number" ? v : this.expected(path, "number", v);
  }

  optNum(path: Path): number | undefined {
    const v = this.get(path);
    if (isNil(v)) return undefined;
    return typeof v === "number" ? v : this.expected(path, "number", v);
  }

  arr(path: Path): unknown[] {
    const v = this.get(path);
    return Array.isArray(v) ? v : this.expected(path, "array", v);
  }

  optArr(path: Path): unknown[] | undefined {
    const v = this.get(path);
    if (isNil(v)) return undefined;
    return Array.isArray(v) ? v : this.expected(path, "array", v);
  }

  /** Ids are decimal strings in responses (numbers in requests); accept both. */
  id(path: Path): string {
    const v = this.get(path);
    if (typeof v === "string" && /^\d+$/.test(v)) return v;
    if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return String(v);
    return this.expected(path, "decimal id", v);
  }

  /**
   * Material ids (description refs, `t51ITc` keys) are signed 64-bit decimals; negative ones
   * arrive as strings like `"-12345678901"`.
   */
  signedId(path: Path): string {
    const v = this.get(path);
    if (typeof v === "string" && /^-?\d+$/.test(v)) return v;
    if (typeof v === "number" && Number.isSafeInteger(v)) return String(v);
    return this.expected(path, "signed decimal id", v);
  }

  /** Checks the payload type tag at `[0]`, e.g. `hrq.sub`. */
  tag(expected: string): void {
    const v = this.get([0]);
    if (v !== expected) this.expected([0], `tag "${expected}"`, v);
  }
}

/** Base64 (standard alphabet, no padding) of a decimal id string, as used in Classroom URLs. */
export function idToB64(id: string): string {
  return Buffer.from(id, "utf8").toString("base64").replace(/=+$/, "");
}
