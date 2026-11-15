# キャンバスの検証と実機受入

最終確認: 2026-11-15 (切替の PR)。仕様は [ADR-0026](decisions/0026-self-built-canvas-editor.md) と [キャンバスの設計](canvas-editor-design.md)。自動テストと開発用の画面 (Vite) での確認まで済んでいる。**macOS / Windows の実アプリでの受入は未実施**で、両 OS の配布受入完了とは扱わない。

SVG-Edit (ADR-0021) の時の検証記録は、このファイルの git の履歴 (2026-09-24 の版) にある。

## 自動テスト

| 対象 | 結果 |
|---|---|
| Frontend typecheck / ESLint / Prettier | 成功 |
| Frontend 全体 (`npx vitest run`) | 150 ファイル・1,726 テスト成功 (`--dir src` は 145 ファイル・1,683 テスト) |
| Rust fmt / Clippy (警告禁止、`--all-targets --all-features`) | 成功 |
| Rust 全体 (`cargo test`) | 531 テスト成功 (所要時間の比較用の 1 件は手動実行のため ignored) |
| `npm run build` | 成功 (`dist` に SVG-Edit の資産が入らないことを確認) |
| payload v2 の検証 | 契約データ (`model/fixtures/payload-v2.json`) の合否と変換の例を、Rust (`scene.rs` / `upgrade.rs`) と TypeScript (`model/validate.ts`) が同じ結果で通す |
| v1 → v2 (Eager-on-Read) | v1 の行を `VectorModule` を通して読むと v2 (埋め込み SVG 1 個) になり、行に書き戻される。`data_revision` と `updated_at` は変わらない。2 回目の読み込みは何も変えない。保存は v2 で書き、`data_revision` を 1 増やす |
| 変換できない v1 | 今の SVG ポリシーを通らない v1 は v1 のまま残る (行の payload と版は変わらない)。開くと `payload_upgrade_failed`、一覧には出る。アプリ / プロジェクトの JSON エクスポートでは v1 のまま書き出し (エクスポートは止まらない)、`ExportSummary.not_upgraded` に入り、取り込む側では失敗として数える。バックアップとリストアで残る |
| 上書きの拒否 (ADR-0027) | 変換できない v1 の行と新しい版の行への `update_item` は拒否され、行・`updated_at`・`data_revision` が変わらない。変換できる v1 の行は書ける。削除はできる |
| 書き戻しの失敗 (ADR-0027) | 書き戻しの UPDATE をトリガで失敗させても、読み込みとエクスポートは変換した v2 を返し、行は v1 のまま。その後の保存は通る |
| 最初の変換の前のバックアップ (ADR-0027) | v1 の行があると起動時に `pre-payload-vector-v2-…` を 1 回だけ取り (中身は v1 のまま)、`meta.payload_upgrade_backup.vector` を 2 にする。2 回目は取らない。取得に失敗すると起動が止まり、記録は残らない。古い版の行が無ければ取らない |
| v1 の `text` | v1 の `text` が今の抽出と違っても (`a  b` など)、アセットの `text` を SVG から求め直して変換する (契約データ `stale-v1-text`) |
| 元の SVG の書き出し | `vector_export_original_svg` は v1 の行の `svg` をそのまま書き、行と `data_revision` を変えない。v2 の行、`svg` の無い行、拡張子が `.svg` でない path は拒否する |
| エクスポートのエラー | 変換の失敗でないエラー (モジュールの内部エラー) では、エクスポートが止まる |
| JSON / バックアップ | 画像と埋め込み SVG を含む v2 が、アプリ / プロジェクトの JSON とバックアップで往復する。検索用テキストを偽った v2 と、ポリシーを通らない埋め込み SVG は取り込まない。v1 の形は新しく保存できない |
| 古いエクスポートファイル | 切替前のアプリが書き出した JSON (vector は payload v1。契約データの 4 例: SVG-Edit の文書、`viewBox` だけ、大きさなし、U+0085 を含む文字) を取り込むと、v2 で入る |
| 一覧・検索 | 大きな埋め込み SVG を持つ v2 を保存しても、一覧は payload を返さず、検索は `text` の先頭 120 文字だけを返す |
| 書き出し (`vector_write_file`) | SVG は取込用の SVG ポリシーを当てず、大きさ (28 MiB = 29,360,128 bytes ちょうどは書け、1 バイト超えと空は拒否) と、XML として整形式でルートの要素が `svg` 1 つであることを確かめる (ルートの `lang`・`xml:lang`・`style`、XML 宣言、CDATA は通る。閉じていない、ルートが 2 つ・`svg` でない、ルートの外の文字、未定義の実体参照、重なった属性は拒否)。`data:image/svg+xml` の `<image>` を含む SVG を書ける。失敗しても既存のファイルは変わらない。PNG は今までどおり |
| 画面 (jsdom、`VectorWorkspacePage.test.tsx`) | 読み込みと全体表示、v1 から変換した作品、読めない payload、変換できない作品と「元の SVG を書き出す」(取り消し、失敗の理由、削除の確認の文)、保存 (保存した時点の revision、保存中の編集、本文の編集と進行中のジェスチャーの確定、保存できない文書)、未保存の確認 (新規、本文の編集中、作品の切替、画面の移動、ウィンドウを閉じる、削除)、確認のモーダルの間にキャンバスがキーを取らないこと、取込 (登録、SVG と draw.io の知らせ、取込中の切替の禁止、OS からのドロップ、読めないファイル)、書き出しの登録と外し。画面の接続のレビューを受けて: 入力欄に打っただけの値 (blur の前) を ⌘N・⌘S・閉じる要求・同じ URL への開き直しの前に文書へ入れる、ドラッグの途中の ⌘S・⌘N を受けずドラッグが続く、ドラッグの途中の閉じる要求と画面の移動はドラッグを取り消してから確かめる、閉じるのに失敗しても以後の確認が効く、確認のモーダルの間のドロップを置かない、読めない作品・変換できない作品で ⌘S が保存しない、読み込みの途中の切替で古い結果を開かない、未保存を revision で判定する、StrictMode で作品を 1 回だけ読む、入口のリダイレクト、変換できない作品の削除。各テストは、対応する実装を外すと失敗することを確かめた |
| 設定の画面 (`SettingsPage.test.tsx`) | エクスポートの完了に、元の形式のまま書き出した作品 (タイトル、モジュール、ID、理由) を出す。無ければ出さない |
| `prepare:drawio` (`prepare-assets.test.mjs`) | 前の版の作業フォルダに残った SVG-Edit の生成物 (`.generated/public/svgedit/`、`licenses/svgedit/`、`.svgedit-stamp.json`) を消し、ほかは残す |
| `canvasIo.test.ts` | ファイル選択の種類、SVG と画像の読み分け、エラーの理由、ファイルごとの保存ダイアログ (2 つ目から直前のフォルダ、取り消しで止める、2 つ目以降で失敗したら書いた数と理由を返す)、ドロップの位置 (macOS は point のまま Retina でも割らない、Windows は物理 px を `devicePixelRatio` で割る → ページ座標) |

