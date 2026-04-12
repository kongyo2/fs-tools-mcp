import test from "node:test";
import assert from "node:assert/strict";
import { applyEditToFile, getPatchForEdit, preserveQuoteStyle } from "../src/tools/fsEditUtils.js";

test("applyEditToFile removes a trailing newline when deleting a line", () => {
  const original = "alpha\nbeta\n";
  const updated = applyEditToFile(original, "beta", "", false);
  assert.equal(updated, "alpha\n");
});

test("preserveQuoteStyle converts straight quotes to curly quotes when source matched curly quotes", () => {
  const updated = preserveQuoteStyle("\"hello\"", "\u201chello\u201d", "\"goodbye\"");
  assert.equal(updated, "\u201cgoodbye\u201d");
});

test("getPatchForEdit returns an updated file and diff hunks", () => {
  const result = getPatchForEdit({
    filePath: "sample.txt",
    fileContents: "one\ntwo\nthree\n",
    oldString: "two",
    newString: "TWO"
  });
  assert.equal(result.updatedFile, "one\nTWO\nthree\n");
  assert.equal(result.patch.length, 1);
  assert.ok(result.patch[0]?.lines.some((line) => line === "-two"));
  assert.ok(result.patch[0]?.lines.some((line) => line === "+TWO"));
});
