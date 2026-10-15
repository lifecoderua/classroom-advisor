// The Node major the project runs on. It must match `.nvmrc`, `engines`, CI and the Dockerfile
// (test/node-version.test.ts). better-sqlite3 is a native module built for one Node ABI, so
// running under another major fails deep inside Prisma with a NODE_MODULE_VERSION error.

export const NODE_MAJOR = 26;

/** A human hint when `version` is not on {@link NODE_MAJOR}; undefined when it is. */
export function nodeVersionProblem(version: string = process.versions.node): string | undefined {
  const major = Number(version.split(".")[0]);
  if (major === NODE_MAJOR) return undefined;
  return `Node ${version} is running, the project needs Node ${NODE_MAJOR}: run \`nvm use\` (or \`nvm install\`) in the project folder, then \`pnpm install\` if node_modules was built under another version.`;
}
