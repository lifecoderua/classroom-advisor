import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Db, openDbAt } from "../../src/store/index.ts";

const ROOT = resolve(import.meta.dirname, "../..");

/**
 * Builds a migrated template DB once (real `prisma migrate deploy` into a temp dataDir)
 * and hands out fresh copies of it per test.
 */
export function migratedTemplate(): { fresh: () => Promise<Db>; cleanup: () => Promise<void> } {
  const dir = mkdtempSync(join(tmpdir(), "ca-store-"));
  const templateDir = join(dir, "template");
  execFileSync(join(ROOT, "node_modules/.bin/prisma"), ["migrate", "deploy"], {
    cwd: ROOT,
    env: { ...process.env, CA_DATA_DIR: templateDir },
    stdio: "pipe",
  });
  const opened: Db[] = [];
  let n = 0;
  return {
    async fresh() {
      const path = join(dir, `test-${n++}.db`);
      copyFileSync(join(templateDir, "app.db"), path);
      const db = openDbAt(path);
      opened.push(db);
      return db;
    },
    async cleanup() {
      await Promise.all(opened.map((db) => db.$disconnect()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
