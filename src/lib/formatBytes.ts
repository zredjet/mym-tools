const UNITS = ["KB", "MB", "GB", "TB", "PB"] as const;

/** バイト数を 1024 基準の単位で表す (1023 B / 1.5 KB / 12.3 GB)。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${UNITS[unit]}`;
}
