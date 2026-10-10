import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import type { Config } from "../config/index.ts";
import { PrismaClient } from "./generated/client.ts";
import { databasePath } from "./path.ts";

export type Db = PrismaClient;

/** Opens a Prisma client on the SQLite file at `path` (created if missing; schema via migrations). */
export function openDbAt(path: string): Db {
  mkdirSync(dirname(path), { recursive: true });
  const adapter = new PrismaBetterSqlite3({ url: `file:${path}` });
  return new PrismaClient({ adapter });
}

/** Opens the app DB at `<dataDir>/app.db`. Run `pnpm db:migrate` first. */
export function openDb(config: Pick<Config, "dataDir">): Db {
  return openDbAt(databasePath(config));
}
