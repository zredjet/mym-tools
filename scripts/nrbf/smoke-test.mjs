import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";

function valueAfter(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const target = valueAfter("--target");
if (target == null) throw new Error("--target is required");
const root = resolve(import.meta.dirname, "../..");
const suffix = target.includes("windows") ? ".exe" : "";
const sidecar = resolve(root, `src-tauri/binaries/nrbf-decoder-${target}${suffix}`);
const temporaryDirectory = mkdtempSync(join(tmpdir(), "mym-tools-nrbf-smoke-"));

try {
  const text = Buffer.from("NativeAOT疎通", "utf8");
  runFixture(
    "unicode.bin",
    Buffer.concat([
      header(),
      Buffer.from([6]),
      int32(1),
      sevenBit(text.length),
      text,
      Buffer.from([11]),
    ]),
    (response) =>
      response.nodes?.[0]?.kind === "scalar" &&
      response.nodes?.[0]?.formattedValue === "NativeAOT疎通" &&
      response.summary?.rootType === "System.String",
  );

  runFixture(
    "list.bin",
    Buffer.concat([
      header(),
      Buffer.from([12]),
      int32(10),
      nrbfString("Sample.Assembly"),
      Buffer.from([5]),
      int32(1),
      nrbfString("System.Collections.Generic.List`1[[System.String]]"),
      int32(3),
      nrbfString("_items"),
      nrbfString("_size"),
      nrbfString("_version"),
      Buffer.from([6, 0, 0, 8, 8]),
      int32(10),
      Buffer.from([17]),
      int32(2),
      int32(2),
      objectString(3, "a"),
      objectString(4, "b"),
      int32(2),
      int32(1),
      Buffer.from([11]),
    ]),
    (response) =>
      response.nodes?.some((node) => node.rawName === "[1]" && node.formattedValue === "b") &&
      response.nodes?.[0]?.recordId === "1",
  );

  runFixture(
    "jagged.bin",
    Buffer.concat([
      header(),
      Buffer.from([16]),
      int32(1),
      int32(1),
      Buffer.from([15]),
      int32(2),
      int32(1),
      Buffer.from([8]),
      int32(7),
      Buffer.from([11]),
    ]),
    (response) =>
      response.nodes?.filter((node) => node.kind === "array").length === 2 &&
      response.nodes?.some((node) => node.formattedValue === "7"),
  );

  runFixture(
    "bytes.bin",
    Buffer.concat([
      header(),
      Buffer.from([15]),
      int32(1),
      int32(3),
      Buffer.from([2, 1, 2, 255, 11]),
    ]),
    (response) =>
      response.nodes?.map((node) => node.kind).join(",") === "array,scalar,scalar,scalar" &&
      response.nodes
        ?.slice(1)
        .map((node) => node.formattedValue)
        .join(",") === "1,2,255",
    ["--expand-byte-arrays"],
  );

  process.stdout.write(`NativeAOT NRBF smoke test passed: ${target}\n`);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

function runFixture(fileName, payload, validate, extraArguments = []) {
  const payloadPath = join(temporaryDirectory, fileName);
  writeFileSync(payloadPath, payload);
  const result = spawnSync(sidecar, ["--inspect", payloadPath, ...extraArguments], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`sidecar failed (${result.status}): ${result.stdout}\n${result.stderr}`);
  const response = JSON.parse(result.stdout);
  if (response.ok !== true || !validate(response)) {
    throw new Error(`unexpected sidecar response for ${fileName}: ${result.stdout}`);
  }
}

function header() {
  return Buffer.concat([Buffer.from([0]), int32(1), int32(-1), int32(1), int32(0)]);
}

function nrbfString(value) {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([sevenBit(bytes.length), bytes]);
}

function objectString(id, value) {
  return Buffer.concat([Buffer.from([6]), int32(id), nrbfString(value)]);
}

function int32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeInt32LE(value);
  return bytes;
}

function sevenBit(value) {
  const bytes = [];
  let remaining = value >>> 0;
  while (remaining >= 0x80) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining >>>= 7;
  }
  bytes.push(remaining);
  return Buffer.from(bytes);
}
