import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { Buffer } from "node:buffer";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export const MAX_PORTABLE_ARCHIVE_BYTES = 80_000_000;

function assertValidPrereleaseIdentifiers(prerelease) {
  if (!prerelease) {
    return;
  }

  for (const identifier of prerelease.split(".")) {
    if (/^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0")) {
      throw new Error(`プレリリース識別子に先行ゼロは使用できません: ${identifier}`);
    }
  }
}

export function normalizeVersion(input) {
  const raw = String(input ?? "").trim();
  const version = raw.startsWith("v") ? raw.slice(1) : raw;
  const match = SEMVER_PATTERN.exec(version);

  if (!match) {
    throw new Error(
      `バージョンは SemVer 形式で入力してください (例: 0.1.0 または 0.1.0-alpha.4): ${raw}`,
    );
  }

  assertValidPrereleaseIdentifiers(match[4]);

  return {
    version,
    tag: `v${version}`,
    prerelease: match[4] !== undefined,
  };
}

function readCargoPackageVersion(cargoTomlPath) {
  const cargoToml = readFileSync(cargoTomlPath, "utf8");
  const packageStart = cargoToml.indexOf("[package]");
  const nextSection = cargoToml.indexOf("\n[", packageStart + "[package]".length);
  const packageSection =
    packageStart === -1
      ? undefined
      : cargoToml.slice(
          packageStart + "[package]".length,
          nextSection === -1 ? cargoToml.length : nextSection,
        );
  const version = packageSection?.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];

  if (!version) {
    throw new Error(`Cargo package versionを取得できません: ${cargoTomlPath}`);
  }

  return version;
}

export function readConfiguredVersions(projectRoot) {
  const root = resolve(projectRoot);
  const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const tauriConfig = JSON.parse(
    readFileSync(resolve(root, "src-tauri", "tauri.conf.json"), "utf8"),
  );

  return {
    "package.json": packageJson.version,
    "src-tauri/Cargo.toml": readCargoPackageVersion(resolve(root, "src-tauri", "Cargo.toml")),
    "src-tauri/tauri.conf.json": tauriConfig.version,
  };
}

export function assertConfiguredVersion(input, projectRoot) {
  const release = normalizeVersion(input);
  const configuredVersions = readConfiguredVersions(projectRoot);
  const mismatches = Object.entries(configuredVersions).filter(
    ([, configuredVersion]) => configuredVersion !== release.version,
  );

  if (mismatches.length > 0) {
    const details = mismatches
      .map(([file, configuredVersion]) => `${file}=${configuredVersion}`)
      .join(", ");
    throw new Error(`入力バージョン ${release.version} と設定が一致しません: ${details}`);
  }

  return release;
}

export function expectedPortableArchives(input) {
  const { version } = normalizeVersion(input);
  return [`MyMyTools_${version}_macos_aarch64.zip`, `MyMyTools_${version}_windows_x64.zip`];
}

export function assertPortableArchives(input, assetsDirectory) {
  const expected = expectedPortableArchives(input).sort();
  const directory = resolve(assetsDirectory);
  const actual = readdirSync(directory)
    .filter((name) => statSync(resolve(directory, name)).isFile())
    .sort();

  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `portable ZIPは2件ちょうど必要です。expected=${expected.join(", ")} actual=${actual.join(", ") || "(none)"}`,
    );
  }

  for (const archive of expected) {
    const archivePath = resolve(directory, archive);
    const stat = statSync(archivePath);
    const signature = readZipSignature(archivePath);

    if (stat.size === 0 || signature !== "PK") {
      throw new Error(`有効なZIPではありません: ${archive} (${stat.size} bytes)`);
    }
    if (stat.size > MAX_PORTABLE_ARCHIVE_BYTES) {
      throw new Error(
        `portable ZIPが上限 ${MAX_PORTABLE_ARCHIVE_BYTES} bytesを超えています: ${archive} (${stat.size} bytes)`,
      );
    }
  }

  return expected;
}

export function portableArchiveSizeReport(input, assetsDirectory, previousSizes = {}) {
  return expectedPortableArchives(input)
    .sort()
    .map((archive) => {
      const current = statSync(resolve(assetsDirectory, archive)).size;
      const previous = previousArchiveSize(previousSizes, archive);
      return {
        archive,
        current,
        previous,
        delta: previous == null ? null : current - previous,
      };
    });
}

function previousArchiveSize(previousSizes, archive) {
  const platformKey = archive.endsWith("_macos_aarch64.zip")
    ? "macos_aarch64"
    : archive.endsWith("_windows_x64.zip")
      ? "windows_x64"
      : undefined;
  for (const value of [previousSizes[archive], platformKey && previousSizes[platformKey]]) {
    const size = Number(value);
    if (Number.isFinite(size)) return size;
  }
  return null;
}

function readZipSignature(path) {
  const descriptor = openSync(path, "r");
  try {
    const signature = Buffer.alloc(2);
    readSync(descriptor, signature, 0, signature.length, 0);
    return signature.toString("ascii");
  } finally {
    closeSync(descriptor);
  }
}

function printArchiveReport(report) {
  for (const row of report) {
    const comparison =
      row.previous == null ? "previous=n/a" : `previous=${row.previous} delta=${row.delta}`;
    process.stdout.write(`${row.archive}: current=${row.current} ${comparison}\n`);
  }
}

function printGithubOutputs(release) {
  process.stdout.write(
    [`version=${release.version}`, `tag=${release.tag}`, `prerelease=${release.prerelease}`].join(
      "\n",
    ) + "\n",
  );
}

function runCli(argv) {
  const [command, input, target] = argv;

  switch (command) {
    case "normalize":
      printGithubOutputs(normalizeVersion(input));
      break;
    case "check-version":
      assertConfiguredVersion(input, target ?? process.cwd());
      break;
    case "check-assets":
      assertPortableArchives(input, target ?? process.cwd());
      printArchiveReport(
        portableArchiveSizeReport(
          input,
          target ?? process.cwd(),
          JSON.parse(process.env.PREVIOUS_ASSET_SIZES_JSON || "{}"),
        ),
      );
      break;
    default:
      throw new Error(`不明なコマンドです: ${command ?? "(none)"}`);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
