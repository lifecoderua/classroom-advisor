import { join } from "node:path";
import type { Config } from "../config/index.ts";

/** Absolute path of the SQLite database: `<dataDir>/app.db`. */
export function databasePath(config: Pick<Config, "dataDir">): string {
  return join(config.dataDir, "app.db");
}
