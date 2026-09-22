import { createRequire } from "node:module";

const PACKAGE_NAME = "@kongyo2/fs-tools-mcp";
const FALLBACK_VERSION = "0.0.0";

export function getPackageVersion(): string {
  const require = createRequire(import.meta.url);
  for (const candidate of ["../package.json", "../../package.json"]) {
    try {
      const pkg = require(candidate) as { name?: string; version?: string };
      if (pkg.name === PACKAGE_NAME && typeof pkg.version === "string") {
        return pkg.version;
      }
    } catch {}
  }
  return FALLBACK_VERSION;
}
