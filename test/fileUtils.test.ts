import test from "node:test";
import assert from "node:assert/strict";
import { lstatSync, readFileSync, statSync } from "node:fs";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hasBinaryExtension } from "../src/constants/files.js";
import {
  addLineNumbers,
  findSimilarFile,
  writeFileSyncAndFlush,
  writeTextContent,
} from "../src/utils/file.js";
import {
  detectLineEndingsForString,
  readFileSyncWithMetadata,
} from "../src/utils/fileRead.js";
import { formatFileSize } from "../src/utils/format.js";
import { plural } from "../src/utils/string.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "fs-tools-mcp-file-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("writeTextContent writes CRLF line endings when asked", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "crlf.txt");
    writeTextContent(file, "a\nb\n", "utf8", "CRLF");
    const raw = await readFile(file, "utf8");
    assert.equal(raw, "a\r\nb\r\n");
  });
});

test("writeFileSyncAndFlush preserves the file mode of the target", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "script.sh");
    await writeFile(file, "#!/bin/sh\n", "utf8");
    await chmod(file, 0o755);
    writeFileSyncAndFlush(file, "#!/bin/sh\necho hi\n", { encoding: "utf8" });
    assert.equal(statSync(file).mode & 0o777, 0o755);
    assert.equal(readFileSync(file, "utf8"), "#!/bin/sh\necho hi\n");
  });
});

test("writeFileSyncAndFlush writes through symlinks instead of replacing them", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, "target.txt");
    const link = join(dir, "link.txt");
    await writeFile(target, "original\n", "utf8");
    await symlink(target, link);
    writeFileSyncAndFlush(link, "updated\n", { encoding: "utf8" });
    assert.ok(lstatSync(link).isSymbolicLink());
    assert.equal(readFileSync(target, "utf8"), "updated\n");
  });
});

test("findSimilarFile suggests a sibling with the same stem", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "config.yaml"), "a: 1\n", "utf8");
    assert.equal(findSimilarFile(join(dir, "config.yml")), "config.yaml");
    assert.equal(findSimilarFile(join(dir, "missing.txt")), undefined);
  });
});

test("addLineNumbers starts numbering at the requested line", () => {
  assert.equal(addLineNumbers({ content: "a\nb", startLine: 5 }), "5\ta\n6\tb");
  assert.equal(addLineNumbers({ content: "", startLine: 1 }), "");
});

test("detectLineEndingsForString picks the dominant line ending", () => {
  assert.equal(detectLineEndingsForString("a\r\nb\r\nc\n"), "CRLF");
  assert.equal(detectLineEndingsForString("a\nb\n"), "LF");
  assert.equal(detectLineEndingsForString("no newlines"), "LF");
});

test("readFileSyncWithMetadata detects UTF-16 LE files", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "utf16.txt");
    const buffer = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from("hello", "utf16le"),
    ]);
    await writeFile(file, buffer);
    const meta = readFileSyncWithMetadata(file);
    assert.equal(meta.encoding, "utf16le");
    assert.ok(meta.content.includes("hello"));
  });
});

test("readFileSyncWithMetadata normalizes CRLF and reports the original endings", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "crlf.txt");
    await writeFile(file, "x\r\ny\r\n", "utf8");
    const meta = readFileSyncWithMetadata(file);
    assert.equal(meta.content, "x\ny\n");
    assert.equal(meta.lineEndings, "CRLF");
  });
});

test("hasBinaryExtension matches known binary extensions case-insensitively", () => {
  assert.equal(hasBinaryExtension("/a/photo.PNG"), true);
  assert.equal(hasBinaryExtension("/a/archive.tar.gz"), true);
  assert.equal(hasBinaryExtension("/a/source.ts"), false);
  assert.equal(hasBinaryExtension("/a/README"), false);
  assert.equal(hasBinaryExtension("/a.png/README"), false);
});

test("formatFileSize renders human readable sizes", () => {
  assert.equal(formatFileSize(0), "0 B");
  assert.equal(formatFileSize(512), "512 B");
  assert.equal(formatFileSize(2048), "2.0 KB");
  assert.equal(formatFileSize(5 * 1024 * 1024), "5.0 MB");
  assert.equal(formatFileSize(-1), "0 B");
  assert.equal(formatFileSize(Number.NaN), "0 B");
});

test("plural appends s only for counts other than one", () => {
  assert.equal(plural(1, "file"), "file");
  assert.equal(plural(2, "file"), "files");
  assert.equal(plural(2, "match", "matches"), "matches");
});
