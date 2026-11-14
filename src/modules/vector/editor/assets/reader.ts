/**
 * ファイルを読む関数の登録口 (§4.8)。`export/writer.ts` と同じ形。
 *
 * エディタはファイルの選び方と読み方を知らない。画面 (切替 PR では `VectorWorkspacePage`、
 * 開発用の画面では `dev/main.tsx`) が `setImportFileReader` で関数を渡す。
 * 登録がない間は、ツールバーの「画像」のボタンを無効にする。
 */
import { useSyncExternalStore } from "react";
import type { ImportFileReader } from "./types";

let current: ImportFileReader | null = null;
const listeners = new Set<() => void>();

/** ファイルを読む関数を登録する。null で外す。外す関数を返す (登録したものがまだ今の関数のときだけ外す)。 */
export function setImportFileReader(reader: ImportFileReader | null): () => void {
  current = reader;
  for (const listener of listeners) listener();
  return () => {
    if (current === reader) setImportFileReader(null);
  };
}

export function getImportFileReader(): ImportFileReader | null {
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 登録中のファイルを読む関数 (React 用)。登録が変わると描き直す。 */
export function useImportFileReader(): ImportFileReader | null {
  return useSyncExternalStore(subscribe, getImportFileReader, getImportFileReader);
}
