import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyEditToFile,
  getPatchForEdit,
  getPatchForEdits,
  preserveQuoteStyle,
} from "../src/tools/fsEditUtils.js";
import {
  decodeBuffer,
  detectEncodingFromBuffer,
  encodeForWrite,
} from "../src/utils/encoding.js";
import { glob } from "../src/utils/glob.js";
import { parseCellId } from "../src/utils/notebook.js";
import { parsePDFPageRange } from "../src/utils/pdfUtils.js";
import { readFileInRange } from "../src/utils/readFileInRange.js";
import { extractGlobBaseDirectory } from "../src/utils/glob.js";
import { readFileSyncWithMetadata } from "../src/utils/fileRead.js";
import { ripGrep } from "../src/utils/ripgrep.js";
import { findSimilarFile } from "../src/utils/file.js";

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
  const updated = preserveQuoteStyle('"hello"', "“hello”", '"goodbye"');
  assert.equal(updated, "“goodbye”");
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

await run("getPatchForEdits applies multiple edits sequentially", () => {
  const result = getPatchForEdits({
    filePath: "sample.txt",
    fileContents: "one\ntwo\nthree\n",
    edits: [
      { old_string: "one", new_string: "ONE", replace_all: false },
      { old_string: "three", new_string: "THREE", replace_all: false },
    ],
  });
  assert.equal(result.updatedFile, "ONE\ntwo\nTHREE\n");
});

