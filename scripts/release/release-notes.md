# MyMyTools

個人用ローカルツールの集合体 — 保存系ツールと、変換・解析・生成・通信の開発ツール。

## v0.1.0-alpha.21 の主な変更

ダイアグラムが使う draw.io の更新と、それに合わせた内部ライブラリのセキュリティ更新です。データベースの形式は変わりません。

### 更新

- ダイアグラムの draw.io を 31.4.1 から 31.5.3 へ更新した
  - 図の中の文字やリンクの安全な取り扱い (DOMPurify 3.4.16 など) と、上流で見つかった脆弱性 (GHSA-ff67-v9r9-6877 / GHSA-v2pv-rjf8-9w9v) の修正を取り込みます。このアプリでは外部通信を遮断しているため直接の影響はありませんが、多層防御として更新します
  - 図形ライブラリに Atlassian (2025) を追加 (その他の図形から有効化)
  - PlantUML の取り込みを更新
  - 線の「直角の端点」など、新しい書式の項目を日本語で表示します
- PDF 結合で、相互参照表の軽微な誤りなど一部の破損した PDF を修復して読み込めるようにした (PDF ライブラリの更新による)

### 不具合の修正

- ダイアグラムで、親を持たない図形を含むファイルを開くと、ページの中身が消えて保存で書き戻されることがあった問題を修正 (draw.io 31.5.3)
- PDF 結合で、細工された PDF を追加するとアプリが強制終了することがあった問題を修正。読み込めない PDF は追加せず、拒否の理由に読めなかった原因の詳細も表示するようにした
- ベクター描画で、極端に多くの属性を持つ SVG を取り込む・保存すると長時間固まることがあった問題を修正

### セキュリティ

- 実行基盤の Tauri を 2.11.6 に更新した (GHSA-w28w-mhc8-qvjv)
- XML の解析ライブラリ (quick-xml 0.41) と PDF の解析ライブラリ (lopdf 0.45) を、既知の問題を修正した版へ更新した
- 1 つの要素に 257 個以上の名前空間宣言を持つ SVG は、ベクター描画で保存できなくなりました (通常の SVG には該当しません)

### 既知の制限

- ダイアグラムで、ページのタブをドラッグして並べ替えることはできません。タブの右クリックメニューの「移動」か、何も選択していない状態での Shift + ← / → で並べ替えてください

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
