# キャンバスの検証と実機受入

最終確認: 2026-11-18 (第 2 段階の切替の PR #195)。仕様は [ADR-0026](decisions/0026-self-built-canvas-editor.md)、[ADR-0028](decisions/0028-canvas-stage2-paths-rotation.md) と [キャンバスの設計](canvas-editor-design.md)。

- 第 1 段階 (#180、payload v2): 自動テストと開発用の画面 (Vite) で確かめ、利用者が macOS の実アプリで確かめてからマージした
- 第 2 段階 (統合ブランチ `canvas-stage2` の A〜J と切替の #195、payload v3): 自動テストと開発用の画面での確認まで済んでいる。**macOS / Windows の実アプリでの受入は未実施**で、両 OS の配布受入完了とは扱わない

SVG-Edit (ADR-0021) の時の検証記録は、このファイルの git の履歴 (2026-09-24 の版) にある。

## 第 2 段階 (ADR-0028)

### 自動テスト

切替のブランチ (`claude/canvas2-switch`、`main` に `canvas-stage2` を重ねたもの) で実行した。

| 対象 | 結果 |
|---|---|
| Frontend typecheck / ESLint (`src`) / Prettier | 成功 |
| Frontend 全体 (`npx vitest run`) | 205 ファイル・2,572 テスト成功 (`--dir src` は 200 ファイル・2,529 テスト)。第 1 段階の切替の時点から 55 ファイル・823 テスト増えた |
| Rust fmt / Clippy (警告禁止、`--all-targets --all-features`) | 成功 |
| Rust 全体 (`cargo test`) | 554 テスト成功 (所要時間の比較用の 1 件は手動実行のため ignored) |
| `npm run build` | 成功 |
| 版の一致 | 画面の `PAYLOAD_VERSION` と Rust の `CURRENT_PAYLOAD_VERSION` がどちらも 3 (`model/payload.test.ts` が `mod.rs` を読んで確かめる) |
| payload v3 の検証 | 契約データ (`model/fixtures/payload-v3.json`) の valid (土台 + 差分、`repeat` で作る大きな境界 `max-subpaths` / `max-path-points` / `max-total-path-points` を含む) と invalid (規則 1 つだけを破り、理由を書いたもの) を、Rust (`contract_v3_tests.rs`) と TypeScript (`model/validate.test.ts`) が同じ合否で通す。v3 の検証は v2 の形の文書を、v2 の検証は v3 の形の文書を拒否する |
| v2 → v3 | `upgrade_payload(2)` は `rotation: 0` と線の `cap` / `join` / `dash` の既定値だけを足し、ほかの値と配列の順を変えない。`payload-v2.json` のすべての valid の文書が変換でき、結果が v3 の検証を通る。v2 の検証を通らない v2 (v3 だけのフィールドを持つものなど) は `UpgradeFailed` |
| v1 → v3 | v1 の契約の例 (SVG-Edit の文書、`viewBox` だけ、大きさなし、U+0085 を含む文字、古い `text`) が v1 → v2 → v3 で、v2 の結果に埋め込み SVG の `rotation: 0` を足したものになる。v1 → v2 の段は凍結した v2 の検証で確かめる |
| Eager-on-Read (`storage/sqlite.rs`) | v2 の行を読むと v3 にして書き戻し、`data_revision` と `updated_at` を変えない。壊れた v2 の行は v2 のまま残り、保存での上書きを拒否し、アプリ / プロジェクトの JSON エクスポートでは v2 のまま書き出して `not_upgraded` に入る。v1 の行のテスト (変換、変換できない v1 が残る、上書きの拒否、書き戻しの失敗でも開ける) は版の定数で v3 まで通る |
| 古いエクスポートファイル | v1 (切替前のベクター描画) と v2 (第 1 段階) の `vector` を含む JSON を取り込むと、v3 で入る |
| 最初の変換の前のバックアップ (ADR-0027) | 起動の手順 (`lib.rs` の `prepare_storage`) が、v1 だけ・v2 だけ・両方の行がある DB で `pre-payload-vector-v3` を 1 回だけ取り、`meta.payload_upgrade_backup.vector` を 3 にし、行は変えない。版が 2 のアプリで `pre-payload-vector-v2` を取った後でも、v3 のためにもう 1 回取る。2 回目の起動では取らない |
| リストア (`commands/backup.rs`) | 記録の無いバックアップを戻すと、その場で `pre-payload-vector-v3` を取る。取れなくてもリストアは成功として返す |
| 検索用テキスト | ブーリアンは group と同じく子へ進み、パスは拾わない。v2 → v3 で `text` は変わらない |
| 幾何 (`geometry/`、`path/`) | 行列、曲線の値・範囲・分割・最近点・長さ、交点 (寄り添う曲線、端点を共有する曲線、三重の交差)、`d` の読み書き (円弧)、内外判定、形からの点の形 (始点と向きが SVG 2 の等価なパスと同じ)、多角形と星 |
| ブーリアン演算 (`boolean/`) | 基本の形、重なった辺・接する曲線・自己交差・同じ点を通る輪郭、座標の範囲、求められない条件、乱数の形を格子で比べる (`random.test.ts`)。速さは歯車のアイコン (曲線 198 本) と重なりの多い形で中央値 20 ms 以内 (CI は 60 ms)。手元の実測は 1 回 1.1〜1.6 ms (Apple Silicon、Node) |
| 座標と木 | 行列による外接矩形、回転した frame の中の付け替え・移動・作成・ドロップ先、回転と反転のモデルの関数、リサイズ (回転した子、パスの点の変換)、パネルの位置と大きさ、`fitPathNodes`、ヒットテスト (回転、パス、ブーリアンのスコープ)、ブーリアンの木の規則 |
| 回転と変形、ペンと点の編集、パネル、多角形・星・鉛筆 | 回転のハンドルと優先順、角度の表示と 15° 刻み、自分の向きのリサイズ、反転、回転したテキストの編集欄。ペン (最初の点、Undo、Backspace、フォーカス喪失) と点の編集 (選択、ドラッグ、ハンドル、追加、削除、矢印、止めるキー)。回転・反転・線の端と角と破線の欄、変換の節と操作。多角形・星の形と設定、鉛筆の当てはめ (角、閉じ方、点の数の上限) |
| 線のアウトライン化 (`outline/`) | 端と角、曲線 (曲率半径が太さの半分より小さい所、ほぼ尖った所)、破線 (閉じた輪郭は WebKit と同じく始点でつながない)、長さ 0、乱れた形を、独立の判定 (`strokeContainsFn`) と格子で比べる。速さ (アイコン (曲線 200 本ほど) と、太さ・端・破線を変えた形で中央値 100 ms 以内、CI は 300 ms) と、交わりの多い重い形を 1 秒以内 (CI は 3 秒) に求めるか断ること。格子のテストは重いので時間切れを 30 秒にした (切替の PR) |
| SVG の変換 (`svgconvert/`) | 要素ごとの変換、変換の行列 (パスは厳密、矩形・楕円は箱と回転かパス)、継承と `style`、グラデーション、テキストの位置、`use` と `symbol`、落とすもの・近似の一覧、仕事の量の上限 (`url()` の連鎖、`use` の展開、深い入れ子)、確認のダイアログのフォーカス |
| 画面 (`VectorWorkspacePage.test.tsx`) | v3 の契約データの文書の読み込みと保存 (第 1 段階の項目は v3 で通る) |

### 開発用の画面 (Vite) での確認

各セッションが `canvas-harness.html` (`?doc=stage2` ほか) を Chromium (アプリ内ブラウザ) で操作した。WKWebView と WebView2 では確かめていない。

| 担当 | 確かめたこと |
|---|---|
| C2 座標と木 | 回転した矩形・パス・ブーリアンのクリックでの選択、ブーリアンの中に入って子を選ぶ、90° 回した 1000 × 10 の棒の画面外の判定、回転した frame・入れ子の子・回転した矩形とブーリアンの PNG の書き出し、回転した frame へのドロップで見た目が変わらない、回転した frame の中のドラッグ |
| E 回転と変形 | 回転した frame とハンドル、ホバーのカーソル、回転のドラッグ (角度の表示、Undo / Redo、Shift)、自分の向きのリサイズ (Alt)、回転したテキストの本文の編集と入力、回転した frame の子の選択・移動・リサイズ・矢印、六角形の Shift+H / V、テキストでは Shift+H が効かない、型抜きの抜く側の子をスコープの中で押す、複数の回転、frame の回転 (子は変わらない) |
| F ペンと点の編集 | 15° 回した六角形の点のドラッグ・滑らかの切替・ハンドル・点の追加と削除・Cmd+A・Shift+矢印・Undo・Esc、-30° のパスのハンドルの先がポインターに付いてくる、範囲選択、ペンで閉じる・滑らかな点・Undo の後に続ける、10° 回した frame の中のペン、点の編集の中のペン (続ける、Backspace、新しい輪郭)、パネルの X の入力。レビューの後に、最初の点だけの Cmd+Shift+Z、作ったばかりのパスの Backspace、フォーカス喪失 |
| G パネルと変換の操作 | 回転の欄、反転のボタン、端・角・破線、矩形とブーリアンのパスに変換 (Cmd+E)、Alt+Shift+U での作成、演算の切替、子のドラッグでの並べ替え、線をブーリアンに入れられない、解除と Undo、求められない結果の注意と断る理由 |
| H 多角形・星・鉛筆 | 六角形、凹み 20% の星、Shift で正方形の多角形、Alt で中心からの星、鉛筆の開いた S 字と閉じた輪、Shift+P、回転した frame の中の多角形と鉛筆、Undo / Redo が各 1 件、鉛筆の途中の Esc とフォーカス喪失で何も残らない |
| I 線のアウトライン化 | `stage2` の線のある 17 個を一度に変換し、前後の画像を 3 倍で比べて 6.2 M 画素のうち 362 画素 (縁のなめらかさと破線の終わりのずれ) だけが 60/255 を超えて違う、Undo で 0 画素、Shift+Cmd+O とパネルのボタン。速さはアイコン (曲線 198 本) で 5.6〜39 ms |
| J SVG の変換 | 20° 回した frame の中で 30° 回したアイコンを変換し、ページの画像を 2 倍で比べて 4.16 M 画素のうち 315 画素 (縁のなめらかさだけ) が違う。SVG-Edit 風の 640 × 480 の SVG で確認のダイアログ (テキストの位置 1 件)、Esc で選択を変えずに取り消し、Enter で変換してスコープに入らない、図形は画素まで同じ・テキストは 2 px ほどずれる、Undo / Redo |

### 実アプリで確かめること (未実施)

切替の PR (#195) の CI (`build-tauri`) の成果物の portable ZIP を使う。identifier は普段のアプリと同じ `com.zredjet.mymtools` に戻してあるので、普段のデータを開く (macOS は `~/Library/Application Support/com.zredjet.mymtools/`、Windows は `%APPDATA%\com.zredjet.mymtools\`)。普段のデータでの確認は 1 回だけにする。統合ブランチのアプリ (`com.zredjet.mymtools.stage2`) のデータは別のフォルダにあり、この確認では触らない (要らなければ確認の後に自分で消す)。

#### 確認の前に (必ず今使っている版のアプリで)

新しい版を起動すると、前回のモジュールの復元でキャンバスが開き、直近の作品がその場で v3 になる (v1 の作品も v3 になる)。v2 → v3 の変換は戻せず、v3 になった作品は前の版では開けない。控えは、新しい版を起動する前に、今使っている版で取る。

戻し先のアプリに注意する: 第 1 段階 (payload v2) はリリースしていないので、v2 のアプリは #180 の CI の成果物か `main` の手元のビルドにしかない。CI の成果物は 1 日で消える (`ci.yml` の `retention-days: 1`)。公開版の `v0.1.0-alpha.23` は v1 (SVG-Edit) のアプリで、v2 / v3 の作品を開けないので、戻し先には使えない。

1. 今使っているアプリ (macOS は `MyMyTools.app`、Windows は展開したフォルダ。展開する前の ZIP があればそれも) を、別の場所にコピーして残す。戻すときにこれを使う
   - 手元に v2 のアプリが無いときは、先に作っておく。`main` の `6181201` (第 2 段階の前) を別の worktree で取り出し、`npm ci`、`git submodule update --init --depth 1 vendor/drawio`、`npm run tauri -- build --target aarch64-apple-darwin --bundles app -- --locked` で `src-tauri/target/aarch64-apple-darwin/release/bundle/macos/MyMyTools.app` ができる (cargo には `src-tauri/binaries/nrbf-decoder-aarch64-apple-darwin` が要る。本体のチェックアウトからコピーする)。または GitHub の Actions で `main` の `6181201` の push の実行 (CI) を「Re-run all jobs」し、`release-candidate-macos` (Windows は `release-candidate-windows`) の成果物の ZIP を 1 日以内に取る
2. 今使っている版で、設定 > バックアップ >「今すぐバックアップ」を押す
3. 設定 > データの可搬 > 対象「アプリ全体」>「JSON にエクスポート」で JSON を書き出す
4. 今使っている版を終了する
5. #195 の CI の成果物 (`release-candidate-macos` の `MyMyTools_<版>_macos_aarch64.zip`、Windows は `release-candidate-windows` の `…_windows_x64.zip`) を、1. のアプリとは別のフォルダに展開する (今のアプリに上書きしない)。成果物は CI の実行ごとに 1 日で消えるので、消えていたら PR の CI を再実行して取り直す

#### 旧版への戻し方 (問題が出たとき)

1. 新しい版を終了する
2. 「確認の前に」の 1. で残したアプリ (v2) を起動する
3. 設定 > バックアップの一覧で、「確認の前に」の 2. のバックアップ (`manual-…`) か、新しい版が起動時に取った `pre-op (pre-payload-vector-v3)` の「戻す」を押し、確認でファイル名を入力してリストアし、再起動する

新しい版でリストアすると、開いた作品がまた v3 に変換されるので、リストアは残しておいた v2 のアプリで行う。新しい版で作った・直した作品は、戻したデータには入らない (必要なら新しい版で先に SVG / PNG に書き出しておく)。

#### 新しい版で確かめること

普段のデータ:

- [ ] 起動すると、設定 > バックアップの一覧に `pre-op (pre-payload-vector-v3)` が 1 つ増えている (v1 か v2 のキャンバスの作品があるときだけ)。もう一度起動しても増えない
- [ ] 前の版で作った作品が、見た目を変えずに開ける (第 1 段階の作品、ベクター描画から引き継いだ埋め込み SVG の作品)。開いただけでは「未保存」にならない
- [ ] アプリ全体の JSON エクスポートが止まらず、完了の表示に「元の形式のまま書き出した」作品が無い (あれば、それは変換できなかった作品。理由を記録する)

操作 (新しい作品で):

- [ ] 回転: 選択枠の隅の外のハンドルで回す (角度の表示、Shift で 15° 刻み)、回転のカーソルの見た目、回転した図形の選択・移動・辺と角のリサイズ (Alt で中心から)、プロパティの回転の欄と左右・上下反転のボタン、Shift+H / Shift+V
- [ ] 回転したテキストの本文の編集 (日本語入力の変換中の Enter と Esc、変換の候補の位置)、回転した frame の中での作成・移動・テキストの編集
- [ ] ペン (P): クリックで角、ドラッグで滑らかな点、始点のクリックで閉じる、Enter / Esc で終える、描きかけの Backspace と Cmd+Z。トラックパッドでの感触
- [ ] 点の編集: パスのダブルクリックか Enter で入る、点とハンドルのドラッグ (Option で連動を外す、Cmd で引き出す)、点のダブルクリックで角と滑らか、線分のダブルクリックで点を足す、Delete、矢印、Cmd+A、外のクリックで出る。トラックパッドでの感触
- [ ] 鉛筆 (Shift+P) のなぞりの感触 (許容 2 画面 px、始点に戻ると閉じる)、長いなぞりの重さ。多角形・星 (プロパティの「ツールの設定」で頂点の数と凹み)
- [ ] ブーリアン: 図形を 2 つ以上選んで Option+Shift+U / S / I / E (実際のキーで効くこと)、「変換」の節のボタン、ブーリアンの節で演算の切替、ダブルクリックで中に入って子をドラッグしたときの重さ、Shift+Cmd+G で解除
- [ ] パスに変換 (Cmd+E)、線のアウトライン化 (Shift+Cmd+O。実際のキーで効くこと): 前後で見た目が変わらない (太い線の端と角、閉じた輪郭の破線の始点。WebKit に合わせてある)
- [ ] 線の節の端・角・破線 (例 `4 2`)
- [ ] ベクター描画から引き継いだ作品の埋め込み SVG を選び、「変換」の節の「編集できる形に変換」: 落ちるもの・近似になるものがあれば確認のダイアログが出る (「変換する」にフォーカス、Esc で取り消し、閉じた後にフォーカスが戻る)。変換の後の見た目が近い (テキストの位置は近似)。Cmd+Z で戻る
- [ ] 回転・パス・ブーリアン・破線・埋め込み SVG を含む frame の PNG (1 / 2 / 3 倍) と SVG の書き出し。書き出した画像が画面と合う
- [ ] Cmd+S で保存し、アプリを再起動して開ける。検索 (⌘K) で見つかる
- [ ] バックアップとリストア: 新しい版で、新しい作品を保存してから「今すぐバックアップ」を取り、その作品を少し変えて保存してから、いま取ったバックアップを戻す (再起動の後、作品が戻した時点の形で開ける)。「確認の前に」の 2. のバックアップは、ここでは戻さない (確認の間の作業が消え、`pre-payload-vector-v3` がもう 1 つ増えて「1 回だけ」が確かめられなくなる)
- [ ] JSON: 新しい版でアプリ全体の JSON エクスポートができる。JSON の取込は普段のデータでは試さない (作品が重なる)。取込は下の「切替前の JSON を取り込む」の空のデータフォルダの手順でだけ行う
- [ ] Windows (WebView2) で同じ項目 (閉じた輪郭の破線の始点の角は、描画が Chromium の規則なので、アウトライン化の結果と見た目が違う)

切替前の JSON の取り込みは、下の「切替前の JSON を取り込む」の手順で確かめる (第 2 段階の「確認の前に」の 3. の JSON)。

### portable ZIP

| 対象 | 結果 |
|---|---|
| macOS arm64 (手元のビルド。CI と同じ `npm run tauri -- build --target aarch64-apple-darwin --bundles app -- --locked` と `ditto -c -k --sequesterRsrc --keepParent`) | **55,512,080 bytes**、上限 80,000,000 bytes まで 24,487,920 bytes。`unzip -t` 成功 (20 ファイル)。第 1 段階の手元のビルド (55,406,056 bytes) より 106,024 bytes 大きい |
| macOS arm64 / Windows x64 (切替の PR #195 の CI の成果物) | (CI の成果物で測る) |
| 比較: 第 1 段階の切替 (#180) の CI の成果物 | macOS 55,434,351 bytes、Windows 55,393,155 bytes |

### そのほか未実施

- README の画面イメージ (`docs/images/screenshots/vector.png`) は SVG-Edit の画面のまま。撮り直しは撮影用の identifier の手元ビルドが要る (`docs/images/screenshots/README.md`。デモデータ `scripts/screenshots/demo-data.mjs` は v2 の文書で、開くと v3 に変換される)
- macOS 12 と Windows (WebView2) での第 2 段階の操作

## 第 1 段階 (#180)

### 自動テスト

| 対象 | 結果 |
|---|---|
| Frontend typecheck / ESLint / Prettier | 成功 |
| Frontend 全体 (`npx vitest run`) | 150 ファイル・1,749 テスト成功 (`--dir src` は 145 ファイル・1,706 テスト) |
| Rust fmt / Clippy (警告禁止、`--all-targets --all-features`) | 成功 |
| Rust 全体 (`cargo test`) | 537 テスト成功 (所要時間の比較用の 1 件は手動実行のため ignored) |
| `npm run build` | 成功 (`dist` に SVG-Edit の資産が入らないことを確認) |
| payload v2 の検証 | 契約データ (`model/fixtures/payload-v2.json`) の合否と変換の例を、Rust (`scene.rs` / `upgrade.rs`) と TypeScript (`model/validate.ts`) が同じ結果で通す |
| v1 → v2 (Eager-on-Read) | v1 の行を `VectorModule` を通して読むと v2 (埋め込み SVG 1 個) になり、行に書き戻される。`data_revision` と `updated_at` は変わらない。2 回目の読み込みは何も変えない。保存は v2 で書き、`data_revision` を 1 増やす |
| 変換できない v1 | 今の SVG ポリシーを通らない v1 は v1 のまま残る (行の payload と版は変わらない)。開くと `payload_upgrade_failed`、一覧には出る。アプリ / プロジェクトの JSON エクスポートでは v1 のまま書き出し (エクスポートは止まらない)、`ExportSummary.not_upgraded` に入り、取り込む側では失敗として数える。バックアップとリストアで残る |
| 上書きの拒否 (ADR-0027) | 変換できない v1 の行と新しい版の行への `update_item` は、`ScopedStorage` を通しても `StorageService` を直接呼んでも拒否され (`upgrade_payload` の `ValidationFailed` も同じ)、行・`updated_at`・`data_revision` が変わらない。変換できる v1 の行は書ける。削除はできる |
| 書き戻しの失敗 (ADR-0027) | 書き戻しの UPDATE をトリガで失敗させても、読み込みとエクスポートは変換した v2 を返し、行は v1 のまま。その後の保存は通る |
| 最初の変換の前のバックアップ (ADR-0027) | v1 の行があると起動時に `pre-payload-vector-v2-…` を 1 回だけ取り (中身は v1 のまま)、`meta.payload_upgrade_backup.vector` を 2 にする。2 回目は取らない。取得に失敗すると起動が止まり、記録は残らない。古い版の行が無ければ取らない |
| v1 の `text` | v1 の `text` が今の抽出と違っても (`a  b` など)、アセットの `text` を SVG から求め直して変換する (契約データ `stale-v1-text`) |
| 元の SVG の書き出し | `vector_export_original_svg` は v1 の行の `svg` をそのまま書き、行と `data_revision` を変えない。v2 の行、`svg` の無い行、拡張子が `.svg` でない path は拒否する |
| エクスポートのエラー | 変換の失敗でないエラー (モジュールの内部エラー) では、エクスポートが止まる |
| JSON / バックアップ | 画像と埋め込み SVG を含む v2 が、アプリ / プロジェクトの JSON とバックアップで往復する。検索用テキストを偽った v2 と、ポリシーを通らない埋め込み SVG は取り込まない。v1 の形は新しく保存できない |
| 古いエクスポートファイル | 切替前のアプリが書き出した JSON (vector は payload v1。契約データの 4 例: SVG-Edit の文書、`viewBox` だけ、大きさなし、U+0085 を含む文字) を取り込むと、v2 で入る |
| 一覧・検索 | 大きな埋め込み SVG を持つ v2 を保存しても、一覧は payload を返さず、検索は `text` の先頭 120 文字だけを返す |
| 書き出し (`vector_write_file`) | SVG は取込用の SVG ポリシーを当てず、大きさ (28 MiB = 29,360,128 bytes ちょうどは書け、1 バイト超えと空は拒否) と、XML として整形式でルートの要素が `svg` 1 つであることを確かめる (ルートの `lang`・`xml:lang`・`style`、XML 宣言、CDATA は通る。閉じていない、ルートが 2 つ・`svg` でない、ルートの外の文字、未定義の実体参照、重なった属性は拒否)。`data:image/svg+xml` の `<image>` を含む SVG を書ける。失敗しても既存のファイルは変わらない。PNG は今までどおり |
| 画面 (jsdom、`VectorWorkspacePage.test.tsx`) | 読み込みと全体表示、v1 から変換した作品、読めない payload、変換できない作品と「元の SVG を書き出す」(取り消し、失敗の理由、削除の確認の文)、保存 (保存した時点の revision、保存中の編集、本文の編集と進行中のジェスチャーの確定、保存できない文書)、未保存の確認 (新規、本文の編集中、作品の切替、画面の移動、ウィンドウを閉じる、削除)、確認のモーダルの間にキャンバスがキーを取らないこと、取込 (登録、SVG と draw.io の知らせ、取込中の切替の禁止、OS からのドロップ、読めないファイル)、書き出しの登録と外し。画面の接続のレビューを受けて: 入力欄に打っただけの値 (blur の前) を ⌘N・⌘S・閉じる要求・同じ URL への開き直しの前に文書へ入れる、ドラッグの途中の ⌘S・⌘N を受けずドラッグが続く、ドラッグの途中の閉じる要求と画面の移動はドラッグを取り消してから確かめる、閉じるのに失敗しても以後の確認が効く、確認のモーダルの間のドロップを置かない、読めない作品・変換できない作品で ⌘S が保存しない、読み込みの途中の切替で古い結果を開かない、未保存を revision で判定する、StrictMode で作品を 1 回だけ読む、入口のリダイレクト、変換できない作品の削除。各テストは、対応する実装を外すと失敗することを確かめた。照合のレビューを受けて: ⌘S と ⌘N →「戻る」の後もフォーカスが欄に残る (Backspace が図形を消さない)、範囲外の値で欄を赤くする、レイヤー名の欄で ⌘S が効く、ルーラーからの引き出しの途中の ⌘S と閉じる要求 (これらも、実装を外すと失敗することを確かめた) |
| 設定の画面 (`SettingsPage.test.tsx`) | エクスポートの完了に、元の形式のまま書き出した作品 (タイトル、モジュール、ID、理由) を出す。無ければ出さない |
| `prepare:drawio` (`prepare-assets.test.mjs`) | 前の版の作業フォルダに残った SVG-Edit の生成物 (`.generated/public/svgedit/`、`licenses/svgedit/`、`.svgedit-stamp.json`) を消し、ほかは残す |
| SVG ポリシーの文字 (`validation-fixtures.json`、`payload-v2.json`) | XML 1.0 の Char にない文字 (制御文字、U+FFFF、`&#x1;`、`&#0;`、`&#xFFFE;`、属性の中の `&#x8;`) と、U+0085 をそのまま書いた SVG を、Rust と TypeScript の両方が拒否する。`&#x85;` と、タブ・改行は両方が通し、同じ文字を抽出する。こうした文字を含む v1 は変換を失敗にして v1 のまま残す |
| 起動 (`lib.rs`) | 起動の手順 (`prepare_storage`) が v1 の行のある DB で `pre-payload-vector-v2` を取り、行は変えない。2 回目は取らない |
| 保存の後の編集 (`VectorWorkspacePage.test.tsx`) | 数値欄・レイヤー名・本文の編集の 3 種類で、⌘S の後に Backspace を押しても図形が消えず、欄で打ち続けられ、打ち続けた値が後の保存に入る。数値欄と本文の編集はカーソルの位置が変わらない。レイヤー名は保存で確定した名前を Undo してから Enter を押しても確定し直さない。各テストは、実装を外すと失敗することを確かめた |
| リストア (`commands/backup.rs`、`SettingsPage.test.tsx`) | `core_backup_restore` の本体 (`restore_backup`) で記録の無いバックアップを戻すと、その場で `pre-payload-vector-v2` を取る。取れなくてもリストアは成功として返し、理由を再起動のお願いと一緒に出す。リストアの失敗は、AppError の理由を確認のダイアログに出す |
| `windowClose.test.ts` | 確認済みの閉じ直しの後に `destroy()` が失敗してウィンドウが残っても、次の閉じる要求はまた確かめる |
| `canvasIo.test.ts` | ファイル選択の種類、SVG と画像の読み分け、エラーの理由、ファイルごとの保存ダイアログ (2 つ目から直前のフォルダ、取り消しで止める、2 つ目以降で書き込みか保存ダイアログが失敗したら書いた数と理由を返す)、ドロップの位置 (macOS は point のまま Retina でも割らない、Windows は物理 px を `devicePixelRatio` で割る → ページ座標) |

### 開発用の画面 (Vite) での確認

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

### 実アプリ

利用者が #180 の CI の成果物で macOS の実アプリを確かめてから (2026-11-15、「基本的に問題ない」) マージした。下の項目ごとの記録は無い。手順は第 2 段階と同じ形 (版の番号だけが違う) なので、記録として残す。

CI の portable ZIP は普段のアプリと同じ identifier (`com.zredjet.mymtools`) で、普段のデータを開く。データフォルダは macOS が `~/Library/Application Support/com.zredjet.mymtools/`、Windows が `%APPDATA%\com.zredjet.mymtools\` (Tauri の `app_data_dir()`。`data.sqlite`、`settings.json`、`backups/` が入る)。

#### 確認の前に (必ず今使っている版のアプリで)

新しい版を起動すると、前回のモジュールの復元でキャンバスが開き、直近の作品がその場で v2 になる。控えは、新しい版を起動する前に、今使っている版で取る。

1. 今使っている版で、設定 > バックアップ >「今すぐバックアップ」を押す
2. 設定 > データの可搬 > 対象「アプリ全体」>「JSON にエクスポート」で JSON を書き出す
3. 今使っている版を終了する

#### 旧版への戻し方

1. アプリを終了する
2. 古い版のアプリに差し替える (portable ZIP を展開し直す)
3. 古い版を起動し、設定 > バックアップの一覧で、上の 1. のバックアップ (`manual-…`) か、新しい版が起動時に取った `pre-op (pre-payload-vector-v2)` の「戻す」を押し、確認でファイル名を入力してリストアし、再起動する

新しい版でリストアすると、開いた作品がまた v2 に変換されるので、リストアは古い版で行う。

#### 新しい版で確かめること

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
- [ ] プロパティの数値欄に打ったまま (Enter を押さずに) Cmd+N / Cmd+Q / 作品の切替をすると、未保存の確認が出る。Cmd+S は打った値を含めて保存し、保存の後も欄で打ち続けられる (カーソルの位置が残り、続けて押した Backspace や矢印が図形に効かない)。確認を「戻る」で閉じても欄に戻る
- [ ] テキストの本文を編集している途中に Cmd+S を押すと、保存され、編集が続く (カーソルの位置が変わらず、Backspace は文字を消す)
- [ ] レイヤー名を変えている途中に Cmd+S で保存でき、欄は閉じずに打ち続けられる。範囲外の値 (幅に -5 など) を打つと、欄が赤くなる
- [ ] ルーラーからガイド線を引き出している途中に Cmd+S を押しても保存せず、Cmd+Q の確認を「戻る」で閉じても作りかけのガイド線が残らない
- [ ] 図形をドラッグしている途中に Cmd+S を押しても保存せず、ドラッグが続く
- [ ] 未保存や削除の確認のモーダルの間に、Delete や Space などがキャンバスに効かない
- [ ] 検索 (⌘K) で作品が見つかり、開ける
- [ ] macOS 12、Windows (WebView2) で同じ項目とフォントの判定

#### そのほか (第 1 段階の時点)

- README の画面イメージ (`docs/images/screenshots/vector.png`) は SVG-Edit の画面のまま。撮り直しは撮影用の identifier の手元ビルドが要る (`docs/images/screenshots/README.md`。デモデータは v2 の文書にしてある)
- Windows の portable ZIP の大きさ (下の表)

### portable ZIP

| 対象 | 結果 |
|---|---|
| macOS arm64 (手元のビルド。CI と同じ `npm run tauri -- build --target aarch64-apple-darwin --bundles app -- --locked` と `ditto -c -k --sequesterRsrc --keepParent`) | **55,406,056 bytes**、上限 80,000,000 bytes まで 24,593,944 bytes。`unzip -t` 成功、SVG-Edit の資産なし (20 ファイル) |
| 比較: 公開版 `v0.1.0-alpha.23` の macOS | 56,166,970 bytes (この版は 760,914 bytes 小さい。alpha.23 以降に入ったキャンバスのエディタなどを含んだうえで、SVG-Edit の資産が抜けた分) |
| Windows x64 | 手元では作っていない。公開版 `v0.1.0-alpha.23` は 56,069,917 bytes |
| CI (`build-tauri`) の成果物 (#180 のマージ前) | macOS 55,434,351 bytes、Windows 55,393,155 bytes |

手元のビルドは公開用のリリースではない (SHA-256 `3f7c0311eb5eb17c2cfdbb73d282710b5298fbbfd7c320be00cca33fd1095e04`)。

## 切替前の JSON を取り込む (データフォルダを一時的に退避する)

第 1 段階と第 2 段階の確認で共通の手順。「確認の前に」で取った JSON を、空のデータフォルダの新しい版に取り込む。

普段のデータに取り込むと作品が重なるので、空のデータフォルダで確かめる。**`rm -rf` は使わない** (退避が済んでいないときに本物のデータフォルダと `backups/` を消さないため)。下のコマンドは、退避の状態を確かめてからだけ動く形にしてある (macOS。`D` はデータフォルダの親)。

1. アプリを終了する
2. 前の確認の退避 (`com.zredjet.mymtools.keep`) が残っていないことを確かめてから、データフォルダを退避する。残っていれば何もせずに止まる (先に中身を確かめて片付ける)

   ```sh
   D="$HOME/Library/Application Support"; [ ! -e "$D/com.zredjet.mymtools.keep" ] && mv "$D/com.zredjet.mymtools" "$D/com.zredjet.mymtools.keep" && echo 退避しました
   ```

3. 「退避しました」が出たことを確かめて、新しい版を起動する (空のデータで始まる)
4. 設定 > データの可搬 >「JSON からインポート」で、その段階の「確認の前に」で書き出した JSON を取り込む
- [ ] 取り込みの結果に失敗が無く (変換できない作品があればその件数だけ失敗)、キャンバスの作品が開け、見た目が残っている (取り込んだ作品は今の版の payload で入る)
5. アプリを終了し、空から作ったフォルダに日時を付けて名前を変え、退避したフォルダを戻す。退避したフォルダがあるときだけ動く

   ```sh
   D="$HOME/Library/Application Support"; [ -d "$D/com.zredjet.mymtools.keep" ] && mv "$D/com.zredjet.mymtools" "$D/com.zredjet.mymtools.empty-$(date +%Y%m%d-%H%M%S)" && mv "$D/com.zredjet.mymtools.keep" "$D/com.zredjet.mymtools" && echo 戻しました
   ```

6. 「戻しました」が出たことを確かめる。`com.zredjet.mymtools.empty-…` (取り込んだ写し) は、確かめ終わったら自分で消す

   5. で「戻しました」が出ずに止まったとき (2. の後に新しい版を一度も起動しなかったなどで、空のフォルダが無い): データは `com.zredjet.mymtools.keep` に残っている。元の名前のフォルダが無いことを確かめてから戻す

   ```sh
   D="$HOME/Library/Application Support"; [ ! -e "$D/com.zredjet.mymtools" ] && [ -d "$D/com.zredjet.mymtools.keep" ] && mv "$D/com.zredjet.mymtools.keep" "$D/com.zredjet.mymtools" && echo 戻しました
   ```

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
