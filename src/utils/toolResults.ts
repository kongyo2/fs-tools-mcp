import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let cachedDir: string | undefined;

export function getToolResultsDir(): string {
  if (cachedDir === undefined) {
    cachedDir = join(tmpdir(), "fs-tools-mcp-results");
    mkdirSync(cachedDir, { recursive: true });
  }
  return cachedDir;
}
