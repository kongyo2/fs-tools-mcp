import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { glob } from "../src/utils/glob.js";
import { ripGrep } from "../src/utils/ripgrep.js";

test("glob finds files under a temporary tree", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fs-tools-mcp-glob-"));
  try {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "a.ts"), "export const a = 1;\n", "utf8");
    await writeFile(join(dir, "src", "b.ts"), "export const b = 2;\n", "utf8");
    const result = await glob(
      "**/*.ts",
      dir,
      { limit: 100, offset: 0 },
      AbortSignal.timeout(10_000),
    );
    assert.equal(result.files.length, 2);
    assert.equal(result.truncated, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ripGrep returns matching files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fs-tools-mcp-grep-"));
  try {
    await writeFile(join(dir, "one.txt"), "needle here\n", "utf8");
    await writeFile(join(dir, "two.txt"), "nothing here\n", "utf8");
    const results = await ripGrep(
      ["-l", "needle"],
      dir,
      AbortSignal.timeout(10_000),
    );
    assert.equal(results.length, 1);
    assert.ok(results[0]?.endsWith("one.txt"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
