# MyMyTools

個人用ローカルツールの集合体 — 保存系ツールと、変換・解析・生成・通信の開発ツール。

## v0.1.0-alpha.14 の主な変更

- 「ベクター描画」を追加。同梱のSVG-Edit 7.4.2で図形・パス・文字・レイヤーを完全オフラインで編集し、作品をプロジェクトへ保存
- SVGの取込、PNG / JPEG / WebP画像の挿入、SVG / PNGの書出しに対応。外部参照やscriptを含むSVGは取り込まない
- 未保存の作品がある時は、画面移動・新規作成・ウィンドウ終了（macOSのCmd+Qを含む）の前に確認
- BinaryFormatter解析のtreeで、Home / Endと左右キーでの親子移動、隠れた参照先への移動、検索語の強調表示を改善

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
