export function secureBytes(length: number): Uint8Array {
  if (!Number.isInteger(length) || length < 1 || length > 65_536) {
    throw new Error("乱数バイト長が範囲外です");
  }
  const output = new Uint8Array(length);
  for (let offset = 0; offset < length; offset += 65_536) {
    crypto.getRandomValues(output.subarray(offset, Math.min(offset + 65_536, length)));
  }
  return output;
}

export function secureIndex(upperExclusive: number): number {
  if (!Number.isInteger(upperExclusive) || upperExclusive < 1 || upperExclusive > 256) {
    throw new Error("乱数の選択肢数が範囲外です");
  }
  const limit = 256 - (256 % upperExclusive);
  while (true) {
    const value = secureBytes(1)[0]!;
    if (value < limit) return value % upperExclusive;
  }
}

export function secureString(alphabet: string, length: number): string {
  const symbols = [...new Set([...alphabet])];
  if (symbols.length < 2 || symbols.length > 256)
    throw new Error("文字集合は2〜256文字にしてください");
  if (!Number.isInteger(length) || length < 1) throw new Error("長さは1以上にしてください");
  return Array.from({ length }, () => symbols[secureIndex(symbols.length)]).join("");
}

export function secureShuffle<T>(values: readonly T[]): T[] {
  const output = [...values];
  for (let index = output.length - 1; index > 0; index -= 1) {
    const swapWith = secureIndex(index + 1);
    [output[index], output[swapWith]] = [output[swapWith]!, output[index]!];
  }
  return output;
}
