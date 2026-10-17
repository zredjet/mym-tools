/** 原因になりやすいフォルダの説明 (ui-design §6.27)。名前の大文字小文字は区別しない */
export interface FolderHint {
  title: string;
  description: string;
}

const RECYCLE_BIN = "$recycle.bin";

const WINDOWS_HINTS = new Map<string, FolderHint>([
  [
    "system volume information",
    {
      title: "復元ポイント・シャドウコピー",
      description:
        "Windows の「システムの保護」が使う領域です。「システムのプロパティ > システムの保護 > 構成」で使用量の確認と削除ができます。",
    },
  ],
  [
    RECYCLE_BIN,
    {
      title: "ごみ箱",
      description:
        "ドライブごとのごみ箱です。ユーザーごとのフォルダに分かれていて、ほかのユーザーの分は読めません。",
    },
  ],
  [
    "windowsapps",
    {
      title: "ストアアプリ",
      description:
        "Microsoft Store のアプリが入るフォルダです。「設定 > アプリ > インストールされているアプリ」で大きさの確認とアンインストールができます。",
    },
  ],
]);

/** フォルダ名 (ごみ箱の中のユーザーごとのフォルダは親の名前) から説明を引く */
export function knownFolderHint(
  name: string,
  parentName: string | null,
  isWindows: boolean,
): FolderHint | null {
  if (!isWindows) return null;
  const own = WINDOWS_HINTS.get(name.toLowerCase());
  if (own != null) return own;
  if (parentName?.toLowerCase() === RECYCLE_BIN) return WINDOWS_HINTS.get(RECYCLE_BIN)!;
  return null;
}

/** 読めないフォルダの案内 */
export function unreadableGuidance(isWindows: boolean): string {
  return isWindows
    ? "管理者権限が必要なフォルダです。中身の大きさは集計に含まれていません。"
    : "macOS のプライバシー保護で読めないフォルダです。「システム設定 > プライバシーとセキュリティ > フルディスクアクセス」で MyMyTools を許可すると読める場合があります。中身の大きさは集計に含まれていません。";
}
