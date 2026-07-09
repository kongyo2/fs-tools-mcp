import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readNotebook } from "../src/utils/notebook.js";
import { withTempDir as withPrefixedTempDir } from "./helpers.js";

const withTempDir = (fn: (dir: string) => Promise<void>) =>
  withPrefixedTempDir("fs-tools-mcp-nb-", fn);

test("readNotebook parses cells with language metadata", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "nb.ipynb");
    const notebook = {
      metadata: { language_info: { name: "python" } },
      cells: [
        {
          cell_type: "code",
          source: ["print(1)\n", "print(2)\n"],
          execution_count: 3,
          outputs: [{ output_type: "stream", text: ["1\n", "2\n"] }],
        },
        { cell_type: "markdown", source: "# Title" },
      ],
    };
    await writeFile(file, JSON.stringify(notebook), "utf8");
    const cells = await readNotebook(file);
    assert.equal(cells.length, 2);
    assert.equal(cells[0]?.cell_id, "cell-0");
    assert.equal(cells[0]?.source, "print(1)\nprint(2)\n");
    assert.equal(cells[0]?.language, "python");
    assert.equal(cells[0]?.outputs?.[0]?.text, "1\n2\n");
    assert.equal(cells[1]?.cellType, "markdown");
    assert.equal(cells[1]?.language, undefined);
  });
});

test("readNotebook reports invalid JSON clearly", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "broken.ipynb");
    await writeFile(file, "{not json", "utf8");
    await assert.rejects(readNotebook(file), /not valid JSON/);
  });
});

test("readNotebook rejects notebooks without a cells array", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "nocells.ipynb");
    await writeFile(file, JSON.stringify({ metadata: {} }), "utf8");
    await assert.rejects(readNotebook(file), /no cells array/);
  });
});

test("readNotebook resolves a specific cell by id", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "byid.ipynb");
    const notebook = {
      cells: [
        { cell_type: "code", source: "a = 1", id: "first" },
        { cell_type: "code", source: "b = 2", id: "second" },
      ],
    };
    await writeFile(file, JSON.stringify(notebook), "utf8");
    const cells = await readNotebook(file, "second");
    assert.equal(cells.length, 1);
    assert.equal(cells[0]?.source, "b = 2");
    await assert.rejects(readNotebook(file, "missing"), /not found/);
  });
});
