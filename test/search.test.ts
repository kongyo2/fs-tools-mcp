import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
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

test("glob returns newest files first", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fs-tools-mcp-glob-"));
  try {
    const older = join(dir, "older.ts");
    const newer = join(dir, "newer.ts");
    await writeFile(older, "old\n", "utf8");
    await writeFile(newer, "new\n", "utf8");
    const now = Date.now() / 1000;
    await utimes(older, now - 3600, now - 3600);
    await utimes(newer, now, now);
    const result = await glob(
      "*.ts",
      dir,
      { limit: 100, offset: 0 },
      AbortSignal.timeout(10_000),
    );
    assert.deepEqual(result.files, [newer, older]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("glob paginates with limit and offset", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fs-tools-mcp-glob-"));
  try {
    await writeFile(join(dir, "a.ts"), "a\n", "utf8");
    await writeFile(join(dir, "b.ts"), "b\n", "utf8");
    await writeFile(join(dir, "c.ts"), "c\n", "utf8");
    const firstPage = await glob(
      "*.ts",
      dir,
      { limit: 2, offset: 0 },
      AbortSignal.timeout(10_000),
    );
    assert.equal(firstPage.files.length, 2);
    assert.equal(firstPage.truncated, true);
    const secondPage = await glob(
      "*.ts",
      dir,
      { limit: 2, offset: 2 },
      AbortSignal.timeout(10_000),
    );
    assert.equal(secondPage.files.length, 1);
    assert.equal(secondPage.truncated, false);
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

test("ripGrep resolves to an empty list when nothing matches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fs-tools-mcp-grep-"));
  try {
    await writeFile(join(dir, "one.txt"), "content\n", "utf8");
    const results = await ripGrep(
      ["-l", "no-such-thing"],
      dir,
      AbortSignal.timeout(10_000),
    );
    assert.deepEqual(results, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ripGrep surfaces invalid regex errors instead of returning no matches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fs-tools-mcp-grep-"));
  try {
    await writeFile(join(dir, "one.txt"), "content\n", "utf8");
    await assert.rejects(
      ripGrep(["-l", "unclosed["], dir, AbortSignal.timeout(10_000)),
      /ripgrep failed/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
