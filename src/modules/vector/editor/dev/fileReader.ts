/**
 * 開発用の画面のファイルを読む関数 (§4.8)。`<input type="file">` で画像と SVG を選んで読む。
 * アプリの画面からは参照しない (切替 PR が `plugin-dialog` と `vector_read_image` / `vector_read_file` につなぐ)。
 *
 * Rust の検証の代わりに、大きさと種類だけを確かめる。SVG の `text` は Rust の代わりに
 * `validateSvg` で抽出する (draw.io の SVG の変換はしない)。
 *
 * 検証のため、`window.__canvasImport` から次に読むファイルを差し込める (ファイル選択を開かずに、
 * ボタンや画像ツールの流れを試せる)。
 *   __canvasImport.queue({ kind: "image", dataUrl, name })   次の 1 回はこれを返す (null は取り消し)
 *   __canvasImport.importAt(file, { x, y })                   OS からのドロップの代わり
 *   __canvasImport.pngDataUrl(width, height, color)          試し用の PNG を作る
 */
import policy from "../../../../../scripts/svgedit/policy.json";
import { validateSvg } from "../../../../../scripts/svgedit/svg-policy.js";
import { importFile } from "../assets/importFile";
import type { ImportedFile, ImportFileReader } from "../assets/types";
import type { Point } from "../model/types";
import { editorStore } from "../state/store";

/** Rust の `read_bounded` と同じ 20 MiB。 */
const MAX_FILE_BYTES = 20 * 1024 * 1024;

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

function baseName(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? name : name.slice(0, dot);
}

/** 先頭のバイトが種類と合うか (Rust の `validate_image` の簡易版)。 */
function matchesSignature(bytes: Uint8Array, mime: string): boolean {
  const starts = (prefix: number[], at = 0) => prefix.every((b, i) => bytes[at + i] === b);
  const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
  if (mime === "image/png") return bytes.length >= 24 && starts([0x89, 0x50, 0x4e, 0x47]);
  if (mime === "image/jpeg") return bytes.length >= 4 && starts([0xff, 0xd8, 0xff]);
  return bytes.length >= 12 && starts(ascii("RIFF")) && starts(ascii("WEBP"), 8);
}

function readAs<T extends string | ArrayBuffer>(
  file: File,
  how: "text" | "dataUrl" | "buffer",
): Promise<T> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as T);
    reader.onerror = () => reject(reader.error ?? new Error("ファイルを読み込めません。"));
    if (how === "text") reader.readAsText(file);
    else if (how === "dataUrl") reader.readAsDataURL(file);
    else reader.readAsArrayBuffer(file.slice(0, 24));
  });
}

/** 選んだファイルを読む (Rust の `vector_read_image` / `vector_read_file` の代わり)。 */
export async function readHarnessFile(file: File): Promise<ImportedFile> {
  if (file.size > MAX_FILE_BYTES) throw new Error("ファイルは20MiB以下にしてください。");
  const ext = extension(file.name);
  const name = baseName(file.name);
  if (ext === "svg") {
    const svg = await readAs<string>(file, "text");
    const { text } = validateSvg(svg, policy);
    return { kind: "svg", svg, text, notices: [], name };
  }
  const mime = IMAGE_TYPES[ext];
  if (!mime) throw new Error("PNG/JPEG/WebP/SVGを選択してください。");
  const head = new Uint8Array(await readAs<ArrayBuffer>(file, "buffer"));
  if (!matchesSignature(head, mime)) throw new Error("画像の形式と内容が一致しません。");
  const dataUrl = await readAs<string>(file, "dataUrl");
  if (dataUrl.length > MAX_FILE_BYTES) throw new Error("埋め込み画像が20MiBを超えます。");
  return { kind: "image", dataUrl, name };
}

/** 次の 1 回に返すファイル (検証用)。undefined ならファイル選択を開く。 */
let queued: ImportedFile | null | undefined;

/** `<input type="file">` でファイルを選ぶ。取り消したら null。 */
function pickFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".png,.jpg,.jpeg,.webp,.svg";
    let settled = false;
    const settle = (file: File | null) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("focus", onFocus);
      resolve(file);
    };
    // 取り消しは `cancel` (新しいブラウザ) か、ウィンドウにフォーカスが戻っても選ばれないことで知る
    const onFocus = () => window.setTimeout(() => settle(input.files?.[0] ?? null), 1000);
    input.addEventListener("change", () => settle(input.files?.[0] ?? null));
    input.addEventListener("cancel", () => settle(null));
    window.addEventListener("focus", onFocus);
    input.click();
  });
}

export const harnessFileReader: ImportFileReader = async () => {
  if (queued !== undefined) {
    const file = queued;
    queued = undefined;
    return file;
  }
  const file = await pickFile();
  return file ? readHarnessFile(file) : null;
};

declare global {
  interface Window {
    /** 取込の検証用 (開発用の画面だけ) */
    __canvasImport?: {
      queue(file: ImportedFile | null): void;
      importAt(file: ImportedFile, at?: Point): Promise<boolean>;
      pngDataUrl(width: number, height: number, color?: string): string;
    };
  }
}

/** 試し用の単色の PNG (data URL)。 */
function pngDataUrl(width: number, height: number, color = "#2563EB"): string {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context) {
    context.fillStyle = color;
    context.fillRect(0, 0, width, height);
  }
  return canvas.toDataURL("image/png");
}

export function exposeImportHarness(): void {
  window.__canvasImport = {
    queue(file) {
      queued = file;
    },
    importAt: (file, at) => importFile(editorStore, file, at ? { at } : {}),
    pngDataUrl,
  };
}
