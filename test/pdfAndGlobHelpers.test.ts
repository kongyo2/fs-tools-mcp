import test from "node:test";
import assert from "node:assert/strict";
import { extractGlobBaseDirectory } from "../src/utils/glob.js";
import { isPDFExtension, parsePDFPageRange } from "../src/utils/pdfUtils.js";

test("parsePDFPageRange parses single page and open ended ranges", () => {
  assert.deepEqual(parsePDFPageRange("3"), { firstPage: 3, lastPage: 3 });
  assert.deepEqual(parsePDFPageRange("5-"), {
    firstPage: 5,
    lastPage: Number.POSITIVE_INFINITY,
  });
  assert.deepEqual(parsePDFPageRange("2-4"), { firstPage: 2, lastPage: 4 });
  assert.deepEqual(parsePDFPageRange(" 7 "), { firstPage: 7, lastPage: 7 });
});

test("parsePDFPageRange rejects invalid input", () => {
  assert.equal(parsePDFPageRange("0"), null);
  assert.equal(parsePDFPageRange(""), null);
  assert.equal(parsePDFPageRange("abc"), null);
  assert.equal(parsePDFPageRange("5-3"), null);
  assert.equal(parsePDFPageRange("0-"), null);
  assert.equal(parsePDFPageRange("1,3"), null);
  assert.equal(parsePDFPageRange("-5"), null);
});

test("isPDFExtension accepts pdf with or without a leading dot, case-insensitively", () => {
  assert.equal(isPDFExtension("pdf"), true);
  assert.equal(isPDFExtension(".PDF"), true);
  assert.equal(isPDFExtension("txt"), false);
  assert.equal(isPDFExtension(""), false);
});

test("extractGlobBaseDirectory splits absolute glob patterns", () => {
  const extracted = extractGlobBaseDirectory("/repo/src/**/*.ts");
  assert.equal(extracted.baseDir, "/repo/src");
  assert.equal(extracted.relativePattern, "**/*.ts");
});

test("extractGlobBaseDirectory handles wildcards at the filesystem root", () => {
  const extracted = extractGlobBaseDirectory("/*.ts");
  assert.equal(extracted.baseDir, "/");
  assert.equal(extracted.relativePattern, "*.ts");
});

test("extractGlobBaseDirectory handles patterns without wildcards", () => {
  const extracted = extractGlobBaseDirectory("/repo/src/index.ts");
  assert.equal(extracted.baseDir, "/repo/src");
  assert.equal(extracted.relativePattern, "index.ts");
});
