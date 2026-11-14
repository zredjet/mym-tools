import { nanoid } from "nanoid";

/** 新しく振る ID の長さ。`limits.json` の `idPattern` (1〜32 文字の `A-Za-z0-9_-`) に収まる。 */
export const ID_LENGTH = 12;

/** `Object.hasOwn` の代わり (tsconfig の lib が ES2020 のため)。 */
export function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/**
 * 表 (`nodes` / `assets`) から自分のプロパティだけを引く。
 * `constructor` や `toString` のような ID で `Object.prototype` のものを拾わない。
 */
export function getOwn<T>(record: Record<string, T>, key: string): T | undefined {
  return hasOwn(record, key) ? record[key] : undefined;
}

/**
 * 表に値を置く。`record[key] = value` は key が `__proto__` だとプロトタイプを書き換えるので、
 * 必ず自分のプロパティとして定義する (`__proto__` は検証で拒否するが、念のため)。
 */
export function setOwn<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/**
 * ノード・ページ・アセットの新しい ID を作る。nanoid の既定の文字 (`A-Za-z0-9_-`) で 12 文字。
 * `taken` を渡すと、その中にない ID になるまで作り直す (衝突はまず起きないが、念のため)。
 */
export function createId(taken?: object): string {
  for (;;) {
    const id = nanoid(ID_LENGTH);
    if (taken === undefined || !hasOwn(taken, id)) return id;
  }
}
