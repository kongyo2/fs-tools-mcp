import test from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  expandPath,
  getCwd,
  getLowercaseExtension,
  toRelativePath,
} from "../src/utils/path.js";

test("expandPath expands the home directory", () => {
  assert.equal(expandPath("~"), homedir().normalize("NFC"));
  assert.equal(
    expandPath("~/projects"),
    resolve(homedir(), "projects").normalize("NFC"),
  );
});

test("expandPath resolves relative paths against the base directory", () => {
  assert.equal(
    expandPath("child", `${sep}base`),
    resolve(`${sep}base`, "child"),
  );
});

test("expandPath returns the base directory for empty input", () => {
  assert.equal(expandPath("   ", `${sep}base`), `${sep}base`);
});

test("expandPath rejects null bytes", () => {
  assert.throws(() => expandPath("foo\0bar"), /null bytes/);
});

test("getLowercaseExtension returns the extension without the dot", () => {
  assert.equal(getLowercaseExtension("/a/b/photo.PNG"), "png");
  assert.equal(getLowercaseExtension("/a/b/archive.tar.GZ"), "gz");
});

test("getLowercaseExtension returns an empty string when there is none", () => {
  assert.equal(getLowercaseExtension("/a/b/README"), "");
  assert.equal(getLowercaseExtension("/a/b/.gitignore"), "");
  assert.equal(getLowercaseExtension("/a.png/file"), "");
});

test("toRelativePath relativizes paths under the cwd and keeps others absolute", () => {
  const inside = join(getCwd(), "src", "x.ts");
  assert.equal(toRelativePath(inside), join("src", "x.ts"));
  const outside = `${sep}definitely${sep}elsewhere${sep}x.ts`;
  assert.equal(toRelativePath(outside), outside);
});
