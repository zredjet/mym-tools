import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DRAWIO_COMMIT = "f411a11f4f6b8994d869bdbc45f4d4d9e2284f34";
export const DRAWIO_VERSION = "32.7.4";
// js/app.min.js に内包され実行時に使われる DOMPurify。js/sanitizer/purify.min.js は読み込まれない。
export const DRAWIO_DOMPURIFY_VERSION = "3.4.18";

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
const NRBF_LICENSE_PATH = resolve(PROJECT_ROOT, "third_party/system-formats-nrbf-LICENSE.txt");
const SHOTQ_NOTICES_PATH = resolve(PROJECT_ROOT, "third_party/shotq-NOTICES.txt");

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
    nrbfLicenseSha256: sha256(NRBF_LICENSE_PATH),
    shotqNoticesSha256: sha256(SHOTQ_NOTICES_PATH),
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

/**
 * 同梱をやめたエディタの生成物 (`GENERATED_ROOT` からの相対 path)。SVG-Edit (ADR-0021) は
 * ADR-0026 でキャンバスに置き換えた。`vite.config.ts` は `GENERATED_ROOT` をまるごと配信・同梱する
 * ので、前の版で作った作業フォルダに残っていると、手元のビルドに入ってしまう。
 */
export const RETIRED_GENERATED_PATHS = ["svgedit", "licenses/svgedit", ".svgedit-stamp.json"];

/** `RETIRED_GENERATED_PATHS` のうち残っているものを消し、消したものを返す。 */
export function removeRetiredAssets(root = GENERATED_ROOT) {
  const removed = [];
  for (const path of RETIRED_GENERATED_PATHS) {
    const target = resolve(root, path);
    if (!existsSync(target)) continue;
    rmSync(target, { recursive: true, force: true });
    removed.push(path);
  }
  return removed;
}

export function prepareDrawioAssets() {
  const commit = currentCommit();
  if (commit !== DRAWIO_COMMIT) {
    throw new Error(`draw.io commit が不一致です。expected=${DRAWIO_COMMIT} actual=${commit}`);
  }

  // draw.io の資産が揃っていて早く戻るときも、同梱をやめたエディタの生成物は消す
  for (const path of removeRetiredAssets()) {
    process.stdout.write(`removed retired generated asset: ${path}\n`);
  }

  if (preparedAlready()) {
    process.stdout.write(`draw.io ${DRAWIO_VERSION} assets are ready\n`);
    return;
  }

  // GENERATED_ROOT には draw.io 以外の生成物 (ライセンスの写しなど) も置くので、
  // ここで作り直すのは draw.io の資産だけにする
  rmSync(TARGET_ROOT, { recursive: true, force: true });
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
  cpSync(NRBF_LICENSE_PATH, resolve(licenses, "system-formats-nrbf-LICENSE.txt"));
  cpSync(SHOTQ_NOTICES_PATH, resolve(licenses, "shotq-NOTICES.txt"));

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
