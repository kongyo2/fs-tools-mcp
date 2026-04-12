import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyEditToFile,
  getPatchForEdit,
  preserveQuoteStyle,
} from "../src/tools/fsEditUtils.js";
import { glob } from "../src/utils/glob.js";
import { parsePDFPageRange } from "../src/utils/pdfUtils.js";
import { readFileInRange } from "../src/utils/readFileInRange.js";
import { ripGrep } from "../src/utils/ripgrep.js";
import { extractGlobBaseDirectory } from "../src/utils/glob.js";

let passed = 0;

async function run(
  name: string,
  fn: () => void | Promise<void>,
): Promise<void> {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    process.stderr.write(`FAIL ${name}\n`);
    throw error;
  }
}

await run(
  "applyEditToFile removes a trailing newline when deleting a line",
  () => {
    const original = "alpha\nbeta\n";
    const updated = applyEditToFile(original, "beta", "", false);
    assert.equal(updated, "alpha\n");
  },
);

await run("preserveQuoteStyle converts straight quotes to curly quotes", () => {
  const updated = preserveQuoteStyle(
    '"hello"',
    "\u201chello\u201d",
    '"goodbye"',
  );
  assert.equal(updated, "\u201cgoodbye\u201d");
});

await run("getPatchForEdit returns an updated file and diff hunks", () => {
  const result = getPatchForEdit({
    filePath: "sample.txt",
    fileContents: "one\ntwo\nthree\n",
    oldString: "two",
    newString: "TWO",
  });
  assert.equal(result.updatedFile, "one\nTWO\nthree\n");
  assert.equal(result.patch.length, 1);
  assert.ok(result.patch[0]?.lines.some((line) => line === "-two"));
  assert.ok(result.patch[0]?.lines.some((line) => line === "+TWO"));
});

await run("readFileInRange returns the requested line window", async () => {
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

await run("readFileInRange truncates by bytes when requested", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fs-tools-mcp-read-"));
  try {
    const file = join(dir, "sample.txt");
    await writeFile(file, "alpha\nbeta\ngamma\n", "utf8");
    const result = await readFileInRange(file, 0, undefined, 9, undefined, {
      truncateOnByteLimit: true,
    });
    assert.equal(result.content, "alpha");
    assert.equal(result.truncatedByBytes, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await run("glob finds files under a temporary tree", async () => {
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

await run("ripGrep returns matching files", async () => {
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

await run("parsePDFPageRange parses single page and open ended ranges", () => {
  assert.deepEqual(parsePDFPageRange("3"), { firstPage: 3, lastPage: 3 });
  assert.deepEqual(parsePDFPageRange("5-"), {
    firstPage: 5,
    lastPage: Number.POSITIVE_INFINITY,
  });
  assert.deepEqual(parsePDFPageRange("2-4"), { firstPage: 2, lastPage: 4 });
  assert.equal(parsePDFPageRange("0"), null);
});

await run("extractGlobBaseDirectory splits absolute glob patterns", () => {
  const extracted = extractGlobBaseDirectory("/repo/src/**/*.ts");
  assert.equal(extracted.baseDir, "/repo/src");
  assert.equal(extracted.relativePattern, "**/*.ts");
});

process.stdout.write(`PASS summary: ${passed} tests\n`);
