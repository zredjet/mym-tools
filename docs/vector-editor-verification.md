# キャンバスの検証と実機受入

最終確認: 2026-11-15 (切替の PR)。仕様は [ADR-0026](decisions/0026-self-built-canvas-editor.md) と [キャンバスの設計](canvas-editor-design.md)。自動テストと開発用の画面 (Vite) での確認まで済んでいる。**macOS / Windows の実アプリでの受入は未実施**で、両 OS の配布受入完了とは扱わない。

SVG-Edit (ADR-0021) の時の検証記録は、このファイルの git の履歴 (2026-09-24 の版) にある。

## 自動テスト

| 対象 | 結果 |
|---|---|
| Frontend typecheck / ESLint / Prettier | 成功 |
| Frontend 全体 (`npx vitest run`) | 150 ファイル・1,700 テスト成功 (`--dir src` は 145 ファイル・1,658 テスト) |
| Rust fmt / Clippy (警告禁止、`--all-targets --all-features`) | 成功 |
| Rust 全体 (`cargo test`) | 518 テスト成功 (所要時間の比較用の 1 件は手動実行のため ignored) |
| `npm run build` | 成功 (`dist` に SVG-Edit の資産が入らないことを確認) |
| payload v2 の検証 | 契約データ (`model/fixtures/payload-v2.json`) の合否と変換の例を、Rust (`scene.rs` / `upgrade.rs`) と TypeScript (`model/validate.ts`) が同じ結果で通す |
| v1 → v2 (Eager-on-Read) | v1 の行を `VectorModule` を通して読むと v2 (埋め込み SVG 1 個) になり、行に書き戻される。`data_revision` と `updated_at` は変わらない。2 回目の読み込みは何も変えない。保存は v2 で書き、`data_revision` を 1 増やす |
| 変換できない v1 | 今の SVG ポリシーを通らない v1 は v1 のまま残る (行の payload と版は変わらない)。開くと `payload_upgrade_failed`、一覧には出る。アプリ / プロジェクトの JSON エクスポートでは v1 のまま書き出し (エクスポートは止まらない)、取り込む側では失敗として数える。バックアップとリストアで残る |
| JSON / バックアップ | 画像と埋め込み SVG を含む v2 が、アプリ / プロジェクトの JSON とバックアップで往復する。検索用テキストを偽った v2 と、ポリシーを通らない埋め込み SVG は取り込まない。v1 の形は新しく保存できない |
| 古いエクスポートファイル | 切替前のアプリが書き出した JSON (vector は payload v1。契約データの 4 例: SVG-Edit の文書、`viewBox` だけ、大きさなし、U+0085 を含む文字) を取り込むと、v2 で入る |
| 一覧・検索 | 大きな埋め込み SVG を持つ v2 を保存しても、一覧は payload を返さず、検索は `text` の先頭 120 文字だけを返す |
| 書き出し (`vector_write_file`) | SVG は大きさだけを確かめる (28 MiB = 29,360,128 bytes ちょうどは書け、1 バイト超えと空は拒否)。`data:image/svg+xml` の `<image>` を含む SVG を書ける。失敗しても既存のファイルは変わらない。PNG は今までどおり |
| 画面 (jsdom、`VectorWorkspacePage.test.tsx`) | 読み込みと全体表示、v1 から変換した作品、読めない payload、変換できない作品、保存 (保存した時点の revision、保存中の編集、本文の編集と進行中のジェスチャーの確定、保存できない文書)、未保存の確認 (新規、本文の編集中、作品の切替、画面の移動、ウィンドウを閉じる、削除)、確認のモーダルの間にキャンバスがキーを取らないこと、取込 (登録、SVG と draw.io の知らせ、取込中の切替の禁止、OS からのドロップ、読めないファイル)、書き出しの登録と外し |
| `canvasIo.test.ts` | ファイル選択の種類、SVG と画像の読み分け、エラーの理由、ファイルごとの保存ダイアログ (2 つ目から直前のフォルダ、取り消しで止める)、ドロップの位置 (物理 px → ページ座標) |

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

確認の前に、設定 > バックアップから手動バックアップを取る (この版は v1 の作品を読んだときに v2 へ書き換え、戻せない)。

- [ ] 切替前の版で作ったベクター描画の作品を開くと、見た目が残っている (埋め込み SVG 1 個)。SVG と PNG に書き出せる
- [ ] 切替前の版で書き出したアプリ / プロジェクトの JSON を取り込める
- [ ] 新しい作品を作り、フレーム・図形・テキスト・画像を置いて保存し、アプリを再起動して開ける
- [ ] WKWebView での文字の計測と折り返し、日本語入力 (変換中の Enter と Esc)、本文の編集中にウィンドウのフォーカスが外れたとき
- [ ] 色の選択、ピンチでのズーム
- [ ] 画像と埋め込み SVG を含む文書の PNG の書き出し
- [ ] ファイル選択での取込と、Finder からのドロップ (ドロップした位置に置かれるか。UI スケール 100% 以外でも)
- [ ] 未保存や削除の確認のモーダルの間に、Delete や Space などがキャンバスに効かない
- [ ] 未保存で Cmd+Q、画面の移動、作品の切替をすると確認が出る
- [ ] 検索 (⌘K) で作品が見つかり、開ける
- [ ] macOS 12、Windows (WebView2) で同じ項目とフォントの判定

## portable ZIP

CI (`build-tauri`) の成果物で測る。SVG-Edit の資産 (約 3.6 MB、347 ファイル) がなくなるので、`v0.1.0-alpha.14` で SVG-Edit を足したときの増分 (macOS +975,324 / Windows +955,081 bytes) に近い分だけ減る見込み。実測は PR の本文と次の版のこのファイルに書く

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
