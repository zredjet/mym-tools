/**
 * Link (`type=path`) を OS で開く前に確認が要るかの判定。
 *
 * 既定アプリで「開く」と実行されるファイル (アプリ / スクリプト / インストーラ / ショートカット)
 * は、インポートした JSON 由来の Link 1 クリックで任意コードが動き得るため、開く前に確認する。
 * UNC (ネットワーク共有) は Rust 側 `linkmemo_open` が拒否する。
 */
const EXECUTABLE_EXTENSIONS = new Set([
  // macOS
  "app",
  "command",
  "tool",
  "terminal",
  "workflow",
  "scpt",
  "applescript",
  "pkg",
  "mpkg",
  "dmg",
  "webloc",
  "inetloc",
  // Windows
  "exe",
  "com",
  "bat",
  "cmd",
  "msi",
  "msix",
  "appx",
  "ps1",
  "psm1",
  "vbs",
  "vbe",
  "js",
  "jse",
  "wsf",
  "wsh",
  "hta",
  "scr",
  "cpl",
  "lnk",
  "url",
  "pif",
  "reg",
  "appref-ms",
  "application",
  "library-ms",
  "search-ms",
  "settingcontent-ms",
  // 共通
  "sh",
  "bash",
  "zsh",
  "jar",
]);

export function requiresOpenConfirmation(target: string): boolean {
  // 末尾の区切り (`Foo.app/`) を除いた最後の要素の拡張子を見る
  const trimmed = target.trim().replace(/[\\/]+$/, "");
  const name = trimmed.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return EXECUTABLE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}
