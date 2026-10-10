import { ConfigError } from "../config/index.ts";

/** A daily local-time window in minutes after midnight; `end < start` crosses midnight. */
export interface QuietHours {
  start: number;
  end: number;
}

function parseClock(s: string, what: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  const h = Number(m?.[1]);
  const min = Number(m?.[2]);
  if (!m || h > 23 || min > 59) throw new ConfigError(`quietHours: invalid ${what} time '${s}'`);
  return h * 60 + min;
}

/** Parses `HH:MM-HH:MM` (local time). `22:00-07:00` crosses midnight. Equal ends are rejected. */
export function parseQuietHours(spec: string): QuietHours {
  const parts = spec.split("-");
  if (parts.length !== 2) throw new ConfigError(`quietHours: expected HH:MM-HH:MM, got '${spec}'`);
  const start = parseClock(parts[0] ?? "", "start");
  const end = parseClock(parts[1] ?? "", "end");
  if (start === end) throw new ConfigError(`quietHours: start and end are equal ('${spec}')`);
  return { start, end };
}

/** Whether `at` (in the process's local time zone) falls inside the window; end is exclusive. */
export function inQuietHours(q: QuietHours, at: Date): boolean {
  const m = at.getHours() * 60 + at.getMinutes();
  return q.start < q.end ? m >= q.start && m < q.end : m >= q.start || m < q.end;
}

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 } as const;

/** Parses a duration like `90m`, `24h`, `3d`, `1w` into milliseconds. */
export function parseDuration(spec: string): number {
  const m = /^(\d+)\s*([mhdw])$/.exec(spec.trim().toLowerCase());
  if (!m || Number(m[1]) <= 0) {
    throw new Error(`invalid duration '${spec}' (use e.g. 90m, 24h, 3d, 1w)`);
  }
  return Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS];
}