## 開発用の画面 (Vite) での確認

`VectorWorkspacePage` を、IPC を `@tauri-apps/api/mocks` の `mockIPC` (メモリ上の DB) に差し替えて Vite で描画し、Chromium (アプリ内ブラウザ) で操作した。確認用の入口は一時的なもので、リポジトリには入れていない。

| 操作 | 結果 |
|---|---|
| 画面を開く | 直近の作品を開き、内容が収まるように表示 (契約データ `full` で 63%) |
| 矩形を描く → Cmd+S | 「未保存」→ `core_update_item` で v2 を保存し「保存済み」 |
| テキストを打ちかけのまま (入力欄にフォーカス) Cmd+N | 本文を確定してから「未保存の変更を破棄しますか？」 |
| 確認のモーダルの間に Delete と R | キャンバスは反応しない (ノード数、ツール、revision が変わらない) |
| 未保存のまま作品を切り替え | 確認のあと、v1 から変換した作品 (埋め込み SVG) を開き、見た目が残る |
| v1 から変換した作品を SVG / PNG に書き出す | 保存ダイアログが 1 つずつ出て、SVG 523 bytes、PNG 2 倍 1280×960 を `vector_write_file` に渡す |
| 作品バーの「取込」(SVG、PNG) | 今の作品の表示範囲の中央に置き、選ぶ。draw.io の変換の知らせを出す |
| 新規 → フレーム → タイトルを変えて保存 | `core_create_item` で作り、作品の一覧に出る |
| 削除 | 確認のあと消し、新しい作品を開く |
| 読めない作品 / 変換できない作品 | 理由を出し、エディタを出さない。タイトルは一覧の題名。保存と取込は押せず、新規・削除・再試行・切替はできる |
| 未保存のまま別の画面へ | 確認のあと移動し、store から作品を外す |
| ダークテーマ | 作品バーとエディタがトークンどおりに描かれる |

