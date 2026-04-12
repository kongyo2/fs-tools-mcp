import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileInRange } from "../src/utils/readFileInRange.js";

test("readFileInRange returns the requested line window", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fs-tools-mcp-read-"));
  try {
    const file = join(dir, "sample.txt");
    await writeFile(file, "one\ntwo\nthree\nfour\n", "utf8");
    const result = await readFileInRange(file, 1, 2);
    assert.equal(result.content, "two\nthree");
    assert.equal(result.lineCount, 2);
    assert.equal(result.totalLines, 5);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readFileInRange truncates by bytes when requested", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fs-tools-mcp-read-"));
  try {
    const file = join(dir, "sample.txt");
    await writeFile(file, "alpha\nbeta\ngamma\n", "utf8");
    const result = await readFileInRange(file, 0, undefined, 9, undefined, { truncateOnByteLimit: true });
    assert.equal(result.content, "alpha");
    assert.equal(result.truncatedByBytes, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
