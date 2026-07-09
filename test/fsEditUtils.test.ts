import test from "node:test";
import assert from "node:assert/strict";
import {
  applyEditToFile,
  countOccurrences,
  findActualString,
  getPatchForEdit,
  getPatchForEdits,
  normalizeQuotes,
  preserveQuoteStyle,
} from "../src/tools/fsEditUtils.js";

test("applyEditToFile removes a trailing newline when deleting a line", () => {
  const original = "alpha\nbeta\n";
  const updated = applyEditToFile(original, "beta", "", false);
  assert.equal(updated, "alpha\n");
});

test("applyEditToFile replaces all occurrences when replaceAll is set", () => {
  const original = "x = 1; x = 2; x = 3;";
  const updated = applyEditToFile(original, "x =", "y =", true);
  assert.equal(updated, "y = 1; y = 2; y = 3;");
});

test("applyEditToFile treats replacement strings literally, including $", () => {
  const original = "value: PLACEHOLDER";
  const updated = applyEditToFile(original, "PLACEHOLDER", "$100 & $200");
  assert.equal(updated, "value: $100 & $200");
});

test("normalizeQuotes maps curly quotes to straight quotes", () => {
  assert.equal(normalizeQuotes("“hi” ‘there’"), `"hi" 'there'`);
});

test("findActualString returns the exact match when present", () => {
  assert.equal(findActualString("abc def", "def"), "def");
});

test("findActualString maps straight-quote searches onto curly-quote content", () => {
  const content = "say “hello” now";
  assert.equal(findActualString(content, 'say "hello" now'), content);
});

test("findActualString returns null when the string is absent", () => {
  assert.equal(findActualString("abc", "xyz"), null);
});

test("countOccurrences counts non-overlapping matches", () => {
  assert.equal(countOccurrences("aaa bbb aaa", "aaa"), 2);
  assert.equal(countOccurrences("aaa", ""), 0);
});

test("preserveQuoteStyle converts straight quotes to curly quotes when source matched curly quotes", () => {
  const updated = preserveQuoteStyle('"hello"', "“hello”", '"goodbye"');
  assert.equal(updated, "“goodbye”");
});

test("preserveQuoteStyle leaves the new string alone for exact matches", () => {
  assert.equal(preserveQuoteStyle("a", "a", '"b"'), '"b"');
});

test("getPatchForEdit returns an updated file and diff hunks", () => {
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

test("getPatchForEdit keeps special replacement characters intact in the diff", () => {
  const result = getPatchForEdit({
    filePath: "sample.txt",
    fileContents: "cost\n",
    oldString: "cost",
    newString: "$1 & $2",
  });
  assert.equal(result.updatedFile, "$1 & $2\n");
  assert.ok(result.patch[0]?.lines.some((line) => line === "+$1 & $2"));
});

test("getPatchForEdits rejects an old_string contained in a previous new_string", () => {
  assert.throws(
    () =>
      getPatchForEdits({
        filePath: "sample.txt",
        fileContents: "start\n",
        edits: [
          { old_string: "start", new_string: "middle", replace_all: false },
          { old_string: "middle", new_string: "end", replace_all: false },
        ],
      }),
    /substring of a new_string/,
  );
});

test("getPatchForEdits throws when nothing matches", () => {
  assert.throws(
    () =>
      getPatchForEdits({
        filePath: "sample.txt",
        fileContents: "content\n",
        edits: [{ old_string: "missing", new_string: "x", replace_all: false }],
      }),
    /String not found in file/,
  );
});
