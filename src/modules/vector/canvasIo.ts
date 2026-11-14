/**
 * キャンバスのファイルの入出力をアプリ (Tauri の IPC とファイルのダイアログ) につなぐ
 * (`docs/canvas-editor-design.md` §4.8 / §4.9)。エディタはファイルの選び方と書き方を知らないので、
 * 画面 (`VectorWorkspacePage`) がここの関数を `setImportFileReader` / `setExportWriter` に登録する。
 *
 * 検証 (大きさ、種類、SVG ポリシー、draw.io の SVG の変換) は Rust の `vector_read_*` /
 * `vector_write_file` が行う。
 */
import { open, save } from "@tauri-apps/plugin-dialog";
import { vectorReadFile, vectorReadImage, vectorWriteFile } from "@/ipc/vector";
import { formatInvokeError } from "@/lib/error";
import type { ImportedFile, ImportFileReader } from "./editor/assets";
import type { ExportWriter } from "./editor/export";
import { screenToPage } from "./editor/canvas/viewport";
import type { Point } from "./editor/model/types";
import type { Viewport } from "./editor/state/types";

/** 取り込めるファイルの拡張子。SVG は埋め込み SVG、ほかは画像として置く。 */
export const IMPORT_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "svg"];

/**
 * IPC のエラーを利用者に見せる文にする。Rust の `AppError` は `{ code, message: { reason } }` の形で
 * 届くので、理由があれば理由だけにする。
 */
export function describeInvokeError(cause: unknown): string {
  if (typeof cause === "object" && cause !== null && !(cause instanceof Error)) {
    const message = (cause as { message?: unknown }).message;
    if (typeof message === "object" && message !== null) {
      const reason = (message as { reason?: unknown }).reason;
      if (typeof reason === "string" && reason !== "") return reason;
    }
  }
  return formatInvokeError(cause);
}

/**
 * IPC のエラーを、理由を `message` に持つ `Error` にする (エディタは `message` をそのまま表示する)。
 * 元のエラーは `cause` に残す。
 */
function readableError(cause: unknown): Error {
  const error = new Error(describeInvokeError(cause));
  Object.assign(error, { cause });
  return error;
}

/** path の最後の要素 (区切りは `/` と `\`)。 */
function lastSegment(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return path.slice(index + 1);
}

/** 拡張子を除いたファイル名 (ノードの名前に使う)。 */
export function fileStem(path: string): string {
  const name = lastSegment(path);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? name : name.slice(0, dot);
}

function extensionOf(path: string): string {
  const name = lastSegment(path);
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/**
 * 選んだ・ドロップしたファイルを読む。SVG は `vector_read_file` (draw.io の SVG の変換を含む)、
 * ほかは `vector_read_image`。読めなければ、Rust の理由を持つ `Error` を投げる。
 */
export async function readImportPath(path: string): Promise<ImportedFile> {
  const name = fileStem(path);
  try {
    if (extensionOf(path) === "svg") {
      const result = await vectorReadFile(path);
      return { kind: "svg", svg: result.svg, text: result.text, notices: result.notices, name };
    }
    return { kind: "image", dataUrl: await vectorReadImage(path), name };
  } catch (cause) {
    throw readableError(cause);
  }
}

/** ファイル選択 (`plugin-dialog`) で 1 つ選んで読む。取り消したら null。 */
export const pickImportFile: ImportFileReader = async () => {
  const path = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "画像・SVG", extensions: IMPORT_EXTENSIONS }],
  });
  if (typeof path !== "string") return null;
  return readImportPath(path);
};

/** `previous` と同じフォルダの `name` (保存ダイアログの既定の場所に使う)。 */
export function siblingPath(previous: string, name: string): string {
  const index = Math.max(previous.lastIndexOf("/"), previous.lastIndexOf("\\"));
  return index < 0 ? name : `${previous.slice(0, index + 1)}${name}`;
}

/**
 * 書き出したファイルを保存する。ファイルごとに保存ダイアログを出し (上書きの確認は OS のダイアログに
 * 任せる)、2 つ目からは直前に選んだフォルダを既定にする。取り消したら、そこで止めて書いた数を返す。
 */
export const writeExportFiles: ExportWriter = async (files) => {
  let written = 0;
  let previous: string | null = null;
  for (const file of files) {
    const path = await save({
      defaultPath: previous === null ? file.fileName : siblingPath(previous, file.fileName),
      filters: [{ name: file.format.toUpperCase(), extensions: [file.format] }],
    });
    if (!path) break;
    try {
      await vectorWriteFile(path, file.format, file.data);
    } catch (cause) {
      throw readableError(cause);
    }
    written += 1;
    previous = path;
  }
  return { written };
};

/**
 * OS からドロップした位置 (Tauri の `onDragDropEvent` の位置。webview の左上からの物理 px) を、
 * キャンバスのページ座標にする。キャンバスの外なら null (呼び出し側は表示範囲の中央に置く)。
 * キャンバスのポインターと同じく、`clientX - キャンバスの左上` を画面座標とする (`useCanvasInput`)。
 */
export function dropPointOnCanvas(
  position: { x: number; y: number },
  viewport: Viewport,
  root: ParentNode = document,
  devicePixelRatio: number = window.devicePixelRatio || 1,
): Point | null {
  const canvas = root.querySelector("[data-canvas-view]");
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const ratio = devicePixelRatio > 0 ? devicePixelRatio : 1;
  const client = { x: position.x / ratio, y: position.y / ratio };
  if (
    client.x < rect.left ||
    client.y < rect.top ||
    client.x > rect.left + rect.width ||
    client.y > rect.top + rect.height
  )
    return null;
  return screenToPage(viewport, { x: client.x - rect.left, y: client.y - rect.top });
}
