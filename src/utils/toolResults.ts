import { join } from "node:path";
import { tmpdir } from "node:os";
import { safeMkdirSync } from "./fsResult.js";

let cachedDir: string | undefined;

export function getToolResultsDir(): string {
  if (cachedDir === undefined) {
    const dir = join(tmpdir(), "fs-tools-mcp-results");
    const result = safeMkdirSync(dir);
    if (result.isErr()) {
      throw new Error(
        `Failed to create tool results directory "${dir}": ${result.error.message}`,
      );
    }
    cachedDir = dir;
  }
  return cachedDir;
}
