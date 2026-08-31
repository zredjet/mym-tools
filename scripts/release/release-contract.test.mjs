import { Buffer } from "node:buffer";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertConfiguredVersion,
  assertPortableArchives,
  expectedPortableArchives,
  MAX_PORTABLE_ARCHIVE_BYTES,
  normalizeVersion,
  portableArchiveSizeReport,
} from "./release-contract.mjs";

const temporaryDirectories = [];

function createTemporaryDirectory() {
  const directory = mkdtempSync(resolve(tmpdir(), "mym-tools-release-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeProjectVersions(root, versions) {
  mkdirSync(resolve(root, "src-tauri"), { recursive: true });
  writeFileSync(resolve(root, "package.json"), JSON.stringify({ version: versions.package }));
  writeFileSync(
    resolve(root, "src-tauri", "Cargo.toml"),
    `[package]\nname = "mym-tools"\nversion = "${versions.cargo}"\n\n[dependencies]\n`,
  );
  writeFileSync(
    resolve(root, "src-tauri", "tauri.conf.json"),
    JSON.stringify({ version: versions.tauri }),
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("normalizeVersion", () => {
  it("v付き入力を正規化する", () => {
    expect(normalizeVersion("v0.1.0-alpha.4")).toEqual({
      version: "0.1.0-alpha.4",
      tag: "v0.1.0-alpha.4",
      prerelease: true,
    });
  });

  it("SemVerでない入力を拒否する", () => {
    expect(() => normalizeVersion("release-1")).toThrow("SemVer");
    expect(() => normalizeVersion("1.0.0-alpha.01")).toThrow("先行ゼロ");
  });
});

describe("assertConfiguredVersion", () => {
  it("3つの設定ファイルが入力バージョンと一致する場合だけ通す", () => {
    const root = createTemporaryDirectory();
    writeProjectVersions(root, {
      package: "0.2.0",
      cargo: "0.2.0",
      tauri: "0.2.0",
    });

    expect(assertConfiguredVersion("0.2.0", root).tag).toBe("v0.2.0");
  });

  it("設定ファイルのバージョン不一致を拒否する", () => {
    const root = createTemporaryDirectory();
    writeProjectVersions(root, {
      package: "0.2.0",
      cargo: "0.1.0",
      tauri: "0.2.0",
    });

    expect(() => assertConfiguredVersion("0.2.0", root)).toThrow("src-tauri/Cargo.toml=0.1.0");
  });
});

describe("assertPortableArchives", () => {
  it("macOSとWindowsの有効なZIPが1件ずつある場合だけ通す", () => {
    const root = createTemporaryDirectory();
    for (const archive of expectedPortableArchives("0.2.0")) {
      writeFileSync(resolve(root, archive), Buffer.from("PK\u0003\u0004content"));
    }

    expect(assertPortableArchives("0.2.0", root)).toEqual(expectedPortableArchives("0.2.0").sort());
  });

  it("成果物不足を成功扱いにしない", () => {
    const root = createTemporaryDirectory();
    const [macArchive] = expectedPortableArchives("0.2.0");
    writeFileSync(resolve(root, macArchive), Buffer.from("PK\u0003\u0004content"));

    expect(() => assertPortableArchives("0.2.0", root)).toThrow("2件ちょうど必要");
  });

  it("空ファイルやZIPでない成果物を拒否する", () => {
    const root = createTemporaryDirectory();
    const [macArchive, windowsArchive] = expectedPortableArchives("0.2.0");
    writeFileSync(resolve(root, macArchive), Buffer.from("not-a-zip"));
    writeFileSync(resolve(root, windowsArchive), Buffer.from("PK\u0003\u0004content"));

    expect(() => assertPortableArchives("0.2.0", root)).toThrow("有効なZIPではありません");
  });

  it("80,000,000 bytesを超えるportable ZIPを拒否する", () => {
    const root = createTemporaryDirectory();
    const [macArchive, windowsArchive] = expectedPortableArchives("0.2.0");
    writeFileSync(resolve(root, macArchive), Buffer.from("PK\u0003\u0004content"));
    truncateSync(resolve(root, macArchive), MAX_PORTABLE_ARCHIVE_BYTES + 1);
    writeFileSync(resolve(root, windowsArchive), Buffer.from("PK\u0003\u0004content"));

    expect(() => assertPortableArchives("0.2.0", root)).toThrow("80000000");
  });

  it("前リリースからのサイズ増減を報告する", () => {
    const root = createTemporaryDirectory();
    const archives = expectedPortableArchives("0.2.0");
    for (const archive of archives) writeFileSync(resolve(root, archive), Buffer.from("PK1234"));

    expect(
      portableArchiveSizeReport("0.2.0", root, {
        macos_aarch64: 4,
        windows_x64: 8,
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          archive: "MyMyTools_0.2.0_macos_aarch64.zip",
          current: 6,
          previous: 4,
          delta: 2,
        }),
        expect.objectContaining({
          archive: "MyMyTools_0.2.0_windows_x64.zip",
          current: 6,
          previous: 8,
          delta: -2,
        }),
      ]),
    );
  });
});
