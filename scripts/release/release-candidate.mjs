import { createHash } from "node:crypto";
import { createReadStream, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { expectedPortableArchives, normalizeVersion } from "./release-contract.mjs";

export const RELEASE_CANDIDATE_SCHEMA_VERSION = 1;

const PLATFORM_INDEX = {
  macos: 0,
  windows: 1,
};

function requireValue(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new Error(`${label}は必須です`);
  }
  return normalized;
}

function requirePositiveInteger(value, label) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new Error(`${label}は正の整数でなければなりません: ${value}`);
  }
  return normalized;
}

function requireGitObjectId(value, label) {
  const normalized = requireValue(value, label).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(normalized)) {
    throw new Error(`${label}がGit object IDではありません: ${value}`);
  }
  return normalized;
}

function expectedArchiveForPlatform(version, platform) {
  const index = PLATFORM_INDEX[platform];
  if (index === undefined) {
    throw new Error(`未対応platformです: ${platform}`);
  }
  return expectedPortableArchives(version)[index];
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export async function createCandidateManifest({
  repository,
  runId,
  runAttempt,
  sourceCommit,
  sourceTree,
  version,
  platform,
  archivePath,
  tauriCliVersion,
  rustVersion,
}) {
  const normalizedVersion = normalizeVersion(version).version;
  const expectedArchive = expectedArchiveForPlatform(normalizedVersion, platform);
  const archive = resolve(archivePath);
  const archiveName = basename(archive);
  if (archiveName !== expectedArchive) {
    throw new Error(`candidate ZIP名が不正です: expected=${expectedArchive} actual=${archiveName}`);
  }

  const archiveStat = statSync(archive);
  if (!archiveStat.isFile() || archiveStat.size === 0) {
    throw new Error(`candidate ZIPが空またはファイルではありません: ${archive}`);
  }

  return {
    schemaVersion: RELEASE_CANDIDATE_SCHEMA_VERSION,
    repository: requireValue(repository, "repository"),
    workflow: {
      runId: requirePositiveInteger(runId, "workflow.runId"),
      runAttempt: requirePositiveInteger(runAttempt, "workflow.runAttempt"),
    },
    source: {
      commit: requireGitObjectId(sourceCommit, "source.commit"),
      tree: requireGitObjectId(sourceTree, "source.tree"),
    },
    release: { version: normalizedVersion },
    platform,
    archive: {
      name: archiveName,
      size: archiveStat.size,
      sha256: await sha256File(archive),
    },
    tools: {
      tauriCli: requireValue(tauriCliVersion, "tools.tauriCli"),
      rustc: requireValue(rustVersion, "tools.rustc"),
    },
  };
}

export async function writeCandidateManifest(input, manifestPath) {
  const manifest = await createCandidateManifest(input);
  writeFileSync(resolve(manifestPath), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

export async function assertCandidateManifest({
  manifestPath,
  archivePath,
  repository,
  runId,
  runAttempt,
  sourceTree,
  version,
  platform,
}) {
  const manifest = JSON.parse(readFileSync(resolve(manifestPath), "utf8"));
  const archive = resolve(archivePath);
  const expected = {
    repository: requireValue(repository, "repository"),
    runId: requirePositiveInteger(runId, "workflow.runId"),
    runAttempt: requirePositiveInteger(runAttempt, "workflow.runAttempt"),
    sourceTree: requireGitObjectId(sourceTree, "source.tree"),
    version: normalizeVersion(version).version,
    platform,
    archiveName: expectedArchiveForPlatform(version, platform),
  };

  const actualPairs = [
    ["schemaVersion", manifest.schemaVersion, RELEASE_CANDIDATE_SCHEMA_VERSION],
    ["repository", manifest.repository, expected.repository],
    ["workflow.runId", manifest.workflow?.runId, expected.runId],
    ["workflow.runAttempt", manifest.workflow?.runAttempt, expected.runAttempt],
    ["source.tree", manifest.source?.tree, expected.sourceTree],
    ["release.version", manifest.release?.version, expected.version],
    ["platform", manifest.platform, expected.platform],
    ["archive.name", manifest.archive?.name, expected.archiveName],
  ];
  for (const [label, actual, expectedValue] of actualPairs) {
    if (actual !== expectedValue) {
      throw new Error(
        `candidate manifest不一致: ${label} expected=${expectedValue} actual=${actual}`,
      );
    }
  }

  requireGitObjectId(manifest.source?.commit, "source.commit");
  requireValue(manifest.tools?.tauriCli, "tools.tauriCli");
  requireValue(manifest.tools?.rustc, "tools.rustc");

  const archiveStat = statSync(archive);
  if (basename(archive) !== expected.archiveName) {
    throw new Error(
      `candidate ZIP名が不正です: expected=${expected.archiveName} actual=${basename(archive)}`,
    );
  }
  if (archiveStat.size !== manifest.archive?.size) {
    throw new Error(
      `candidate ZIP size不一致: expected=${manifest.archive?.size} actual=${archiveStat.size}`,
    );
  }
  const digest = await sha256File(archive);
  if (digest !== manifest.archive?.sha256) {
    throw new Error(
      `candidate ZIP SHA-256不一致: expected=${manifest.archive?.sha256} actual=${digest}`,
    );
  }

  return manifest;
}

async function runCli(argv) {
  const [command, platform, archivePath, manifestPath] = argv;
  const common = {
    repository: process.env.CANDIDATE_REPOSITORY,
    runId: process.env.CANDIDATE_RUN_ID,
    runAttempt: process.env.CANDIDATE_RUN_ATTEMPT,
    sourceTree: process.env.CANDIDATE_SOURCE_TREE,
    version: process.env.CANDIDATE_VERSION,
    platform,
    archivePath,
    manifestPath,
  };

  switch (command) {
    case "create":
      await writeCandidateManifest(
        {
          ...common,
          sourceCommit: process.env.CANDIDATE_SOURCE_COMMIT,
          tauriCliVersion: process.env.CANDIDATE_TAURI_CLI_VERSION,
          rustVersion: process.env.CANDIDATE_RUST_VERSION,
        },
        manifestPath,
      );
      break;
    case "verify":
      await assertCandidateManifest(common);
      break;
    default:
      throw new Error(`不明なコマンドです: ${command ?? "(none)"}`);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  try {
    await runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
