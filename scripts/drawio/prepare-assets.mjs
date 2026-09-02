import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DRAWIO_COMMIT = "fea5e877f3e6f849331ad09894f7edb9771708fa";
export const DRAWIO_VERSION = "31.4.1";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "../..");
const DRAWIO_ROOT = resolve(PROJECT_ROOT, "vendor/drawio");
const SOURCE_ROOT = resolve(DRAWIO_ROOT, "src/main/webapp");
const GENERATED_ROOT = resolve(PROJECT_ROOT, ".generated/public");
const TARGET_ROOT = resolve(GENERATED_ROOT, "drawio");
const STAMP_PATH = resolve(GENERATED_ROOT, ".drawio-stamp.json");
const PRECONFIG_PATH = resolve(SCRIPT_DIR, "PreConfig.js");
const MERMAID_LICENSE_PATH = resolve(PROJECT_ROOT, "node_modules/mermaid/LICENSE");
const LOPDF_LICENSE_PATH = resolve(PROJECT_ROOT, "third_party/lopdf-LICENSE.txt");

// ブラウザ版エディタがローカル編集に使う全 client asset。Java servlet、cloud provider
// bridge、service worker はオフライン Tauri runtime では利用しないため含めない。
export const CLIENT_DIRECTORIES = [
  "images",
  "img",
  "js",
  "math4",
  "mxgraph",
  "plugins",
  "resources",
  "shapes",
  "stencils",
  "styles",
  "templates",
];

export const CLIENT_FILES = ["export-fonts.css", "favicon.ico", "index.html", "shortcuts.svg"];
export const REQUIRED_CLIENT_ASSETS = ["resources/dia_ja.txt"];

function currentCommit() {
  if (!existsSync(resolve(DRAWIO_ROOT, ".git"))) {
    throw new Error(
      "draw.io submodule が初期化されていません。git submodule update --init --depth 1 を実行してください。",
    );
  }
  return execFileSync("git", ["-C", DRAWIO_ROOT, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
}

export function drawioAssetStamp() {
  return {
    commit: DRAWIO_COMMIT,
    version: DRAWIO_VERSION,
    layout: 5,
    preConfigSha256: sha256(PRECONFIG_PATH),
    mermaidLicenseSha256: sha256(MERMAID_LICENSE_PATH),
    lopdfLicenseSha256: sha256(LOPDF_LICENSE_PATH),
  };
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function preparedAlready() {
  if (!existsSync(STAMP_PATH) || !existsSync(resolve(TARGET_ROOT, "index.html"))) return false;
  try {
    return (
      JSON.stringify(JSON.parse(readFileSync(STAMP_PATH, "utf8"))) ===
      JSON.stringify(drawioAssetStamp())
    );
  } catch {
    return false;
  }
}

export function prepareDrawioAssets() {
  const commit = currentCommit();
  if (commit !== DRAWIO_COMMIT) {
    throw new Error(`draw.io commit が不一致です。expected=${DRAWIO_COMMIT} actual=${commit}`);
  }

  if (preparedAlready()) {
    process.stdout.write(`draw.io ${DRAWIO_VERSION} assets are ready\n`);
    return;
  }

  rmSync(GENERATED_ROOT, { recursive: true, force: true });
  mkdirSync(TARGET_ROOT, { recursive: true });

  for (const name of CLIENT_DIRECTORIES) {
    cpSync(resolve(SOURCE_ROOT, name), resolve(TARGET_ROOT, name), { recursive: true });
  }
  for (const name of CLIENT_FILES) {
    cpSync(resolve(SOURCE_ROOT, name), resolve(TARGET_ROOT, name));
  }
  for (const name of REQUIRED_CLIENT_ASSETS) {
    if (!existsSync(resolve(TARGET_ROOT, name))) {
      throw new Error(`required draw.io client asset is missing: ${name}`);
    }
  }

  cpSync(PRECONFIG_PATH, resolve(TARGET_ROOT, "js/PreConfig.js"));

  const licenses = resolve(GENERATED_ROOT, "licenses");
  mkdirSync(licenses, { recursive: true });
  cpSync(resolve(DRAWIO_ROOT, "LICENSE"), resolve(licenses, "drawio-LICENSE.txt"));
  cpSync(MERMAID_LICENSE_PATH, resolve(licenses, "mermaid-LICENSE.txt"));
  cpSync(LOPDF_LICENSE_PATH, resolve(licenses, "lopdf-LICENSE.txt"));

  const stamp = drawioAssetStamp();
  writeFileSync(STAMP_PATH, `${JSON.stringify(stamp, null, 2)}\n`);
  process.stdout.write(`prepared draw.io ${DRAWIO_VERSION} client assets\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  try {
    prepareDrawioAssets();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
