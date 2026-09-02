import { statSync } from "node:fs";
import process from "node:process";

export const MAX_ARCHIVE_BYTES = 80_000_000;
export const MAX_BASELINE_DELTA_BYTES = 10_000_000;

export function checkSizeGate(archivePath, baselineBytes) {
  const currentBytes = statSync(archivePath).size;
  const baseline = Number(baselineBytes);
  if (!Number.isSafeInteger(baseline) || baseline <= 0) {
    throw new Error(`基準サイズが不正です: ${baselineBytes}`);
  }

  const deltaBytes = currentBytes - baseline;
  if (currentBytes > MAX_ARCHIVE_BYTES) {
    throw new Error(`ZIP総サイズが上限を超えています: ${currentBytes} > ${MAX_ARCHIVE_BYTES}`);
  }
  if (deltaBytes > MAX_BASELINE_DELTA_BYTES) {
    throw new Error(
      `alpha.10からのZIP増分が上限を超えています: ${deltaBytes} > ${MAX_BASELINE_DELTA_BYTES}`,
    );
  }
  return { currentBytes, baselineBytes: baseline, deltaBytes };
}

if (process.argv[1]?.endsWith("check-size-gate.mjs")) {
  try {
    const report = checkSizeGate(process.argv[2], process.argv[3]);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