## 実アプリ (未実施)

CI の portable ZIP は普段のアプリと同じ identifier (`com.zredjet.mymtools`) で、普段のデータを開く。データフォルダは macOS が `~/Library/Application Support/com.zredjet.mymtools/`、Windows が `%APPDATA%\com.zredjet.mymtools\` (Tauri の `app_data_dir()`。`data.sqlite`、`settings.json`、`backups/` が入る)。

### 確認の前に (必ず今使っている版のアプリで)

新しい版を起動すると、前回のモジュールの復元でキャンバスが開き、直近の作品がその場で v2 になる。控えは、新しい版を起動する前に、今使っている版で取る。

1. 今使っている版で、設定 > バックアップ >「今すぐバックアップ」を押す
2. 設定 > データの可搬 > 対象「アプリ全体」>「JSON にエクスポート」で JSON を書き出す
3. 今使っている版を終了する

### 旧版への戻し方

1. アプリを終了する
2. 古い版のアプリに差し替える (portable ZIP を展開し直す)
3. 古い版を起動し、設定 > バックアップの一覧で、上の 1. のバックアップ (`manual-…`) か、新しい版が起動時に取った `pre-op (pre-payload-vector-v2)` の「戻す」を押し、確認でファイル名を入力してリストアし、再起動する

新しい版でリストアすると、開いた作品がまた v2 に変換されるので、リストアは古い版で行う。

### 新しい版で確かめること

- [ ] 起動すると、設定 > バックアップの一覧に `pre-op (pre-payload-vector-v2)` が 1 つ増えている (v1 の作品があるときだけ)。もう一度起動しても増えない
- [ ] サイドバーの「カラー・デザイン」に「キャンバス」が出る
- [ ] 切替前の版で作ったベクター描画の作品を開くと、見た目が残っている (レイヤーに「SVG」1 個)。プロパティの書き出しで SVG と PNG (1 / 2 / 3 倍) に書き出せ、書き出した SVG / PNG を開くと内容が合っている
- [ ] 変換できない作品があれば (`<script>` を含むものなど)、理由が出てエディタは出ない。「元の SVG を書き出す」で元の SVG を保存できる。アプリ全体の JSON エクスポートの完了に、その作品が「元の形式のまま書き出しました」として出る
- [ ] 新しい作品を作り、フレーム・図形・テキスト・画像を置いて Cmd+S で保存し、アプリを再起動して開ける
- [ ] WKWebView での文字の計測と折り返し、日本語入力 (変換中の Enter と Esc)、本文の編集中にウィンドウのフォーカスが外れたとき
- [ ] 本文を打ちかけたまま Cmd+N / 作品の切替 / Cmd+Q をすると、本文が確定してから未保存の確認が出る
- [ ] 色の選択、ピンチでのズーム
- [ ] 画像と埋め込み SVG を含む文書の PNG の書き出し
- [ ] ファイル選択での取込と、Finder からのドロップ (Retina のディスプレイで、ドロップした位置に置かれる。UI スケール 100% 以外でも)
- [ ] プロパティの数値欄に打ったまま (Enter を押さずに) Cmd+N / Cmd+Q / 作品の切替をすると、未保存の確認が出る。Cmd+S は打った値を含めて保存する
- [ ] 図形をドラッグしている途中に Cmd+S を押しても保存せず、ドラッグが続く
- [ ] 未保存や削除の確認のモーダルの間に、Delete や Space などがキャンバスに効かない
- [ ] 検索 (⌘K) で作品が見つかり、開ける
- [ ] macOS 12、Windows (WebView2) で同じ項目とフォントの判定

### 切替前の JSON を取り込む (データフォルダを一時的に退避する)

普段のデータに取り込むと作品が重なるので、空のデータフォルダで確かめる。

1. アプリを終了する
2. データフォルダの名前を変えて退避する (macOS の例)

   ```sh
   mv ~/Library/Application\ Support/com.zredjet.mymtools ~/Library/Application\ Support/com.zredjet.mymtools.keep
   ```

3. 新しい版を起動する (空のデータで始まる)
4. 設定 > データの可搬 >「JSON からインポート」で、上の「確認の前に」の 2. の JSON を取り込む
- [ ] 取り込みの結果に失敗が無く (変換できない作品があればその件数だけ失敗)、キャンバスの作品が開け、見た目が残っている
5. アプリを終了し、空から作ったフォルダを消して、退避したフォルダを戻す

   ```sh
   rm -rf ~/Library/Application\ Support/com.zredjet.mymtools
   mv ~/Library/Application\ Support/com.zredjet.mymtools.keep ~/Library/Application\ Support/com.zredjet.mymtools
   ```

### そのほか未実施

- README の画面イメージ (`docs/images/screenshots/vector.png`) は SVG-Edit の画面のまま。撮り直しは撮影用の identifier の手元ビルドが要る (`docs/images/screenshots/README.md`。デモデータは v2 の文書にしてある)
- Windows の portable ZIP の大きさ (下の表)

## portable ZIP

| 対象 | 結果 |
|---|---|
| macOS arm64 (手元のビルド。CI と同じ `npm run tauri -- build --target aarch64-apple-darwin --bundles app -- --locked` と `ditto -c -k --sequesterRsrc --keepParent`) | **55,406,056 bytes**、上限 80,000,000 bytes まで 24,593,944 bytes。`unzip -t` 成功、SVG-Edit の資産なし (20 ファイル) |
| 比較: 公開版 `v0.1.0-alpha.23` の macOS | 56,166,970 bytes (この版は 760,914 bytes 小さい。alpha.23 以降に入ったキャンバスのエディタなどを含んだうえで、SVG-Edit の資産が抜けた分) |
| Windows x64 | 手元では作っていない。CI (`build-tauri`) の成果物で確かめる。公開版 `v0.1.0-alpha.23` は 56,069,917 bytes |

手元のビルドは公開用のリリースではない (SHA-256 `3f7c0311eb5eb17c2cfdbb73d282710b5298fbbfd7c320be00cca33fd1095e04`)。

## 再実行

Node 22 とリポジトリ指定の Rust を使う。依存と draw.io の submodule を初期取得した後、通常の prepare / build はローカルの配布物だけを参照する。

```sh
npm run typecheck
npm run lint
npx vitest run
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features --locked -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

エディタの部品だけなら、`npx vite` のあと `/canvas-harness.html` で開ける (§6.2)。
