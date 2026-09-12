import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import process from "node:process";

export const SVGEDIT_VERSION = "7.4.2";
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const upstream = resolve(root, "node_modules/svgedit");
export const SVGEDIT_EXTENSIONS = [
  "connector",
  "eyedropper",
  "grid",
  "markers",
  "panning",
  "shapes",
  "polystar",
  "layer_view",
];

export function prepareVectorAssets(outputRoot = resolve(root, ".generated/public")) {
  const version = JSON.parse(readFileSync(resolve(upstream, "package.json"), "utf8")).version;
  if (version !== SVGEDIT_VERSION) throw new Error(`SVG-Edit version mismatch: ${version}`);
  const target = resolve(outputRoot, "svgedit");
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  const copy = (path) =>
    cpSync(resolve(upstream, "dist/editor", path), resolve(target, path), {
      recursive: true,
      filter: (name) => !name.endsWith(".map"),
    });
  for (const path of ["Editor.js", "svgedit.css", "images", "components", "extensions/_virtual"])
    copy(path);
  for (const name of SVGEDIT_EXTENSIONS) copy(`extensions/ext-${name}`);
  for (const name of [
    "index.html",
    "host.js",
    "layer-dialog.js",
    "svg-policy.js",
    "policy.json",
    "ja.json",
  ])
    cpSync(resolve(here, name), resolve(target, name));
  const licenses = resolve(outputRoot, "licenses/svgedit");
  rmSync(licenses, { recursive: true, force: true });
  mkdirSync(licenses, { recursive: true });
  cpSync(resolve(upstream, "LICENSE-MIT.txt"), resolve(licenses, "SVGEdit-MIT.txt"));
  cpSync(
    resolve(upstream, "src/editor/components/jgraduate/LICENSE-Apache2.0.txt"),
    resolve(licenses, "jGraduate-Apache2.0.txt"),
  );
  // Full notices and the reviewed source-map inventory accompany the runtime.
  cpSync(resolve(root, "third_party/svgedit-NOTICES.txt"), resolve(licenses, "NOTICES.txt"));
  cpSync(resolve(here, "license-audit.json"), resolve(licenses, "license-audit.json"));
  cpSync(resolve(upstream, "licenseInfo.json"), resolve(licenses, "upstream-licenseInfo.json"));
  cpSync(resolve(here, "LICENSES.md"), resolve(licenses, "LICENSES.md"));
  const manifest = [];
  const walk = (dir, prefix = "") => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) walk(resolve(dir, entry.name), `${name}/`);
      else {
        const bytes = readFileSync(resolve(dir, entry.name));
        manifest.push({
          path: name,
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      }
    }
  };
  walk(target);
  manifest.sort((a, b) => a.path.localeCompare(b.path));
  writeFileSync(
    resolve(outputRoot, ".svgedit-stamp.json"),
    JSON.stringify({ version, assets: manifest }, null, 2),
  );
  return manifest;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const assets = prepareVectorAssets();
  process.stdout.write(
    `prepared SVG-Edit ${SVGEDIT_VERSION}: ${assets.length} assets, ${assets.reduce((sum, file) => sum + file.bytes, 0)} bytes\n`,
  );
}
