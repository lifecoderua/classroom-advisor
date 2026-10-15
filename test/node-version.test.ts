import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NODE_MAJOR, nodeVersionProblem } from "../src/cli/node-version.ts";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

describe("Node version", () => {
  it("is the same major everywhere", () => {
    expect(read(".nvmrc").trim()).toBe(String(NODE_MAJOR));
    const pkg = JSON.parse(read("package.json")) as {
      engines: { node: string };
      devDependencies: Record<string, string>;
    };
    expect(pkg.engines.node).toMatch(
      new RegExp(`^>=${NODE_MAJOR}\\.\\d+\\.\\d+ <${NODE_MAJOR + 1}$`),
    );
    expect(pkg.devDependencies["@types/node"]).toMatch(new RegExp(`^\\^${NODE_MAJOR}\\.`));
    expect(read(".github/workflows/ci.yml")).toContain("node-version-file: .nvmrc");
    expect(read("Dockerfile")).toMatch(new RegExp(`^ARG NODE_MAJOR=${NODE_MAJOR}$`, "m"));
  });

  it("explains a wrong major", () => {
    expect(nodeVersionProblem(`${NODE_MAJOR}.1.0`)).toBeUndefined();
    expect(nodeVersionProblem("25.2.1")).toContain("nvm use");
    expect(nodeVersionProblem(`${NODE_MAJOR + 1}.0.0`)).toContain(`needs Node ${NODE_MAJOR}`);
  });
});
