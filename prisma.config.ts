import { mkdirSync } from "node:fs";
import { defineConfig } from "prisma/config";
import { loadConfig } from "./src/config/index.ts";
import { databasePath } from "./src/store/path.ts";

// The DB lives at `<dataDir>/app.db`; dataDir comes from the app config (CA_DATA_DIR etc.).
const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: `file:${databasePath(config)}` },
});
