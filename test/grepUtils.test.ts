import test from "node:test";
import assert from "node:assert/strict";
import {
  applyHeadLimit,
  parseRipgrepContentLine,
  renderGrepText,
} from "../src/tools/grepUtils.js";

test("parseRipgrepContentLine extracts paths from line-numbered output", () => {
  const parsed = parseRipgrepContentLine("/repo/src/a.ts:12:const x = 1;");
  assert.deepEqual(parsed, {
    filePath: "/repo/src/a.ts",
    rest: ":12:const x = 1;",
  });
});

test("parseRipgrepContentLine extracts paths without line numbers", () => {
  const parsed = parseRipgrepContentLine("/repo/src/a.ts:const x = 1;");
  assert.deepEqual(parsed, {
    filePath: "/repo/src/a.ts",
    rest: ":const x = 1;",
  });
});

test("parseRipgrepContentLine skips Windows drive letters", () => {
  const parsed = parseRipgrepContentLine("C:\\repo\\a.ts:3:let y;");
  assert.deepEqual(parsed, {
    filePath: "C:\\repo\\a.ts",
    rest: ":3:let y;",
  });
});

test("parseRipgrepContentLine passes through group separators", () => {
  assert.equal(parseRipgrepContentLine("--"), null);
});

test("applyHeadLimit slices with offset and reports truncation", () => {
  const limited = applyHeadLimit([1, 2, 3, 4, 5], 2, 1);
  assert.deepEqual(limited.items, [2, 3]);
  assert.equal(limited.appliedLimit, 2);
});

test("applyHeadLimit with limit 0 returns everything after the offset", () => {
  const limited = applyHeadLimit([1, 2, 3], 0, 1);
  assert.deepEqual(limited.items, [2, 3]);
  assert.equal(limited.appliedLimit, undefined);
});

test("applyHeadLimit reports no truncation when everything fits", () => {
  const limited = applyHeadLimit([1, 2], 10, 0);
  assert.deepEqual(limited.items, [1, 2]);
  assert.equal(limited.appliedLimit, undefined);
});

test("renderGrepText reports empty results per mode", () => {
  assert.equal(
    renderGrepText({ mode: "files_with_matches", numFiles: 0, filenames: [] }),
    "No files found",
  );
  assert.match(
    renderGrepText({ mode: "content", numFiles: 0, filenames: [] }),
    /No matches found/,
  );
  assert.match(
    renderGrepText({
      mode: "count",
      numFiles: 0,
      filenames: [],
      numMatches: 0,
    }),
    /Found 0 total occurrences across 0 files/,
  );
});

test("renderGrepText lists matching files with a count header", () => {
  const text = renderGrepText({
    mode: "files_with_matches",
    numFiles: 2,
    filenames: ["a.ts", "b.ts"],
  });
  assert.equal(text, "Found 2 files\na.ts\nb.ts");
});
