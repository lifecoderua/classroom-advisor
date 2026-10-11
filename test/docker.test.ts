import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

describe("Docker packaging", () => {
  it("pins the Playwright base image to the installed playwright version", () => {
    const require = createRequire(import.meta.url);
    const { version } = require("playwright/package.json") as { version: string };
    expect(read("Dockerfile")).toMatch(new RegExp(`^ARG PLAYWRIGHT_VERSION=${version}$`, "m"));
  });

  it("keeps real data and secrets out of the build context", () => {
    const ignored = read(".dockerignore").split("\n");
    for (const entry of [".data", "config.local.json", ".env", "captures", ".claude"]) {
      expect(ignored).toContain(entry);
    }
  });
});
