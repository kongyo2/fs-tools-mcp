import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  FileTooLargeError,
  readFileInRange,
} from "../src/utils/readFileInRange.js";
import { withTempDir as withPrefixedTempDir } from "./helpers.js";

const withTempDir = (fn: (dir: string) => Promise<void>) =>
  withPrefixedTempDir("fs-tools-mcp-read-", fn);

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

test("readFileInRange stops scanning large files once the range is filled", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "large.txt");
    const line = `${"x".repeat(63)}\n`;
    await writeFile(file, line.repeat(200_000), "utf8");

    const stopped = await readFileInRange(file, 0, 3, undefined, undefined, {
      stopScanAfterRange: true,
    });
    assert.equal(stopped.lineCount, 3);
    assert.equal(stopped.content, `${"x".repeat(63)}\n`.repeat(3).trimEnd());
    assert.equal(stopped.partialScan, true);
    assert.ok(stopped.totalLines < 200_000);
    assert.ok(stopped.totalBytes < 12_800_000);

    const scanned = await readFileInRange(file, 0, 3);
    assert.equal(scanned.lineCount, 3);
    assert.equal(scanned.partialScan, undefined);
    assert.equal(scanned.totalLines, 200_001);
  });
});
