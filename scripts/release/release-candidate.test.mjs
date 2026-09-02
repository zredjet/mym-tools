import { execFileSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertCandidateManifest,
  createCandidateManifest,
  RELEASE_CANDIDATE_SCHEMA_VERSION,
  writeCandidateManifest,
} from "./release-candidate.mjs";

const temporaryDirectories = [];
const COMMIT = "1".repeat(40);
const TREE = "2".repeat(40);

function createTemporaryDirectory() {
  const directory = mkdtempSync(resolve(tmpdir(), "mym-tools-candidate-"));
  temporaryDirectories.push(directory);
  return directory;
}

function createWindowsArchive(root, version = "0.2.0") {
  const archivePath = resolve(root, `MyMyTools_${version}_windows_x64.zip`);
  writeFileSync(resolve(root, "MyMyTools.exe"), "binary");
  writeFileSync(resolve(root, "nrbf-decoder.exe"), "sidecar");
  execFileSync("zip", ["-q", archivePath, "MyMyTools.exe", "nrbf-decoder.exe"], {
    cwd: root,
  });
  return archivePath;
}

function candidateInput(root) {
  return {
    repository: "zredjet/mym-tools",
    runId: 123,
    runAttempt: 2,
    sourceCommit: COMMIT,
    sourceTree: TREE,
    version: "0.2.0",
    platform: "windows",
    archivePath: createWindowsArchive(root),
    tauriCliVersion: "tauri-cli 2.11.0",
    rustVersion: "rustc 1.88.0",
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("release candidate manifest", () => {
  it("生成元とZIPのSHA-256を記録する", async () => {
    const root = createTemporaryDirectory();
    const manifest = await createCandidateManifest(candidateInput(root));

    expect(manifest).toMatchObject({
      schemaVersion: RELEASE_CANDIDATE_SCHEMA_VERSION,
      repository: "zredjet/mym-tools",
      workflow: { runId: 123, runAttempt: 2 },
      source: { commit: COMMIT, tree: TREE },
      release: { version: "0.2.0" },
      platform: "windows",
      archive: {
        name: "MyMyTools_0.2.0_windows_x64.zip",
        size: expect.any(Number),
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
  });

  it("期待するrun・tree・versionと一致するmanifestだけを受理する", async () => {
    const root = createTemporaryDirectory();
    const input = candidateInput(root);
    const manifestPath = resolve(root, "release-candidate-windows.json");
    await writeCandidateManifest(input, manifestPath);

    await expect(
      assertCandidateManifest({
        manifestPath,
        archivePath: input.archivePath,
        repository: input.repository,
        runId: input.runId,
        runAttempt: input.runAttempt,
        sourceTree: input.sourceTree,
        version: input.version,
        platform: input.platform,
      }),
    ).resolves.toMatchObject({ platform: "windows" });
  });

  it("tree不一致を拒否する", async () => {
    const root = createTemporaryDirectory();
    const input = candidateInput(root);
    const manifestPath = resolve(root, "release-candidate-windows.json");
    await writeCandidateManifest(input, manifestPath);

    await expect(
      assertCandidateManifest({
        manifestPath,
        archivePath: input.archivePath,
        repository: input.repository,
        runId: input.runId,
        runAttempt: input.runAttempt,
        sourceTree: "3".repeat(40),
        version: input.version,
        platform: input.platform,
      }),
    ).rejects.toThrow("source.tree");
  });

  it.each([
    ["schemaVersion", (manifest) => (manifest.schemaVersion = 2), "schemaVersion"],
    ["repository", (manifest) => (manifest.repository = "other/repository"), "repository"],
    ["run ID", (manifest) => (manifest.workflow.runId = 999), "workflow.runId"],
    ["version", (manifest) => (manifest.release.version = "0.3.0"), "release.version"],
    ["platform", (manifest) => (manifest.platform = "macos"), "platform"],
  ])("%s不一致を拒否する", async (_label, mutate, expectedMessage) => {
    const root = createTemporaryDirectory();
    const input = candidateInput(root);
    const manifestPath = resolve(root, "release-candidate-windows.json");
    await writeCandidateManifest(input, manifestPath);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    mutate(manifest);
    writeFileSync(manifestPath, JSON.stringify(manifest));

    await expect(
      assertCandidateManifest({
        manifestPath,
        archivePath: input.archivePath,
        repository: input.repository,
        runId: input.runId,
        runAttempt: input.runAttempt,
        sourceTree: input.sourceTree,
        version: input.version,
        platform: input.platform,
      }),
    ).rejects.toThrow(expectedMessage);
  });

  it("manifest生成後に変更されたZIPを拒否する", async () => {
    const root = createTemporaryDirectory();
    const input = candidateInput(root);
    const manifestPath = resolve(root, "release-candidate-windows.json");
    await writeCandidateManifest(input, manifestPath);
    writeFileSync(input.archivePath, Buffer.from("changed"));

    await expect(
      assertCandidateManifest({
        manifestPath,
        archivePath: input.archivePath,
        repository: input.repository,
        runId: input.runId,
        runAttempt: input.runAttempt,
        sourceTree: input.sourceTree,
        version: input.version,
        platform: input.platform,
      }),
    ).rejects.toThrow(/size不一致|SHA-256不一致/);
  });

  it("manifestのrun attempt改ざんを拒否する", async () => {
    const root = createTemporaryDirectory();
    const input = candidateInput(root);
    const manifestPath = resolve(root, "release-candidate-windows.json");
    await writeCandidateManifest(input, manifestPath);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.workflow.runAttempt = 3;
    writeFileSync(manifestPath, JSON.stringify(manifest));

    await expect(
      assertCandidateManifest({
        manifestPath,
        archivePath: input.archivePath,
        repository: input.repository,
        runId: input.runId,
        runAttempt: input.runAttempt,
        sourceTree: input.sourceTree,
        version: input.version,
        platform: input.platform,
      }),
    ).rejects.toThrow("workflow.runAttempt");
  });
});
