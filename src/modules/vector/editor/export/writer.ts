/**
 * 保存先の関数の登録口 (§4.9)。
 *
 * エディタはファイルの書き込み方を知らない。画面 (切替 PR では `VectorWorkspacePage`、
 * 開発用の画面では `dev/main.tsx`) が `setExportWriter` で関数を渡す。
 * 登録がない間は、書き出しのボタンを無効にする。
 */
import { useSyncExternalStore } from "react";

import type { ExportWriter } from "./types";

let current: ExportWriter | null = null;
const listeners = new Set<() => void>();

/** 保存先の関数を登録する。null で外す。外す関数を返す (登録したものがまだ今の関数のときだけ外す)。 */
export function setExportWriter(writer: ExportWriter | null): () => void {
  current = writer;
  for (const listener of listeners) listener();
  return () => {
    if (current === writer) setExportWriter(null);
  };
}

export function getExportWriter(): ExportWriter | null {
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 登録中の保存先の関数 (React 用)。登録が変わると描き直す。 */
export function useExportWriter(): ExportWriter | null {
  return useSyncExternalStore(subscribe, getExportWriter, getExportWriter);
}
