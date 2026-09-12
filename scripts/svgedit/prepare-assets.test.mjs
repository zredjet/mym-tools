// @vitest-environment node
import { test } from "vitest";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  existsSync,
  writeFileSync,
  rmSync,
  cpSync,
  mkdirSync,
} from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { prepareVectorAssets } from "./prepare-assets.mjs";
import { prepareDrawioAssets } from "../drawio/prepare-assets.mjs";

test("vector distribution is pinned, reproducible, local and limited to the selected ES runtime", () => {
  const root = mkdtempSync(resolve(tmpdir(), "mym-vector-assets-"));
  try {
    mkdirSync(resolve(root, "drawio"));
    writeFileSync(resolve(root, "drawio/sentinel"), "preserved");
    const a = prepareVectorAssets(root),
      b = prepareVectorAssets(root);
    assert.deepEqual(a, b);
    assert.equal(readFileSync(resolve(root, "drawio/sentinel"), "utf8"), "preserved");
    assert.ok(a.some((f) => f.path === "extensions/_virtual/_vite/preload-helper.js"));
    assert.ok(a.some((f) => f.path === "ja.json"));
    assert.ok(a.every((f) => !/\.map$|iife|(^|\/)(tests?|examples|archive)\//i.test(f.path)));
    assert.ok(!a.some((f) => /ext-opensave|ext-storage/.test(f.path)));
    assert.ok(existsSync(resolve(root, "licenses/svgedit/NOTICES.txt")));
    const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
    assert.equal(lock.packages[""].dependencies.svgedit, "7.4.2");
    assert.match(lock.packages["node_modules/svgedit"].integrity, /^sha512-/);
    assert.deepEqual(lock.packages["node_modules/svgedit"].version, "7.4.2");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("forcing draw.io preparation preserves vector assets and their notices", () => {
  prepareVectorAssets();
  const stamp = resolve(".generated/public/.drawio-stamp.json");
  // Force the formerly destructive path, then restore the normal valid stamp.
  if (existsSync(stamp)) cpSync(stamp, `${stamp}.previous`);
  try {
    rmSync(stamp, { force: true });
    const before = readFileSync(".generated/public/svgedit/Editor.js");
    prepareDrawioAssets();
    assert.deepEqual(readFileSync(".generated/public/svgedit/Editor.js"), before);
    assert.ok(existsSync(".generated/public/licenses/svgedit/NOTICES.txt"));
  } finally {
    rmSync(`${stamp}.previous`, { force: true });
  }
});
