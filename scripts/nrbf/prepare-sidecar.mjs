import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

function valueAfter(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const defaults =
  process.platform === "darwin"
    ? { rid: "osx-arm64", target: "aarch64-apple-darwin" }
    : process.platform === "win32"
      ? { rid: "win-x64", target: "x86_64-pc-windows-msvc" }
      : { rid: "linux-x64", target: "x86_64-unknown-linux-gnu" };
const rid = valueAfter("--rid") ?? defaults.rid;
const target = valueAfter("--target") ?? defaults.target;
const root = resolve(import.meta.dirname, "../..");
const project = resolve(root, "tools/nrbf-decoder/NrbfDecoder.csproj");
const executableName =
  process.platform === "win32" || rid.startsWith("win-") ? "nrbf-decoder.exe" : "nrbf-decoder";

execFileSync(
  "dotnet",
  ["publish", project, "-c", "Release", "-r", rid, "-p:RestoreLockedMode=true", "--nologo"],
  { cwd: root, stdio: "inherit" },
);

const source = resolve(
  root,
  `tools/nrbf-decoder/bin/Release/net10.0/${rid}/publish/${executableName}`,
);
const binaries = resolve(root, "src-tauri/binaries");
const destination = resolve(
  binaries,
  `nrbf-decoder-${target}${rid.startsWith("win-") ? ".exe" : ""}`,
);
mkdirSync(binaries, { recursive: true });
copyFileSync(source, destination);
if (!rid.startsWith("win-")) chmodSync(destination, 0o755);
process.stdout.write(`Prepared ${destination}\n`);
