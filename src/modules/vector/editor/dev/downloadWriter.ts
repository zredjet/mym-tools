/**
 * 開発用の画面の保存先 (§4.9)。ブラウザのダウンロードで保存する。アプリの画面からは参照しない。
 * 検証のため、直前に書き出したファイルを `window.__canvasExports` に残す。
 */
import type { ExportFile, ExportWriter } from "../export/types";

declare global {
  interface Window {
    /** 直前に書き出したファイル (開発用の画面だけ) */
    __canvasExports?: readonly ExportFile[];
  }
}

function toBlob(file: ExportFile): Blob {
  if (file.format === "svg") return new Blob([file.data], { type: "image/svg+xml;charset=utf-8" });
  const base64 = file.data.slice(file.data.indexOf(",") + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: "image/png" });
}

export const downloadWriter: ExportWriter = async (files) => {
  window.__canvasExports = files;
  for (const file of files) {
    const url = URL.createObjectURL(toBlob(file));
    const link = document.createElement("a");
    link.href = url;
    link.download = file.fileName;
    link.style.display = "none";
    document.body.append(link);
    link.click();
    link.remove();
    // ダウンロードが始まる前に URL を捨てないよう、少し待ってから解放する
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
  return { written: files.length };
};
