import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  FileTooLargeError,
  readFileInRange,
} from "../src/utils/readFileInRange.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "fs-tools-mcp-read-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("readFileInRange returns the requested line window", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "sample.txt");
    await writeFile(file, "one\ntwo\nthree\nfour\n", "utf8");
    const result = await readFileInRange(file, 1, 2);
    assert.equal(result.content, "two\nthree");
    assert.equal(result.lineCount, 2);
    assert.equal(result.totalLines, 5);
    assert.ok(result.mtimeMs > 0);
  });
});

test("readFileInRange truncates by bytes when requested", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "sample.txt");
    await writeFile(file, "alpha\nbeta\ngamma\n", "utf8");
    const result = await readFileInRange(file, 0, undefined, 9, undefined, {
      truncateOnByteLimit: true,
    });
    assert.equal(result.content, "alpha");
    assert.equal(result.truncatedByBytes, true);
  });
});

test("readFileInRange fails fast when the file exceeds maxBytes", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "sample.txt");
    await writeFile(file, "0123456789012345\n", "utf8");
    await assert.rejects(
      readFileInRange(file, 0, undefined, 8),
      (error: unknown) => {
        assert.ok(error instanceof FileTooLargeError);
        assert.equal(error.sizeInBytes, 17);
        assert.equal(error.maxSizeBytes, 8);
        return true;
      },
    );
  });
});

test("readFileInRange handles empty files", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "empty.txt");
    await writeFile(file, "", "utf8");
    const result = await readFileInRange(file);
    assert.equal(result.content, "");
    assert.equal(result.lineCount, 0);
    assert.equal(result.totalLines, 0);
  });
});

test("readFileInRange returns empty content for offsets beyond the end", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "short.txt");
    await writeFile(file, "one\ntwo\n", "utf8");
    const result = await readFileInRange(file, 10, 5);
    assert.equal(result.content, "");
    assert.equal(result.lineCount, 0);
    assert.equal(result.totalLines, 3);
  });
});

test("readFileInRange strips CR from CRLF files and the leading BOM", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "crlf.txt");
    await writeFile(file, "\uFEFFfirst\r\nsecond\r\n", "utf8");
    const result = await readFileInRange(file);
    assert.equal(result.content, "first\nsecond\n");
    assert.equal(result.lineCount, 3);
  });
});

test("readFileInRange rejects directories", async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(readFileInRange(dir), /EISDIR/);
  });
});
