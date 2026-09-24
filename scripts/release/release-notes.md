# MyMyTools

個人用ローカルツールの集合体 — 保存系ツールと、変換・解析・生成・通信の開発ツール。

## v0.1.0-alpha.16 の主な変更

- BinaryFormatter解析（NRBF）で、解析できないファイルのエラーに詳細を表示するように改善。例外の種類、読込位置、非対応の保存形式、NRBFでないファイルの先頭バイトと推定形式を表示する
- 型名が複雑すぎて解析できない場合、原因となっている型名を自動で特定して表示する
- 途中で切れたファイルを「ファイルを読み込めません」ではなく「途中で終わっています」と正しく表示するように修正
- 一部の項目だけ展開できない場合も、ツリー全体を破棄せず、該当項目を「展開失敗」として残りを表示する
- エラー詳細と警告をコピーするボタンを追加

## 含まれるportable ZIP

- **macOS**: `MyMyTools_*_macos_aarch64.zip` (Apple Silicon専用 / Intel Mac非対応)
- **Windows**: `MyMyTools_*_windows_x64.zip` (x64)

## インストール / 更新

1. このページのAssetsから自分のOSのZIPをダウンロード
2. **macOS**: ZIPを展開し、`MyMyTools.app`をApplicationsへ移動または既存版と差し替え
3. **Windows**: ZIP内の`MyMyTools.exe`と`nrbf-decoder.exe`を同じ任意フォルダへ展開し、`MyMyTools.exe`を起動または2ファイルとも既存版と差し替え

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
