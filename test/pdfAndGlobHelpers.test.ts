import test from "node:test";
import assert from "node:assert/strict";
import { extractGlobBaseDirectory } from "../src/utils/glob.js";
import { parsePDFPageRange } from "../src/utils/pdfUtils.js";

test("parsePDFPageRange parses single page and open ended ranges", () => {
  assert.deepEqual(parsePDFPageRange("3"), { firstPage: 3, lastPage: 3 });
  assert.deepEqual(parsePDFPageRange("5-"), {
    firstPage: 5,
    lastPage: Number.POSITIVE_INFINITY,
  });
  assert.deepEqual(parsePDFPageRange("2-4"), { firstPage: 2, lastPage: 4 });
  assert.equal(parsePDFPageRange("0"), null);
});

test("extractGlobBaseDirectory splits absolute glob patterns", () => {
  const extracted = extractGlobBaseDirectory("/repo/src/**/*.ts");
  assert.equal(extracted.baseDir, "/repo/src");
  assert.equal(extracted.relativePattern, "**/*.ts");
});
