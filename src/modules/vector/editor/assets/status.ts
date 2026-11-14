/**
 * 取込の状態 (取込中か、利用者に示す知らせ)。文書にも store にも入れない (履歴や未保存の判定に関係しない)。
 * ツールバーの「画像」のボタンと `ImportNotice` が `useSyncExternalStore` で購読する。
 */
import { useSyncExternalStore } from "react";

export interface ImportNoticeState {
  /** `error` は取り込まなかった理由、`info` は取り込んだときの知らせ (draw.io の SVG の変換など) */
  tone: "error" | "info";
  message: string;
}

export interface ImportStatus {
  busy: boolean;
  notice: ImportNoticeState | null;
}

const IDLE: ImportStatus = { busy: false, notice: null };

let current: ImportStatus = IDLE;
const listeners = new Set<() => void>();

function update(patch: Partial<ImportStatus>): void {
  const next = { ...current, ...patch };
  if (next.busy === current.busy && next.notice === current.notice) return;
  current = next.busy || next.notice ? next : IDLE;
  for (const listener of listeners) listener();
}

export function getImportStatus(): ImportStatus {
  return current;
}

export function setImportBusy(busy: boolean): void {
  update({ busy });
}

export function showImportNotice(notice: ImportNoticeState | null): void {
  update({ notice });
}

/** テスト用: 状態を捨てる。 */
export function resetImportStatus(): void {
  update(IDLE);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useImportStatus(): ImportStatus {
  return useSyncExternalStore(subscribe, getImportStatus, getImportStatus);
}
