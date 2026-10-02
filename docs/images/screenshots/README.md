# README の画面イメージ

[README](../../../README.md) の「画面」に載せている画像の撮り方。デモ用のデータを、撮影専用の identifier で起動したアプリに入れて撮る。普段使っているデータには触れない。

## 撮り方 (macOS)

1. デモ用のデータを作る。更新日時は実行した時刻から数分〜数日前に散らすので、撮る直前に作る。

   ```bash
   node scripts/screenshots/demo-data.mjs
   ```

   `.generated/screenshots/demo.mymtools.json` ができる (3 プロジェクト、32 アイテム)。

2. 撮影用の identifier でビルドする。`.generated/screenshots/tauri-screenshots.json` に次を置く。

   ```json
   {"productName": "MyMyTools", "identifier": "com.zredjet.mymtools.screenshots", "app": {"windows": [{"title": "MyMyTools", "width": 1280, "height": 800, "minWidth": 1024, "minHeight": 600}]}}
   ```

   ```bash
   npm run tauri -- build --config .generated/screenshots/tauri-screenshots.json --bundles app
   ```

   データは `~/Library/Application Support/com.zredjet.mymtools.screenshots/` に分かれる。撮り直す時はこのフォルダを消してから起動する。

3. 起動して、設定 > データの可搬 > JSON からインポートで 1. の JSON を取り込む。テーマは「ライト」にする。
4. 各画面を開き、ウィンドウだけを影なしで撮る (Retina では 2560×1600)。

   ```bash
   screencapture -x -o -l "$(swift scripts/screenshots/window-id.swift | head -1)" shot.png
   ```

5. 幅 1600 px に縮小し、アプリの PNG 最適化と同じ設定で減色する。カラーホイールやグラデーションがある画面 (`palette.png` / `vector.png`) は `--floyd` を付けて、まだら模様を防ぐ。

   ```bash
   sips -Z 1600 shot.png --out docs/images/screenshots/<名前>.png
   shotq --quality=70-85 --speed 11 docs/images/screenshots/<名前>.png
   ```

## 各画面の状態

| ファイル | 状態 |
|---|---|
| `prompt-detail.png` / `prompt-detail-dark.png` | プロンプト「コードレビュー依頼」の変数 3 つに値を入れた状態。ダーク版はトップバーの月のボタンで切り替える |
| `search.png` | ⌘K で「リリース」を検索 |
| `links.png` | リンクの一覧 |
| `memo.png` | メモ「リリース手順メモ」の Markdown 表示 |
| `colors.png` | カラーの一覧 |
| `palette.png` | パレットの作成タブ (開いた直後の状態) |
| `mermaid.png` | 「デプロイの流れ」 |
| `diagram.png` | 「システム構成」の 1 ページ目 |
| `vector.png` | 「アプリアイコン案」 |
| `regex.png` | `(?<date>\d{4}-\d{2}-\d{2}) (?<level>ERROR\|WARN) (?<msg>.+)`、フラグ `gm`、5 行のログ、置換 `[$<level>] $<msg> ($<date>)` |
| `text-diff.png` | 設定ファイル (YAML) の新旧を行差分で比較し、差分が見える位置までスクロール |
| `jwt.png` | HS256 のデモ用トークン (`sub` / `name` / `role` / `iss` / `iat` / `exp`) を解析し、日時の claim が見える位置までスクロール |
| `cron.png` | 既定の `0 9 * * 1-5`、Asia/Tokyo で「次回を計算」 |
| `png-optimizer.png` | 撮った画面イメージ 1 枚 (`/Users/Shared/` の一時フォルダに置いたもの) を別名で保存 |
| `settings.png` | 設定画面の先頭 |