await run("getPatchForEdits rejects substring conflicts between edits", () => {
  assert.throws(() => {
    getPatchForEdits({
      filePath: "sample.txt",
      fileContents: "alpha\nbeta\n",
      edits: [
        { old_string: "alpha", new_string: "ALPHABET", replace_all: false },
        { old_string: "ALPHA", new_string: "X", replace_all: false },
      ],
    });
  });
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

await run("parseCellId parses cell-N references", () => {
  assert.equal(parseCellId("cell-5"), 5);
  assert.equal(parseCellId("cell-0"), 0);
  assert.equal(parseCellId("xyz"), undefined);
  assert.equal(parseCellId("cell-abc"), undefined);
});

await run("encoding detection round-trips UTF-8 with BOM", () => {
  const original = "hello\nworld\n";
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const buf = Buffer.concat([bom, Buffer.from(original, "utf8")]);
  const detected = detectEncodingFromBuffer(buf);
  assert.equal(detected.encoding, "utf8");
  assert.equal(detected.hadBOM, true);
  const decoded = decodeBuffer(buf, detected);
  assert.equal(decoded, original);
  const reencoded = encodeForWrite(decoded, detected);
  assert.deepEqual(reencoded, buf);
});

await run("encoding detection round-trips UTF-16LE with BOM", () => {
  const original = "hello\nworld\n";
  const bom = Buffer.from([0xff, 0xfe]);
  const body = Buffer.from(original, "utf16le");
  const buf = Buffer.concat([bom, body]);
  const detected = detectEncodingFromBuffer(buf);
  assert.equal(detected.encoding, "utf16le");
  assert.equal(detected.hadBOM, true);
  const decoded = decodeBuffer(buf, detected);
  assert.equal(decoded, original);
});

await run(
  "readFileSyncWithMetadata normalizes CRLF and reports endings",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "fs-tools-mcp-crlf-"));
    try {
      const file = join(dir, "crlf.txt");
      await writeFile(file, "line1\r\nline2\r\nline3\r\n");
      const meta = readFileSyncWithMetadata(file);
      assert.equal(meta.content, "line1\nline2\nline3\n");
      assert.equal(meta.lineEndings, "CRLF");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

await run(
  "findSimilarFile returns a sibling with different extension",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "fs-tools-mcp-similar-"));
    try {
      await writeFile(join(dir, "report.ts"), "// ts\n");
      await writeFile(join(dir, "other.md"), "# unrelated\n");
      const missing = join(dir, "report.tsx");
      const match = findSimilarFile(missing);
      assert.equal(match, "report.ts");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

await run(
  "findSimilarFile returns undefined when no sibling exists",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "fs-tools-mcp-similar-"));
    try {
      await writeFile(join(dir, "other.md"), "# unrelated\n");
      const missing = join(dir, "report.tsx");
      const match = findSimilarFile(missing);
      assert.equal(match, undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

await run(
  "fs_multi_edit getPatchForEdits handles empty old_string as full rewrite",
  () => {
    const result = getPatchForEdits({
      filePath: "sample.txt",
      fileContents: "old content\n",
      edits: [
        { old_string: "", new_string: "new content\n", replace_all: false },
      ],
    });
    assert.equal(result.updatedFile, "new content\n");
  },
);

await run("writeTextContent honors CRLF endings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fs-tools-mcp-write-"));
  try {
    const file = join(dir, "out.txt");
    const { writeTextContent } = await import("../src/utils/file.js");
    writeTextContent(file, "line1\nline2\n", "utf8", "CRLF");
    const buf = await readFile(file);
    assert.ok(buf.toString().includes("line1\r\nline2\r\n"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await run(
  "fs_multi_edit rejects ambiguous matches without replace_all",
  async () => {
    const { createServer } = await import("../src/server.js");
    const dir = await mkdtemp(join(tmpdir(), "fs-tools-mcp-multi-"));
    try {
      const file = join(dir, "sample.txt");
      await writeFile(file, "alpha\nalpha\nbeta\n", "utf8");
      const server = createServer() as unknown as {
        _registeredTools: Record<
          string,
          {
            handler: (
              args: unknown,
            ) => Promise<{ isError?: boolean; content: { text: string }[] }>;
          }
        >;
      };
      const tool = server._registeredTools.fs_multi_edit!;
      const result = await tool.handler({
        file_path: file,
        edits: [{ old_string: "alpha", new_string: "ALPHA" }],
      });
      assert.equal(result.isError, true);
      assert.ok(result.content[0]!.text.includes("matches"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

await run(
  "fs_notebook_edit converting markdown to code initializes execution_count/outputs",
  async () => {
    const { createServer } = await import("../src/server.js");
    const dir = await mkdtemp(join(tmpdir(), "fs-tools-mcp-nb-"));
    try {
      const file = join(dir, "notebook.ipynb");
      const nb = {
        cells: [
          {
            cell_type: "markdown",
            id: "c1",
            source: "# title",
            metadata: {},
          },
        ],
        metadata: { language_info: { name: "python" } },
        nbformat: 4,
        nbformat_minor: 5,
      };
      await writeFile(file, JSON.stringify(nb, null, 1), "utf8");
      const server = createServer() as unknown as {
        _registeredTools: Record<
          string,
          { handler: (args: unknown) => Promise<{ isError?: boolean }> }
        >;
      };
      const tool = server._registeredTools.fs_notebook_edit!;
      const result = await tool.handler({
        notebook_path: file,
        cell_id: "c1",
        new_source: "print('hello')",
        cell_type: "code",
        edit_mode: "replace",
      });
      assert.equal(result.isError, undefined);
      const written = JSON.parse(await readFile(file, "utf8"));
      assert.equal(written.cells[0].cell_type, "code");
      assert.equal(written.cells[0].execution_count, null);
      assert.deepEqual(written.cells[0].outputs, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

await run("fs_notebook_edit delete does not require new_source", async () => {
  const { createServer } = await import("../src/server.js");
  const dir = await mkdtemp(join(tmpdir(), "fs-tools-mcp-nb-"));
  try {
    const file = join(dir, "notebook.ipynb");
    const nb = {
      cells: [
        {
          cell_type: "code",
          id: "c1",
          source: "a",
          metadata: {},
          outputs: [],
          execution_count: null,
        },
        {
          cell_type: "code",
          id: "c2",
          source: "b",
          metadata: {},
          outputs: [],
          execution_count: null,
        },
      ],
      metadata: { language_info: { name: "python" } },
      nbformat: 4,
      nbformat_minor: 5,
    };
    await writeFile(file, JSON.stringify(nb, null, 1), "utf8");
    const server = createServer() as unknown as {
      _registeredTools: Record<
        string,
        { handler: (args: unknown) => Promise<{ isError?: boolean }> }
      >;
    };
    const tool = server._registeredTools.fs_notebook_edit!;
    const result = await tool.handler({
      notebook_path: file,
      cell_id: "c1",
      edit_mode: "delete",
    });
    assert.equal(result.isError, undefined);
    const written = JSON.parse(await readFile(file, "utf8"));
    assert.equal(written.cells.length, 1);
    assert.equal(written.cells[0].id, "c2");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await run(
  "fs_notebook_edit replace without cell_id errors instead of coercing",
  async () => {
    const { createServer } = await import("../src/server.js");
    const dir = await mkdtemp(join(tmpdir(), "fs-tools-mcp-nb-"));
    try {
      const file = join(dir, "notebook.ipynb");
      const nb = {
        cells: [
          {
            cell_type: "code",
            id: "c1",
            source: "a",
            metadata: {},
            outputs: [],
            execution_count: null,
          },
        ],
        metadata: { language_info: { name: "python" } },
        nbformat: 4,
        nbformat_minor: 5,
      };
      await writeFile(file, JSON.stringify(nb, null, 1), "utf8");
      const server = createServer() as unknown as {
        _registeredTools: Record<
          string,
          {
            handler: (
              args: unknown,
            ) => Promise<{ isError?: boolean; content: { text: string }[] }>;
          }
        >;
      };
      const tool = server._registeredTools.fs_notebook_edit!;
      const result = await tool.handler({
        notebook_path: file,
        new_source: "ignored",
        edit_mode: "replace",
      });
      assert.equal(result.isError, true);
      assert.ok(result.content[0]!.text.includes("cell_id is required"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

process.stdout.write(`PASS summary: ${passed} tests\n`);
