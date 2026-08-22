# MyMyTools

個人用ローカルツールの集合体 — プロンプト管理 / リンク・メモ / カラー / ハッシュ計算 / カラーパレット作成。

## v0.1.0-alpha.5 の主な変更

- Adobe Colorの作成体験を参考にした独立M-Paletteを追加
- 5色固定、9種類の調和ルール、色相環、ロック、並び替え、Random、Undo/Redoに対応
- HEX / RGB / HSL / OKLCH編集、プロジェクト別保存、検索、保存済み一覧に対応
- ライト / ダークテーマと`Cmd/Ctrl + 5`のモジュール切替に対応

## 含まれるportable ZIP

- **macOS**: `MyMyTools_*_macos_aarch64.zip` (Apple Silicon専用 / Intel Mac非対応)
- **Windows**: `MyMyTools_*_windows_x64.zip` (x64)

## インストール / 更新

1. このページのAssetsから自分のOSのZIPをダウンロード
2. **macOS**: ZIPを展開し、`MyMyTools.app`をApplicationsへ移動または既存版と差し替え
3. **Windows**: ZIPを任意のフォルダへ展開し、`MyMyTools.exe`を起動または既存版と差し替え

ユーザーデータはアプリ本体と別の場所に保存されるため、アプリを差し替えても維持されます。

## OS警告 / 起動エラー対処 (Phase 1はコード署名なし)

### Windows

SmartScreenの「不明な発行元」警告が表示された場合は、「詳細情報 > 実行」を選択してください。

### macOS

「MyMyToolsは壊れているため、起動できません」と表示される場合、ターミナルで以下を実行してquarantine属性を外します。

```bash
xattr -dr com.apple.quarantine /Applications/MyMyTools.app
```

実行後、通常どおり`MyMyTools.app`を起動してください。

## データの保存場所

- macOS: `~/Library/Application Support/com.zredjet.mymtools/`
- Windows: `%APPDATA%\com.zredjet.mymtools\`

バックアップは上記の`backups/`配下に保存されます。設定画面からリストアできます。

## 自動更新について

自動更新は提供しません。新版は同じReleasesページから手動でダウンロードし、アプリを差し替えてください。

## バグ報告 / フィードバック

[GitHub Issues](https://github.com/zredjet/mym-tools/issues)へお願いします。
