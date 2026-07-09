import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "../src/server.js";
import { getPackageVersion } from "../src/version.js";
import { semanticBoolean } from "../src/utils/semanticBoolean.js";
import { semanticNumber } from "../src/utils/semanticNumber.js";
import { z } from "zod/v4";

test("createServer registers every tool without throwing", () => {
  const server = createServer();
  assert.ok(server);
  assert.equal(typeof server.connect, "function");
});

test("getPackageVersion matches package.json", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  assert.equal(getPackageVersion(), pkg.version);
});

test("semanticNumber coerces numeric strings", () => {
  const schema = semanticNumber(z.number().int().optional());
  assert.equal(schema.parse("42"), 42);
  assert.equal(schema.parse(7), 7);
  assert.equal(schema.parse(undefined), undefined);
  assert.throws(() => schema.parse("not-a-number"));
});

test("semanticBoolean coerces boolean strings", () => {
  const schema = semanticBoolean(z.boolean().optional());
  assert.equal(schema.parse("true"), true);
  assert.equal(schema.parse("false"), false);
  assert.equal(schema.parse(true), true);
  assert.equal(schema.parse(undefined), undefined);
  assert.throws(() => schema.parse("yes"));
});
