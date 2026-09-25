# ADR-0023: PNG最適化 (shotq) をプロセス内で実行する

- **Status**: Accepted
- **Date**: 2026-09-25
- **Deciders**: zredjet
- **Related**: requirements D-06 / D-18 / architecture §10.7 / module-contract §12.12 / ui-design §6.24 / ADR-0004 / ADR-0009 (R-2 の限定例外) / ADR-0010 §2.5 / ADR-0014 / ADR-0017 §4 / ADR-0018 / ADR-0020

---

## 1. Context

スクリーンショットなどの PNG を、自作の非可逆 PNG 最適化ツール shotq で圧縮したい。結果は、普段使っている次のコマンドと**バイト単位で同じ**にする。

```sh
shotq --quality=70-85 --speed 11 in.png -o out.png
```

1 ファイルずつの実行に加えて、フォルダを指定し、直下の PNG を順に処理する機能も要る。

shotq の性質は次のとおり。

- Rust 製。ライセンスは MIT OR Apache-2.0。既定ビルドの依存は png / rayon / flate2 (zlib-rs) / libdeflater (C の libdeflate を `cc` でビルド) / qcms / libc など。GPL の libimagequant は `liq` feature を有効にしたときだけ入る
- 0.23.2 までは `main.rs` だけのバイナリ crate だった。今回ライブラリ化し (shotq HANDOFF P49)、`shotq::optimize(&[u8], &Options) -> Result<Outcome, String>` を公開した。ライブラリはファイルを読み書きせず、`process::exit` もしない。旧 CLI とライブラリ化後の CLI を 138 回比べ、出力バイトと終了コード (0 / 98 / 99) はすべて一致した
- 画像の読み込み、置き換え、deflate を rayon で並列化している。出力がスレッド数に左右されないことは、shotq の単体テストと `bench.py check` で保証している
- 並列化の効果 (Apple M4 Max、16 スレッド、`--quality=70-85 --speed 11`、5 回中の最速):

  | 入力 | 1 スレッド | 16 スレッド |
  |---|---:|---:|
  | PNG 3456×2234 (2.1 MB) | 156 ms | 30 ms |
  | BMP 3456×2234 | 135 ms | 25 ms |

- shotq のリポジトリは private。一方、mym-tools は public

mym-tools 側の制約は次の 2 つ。

- ADR-0009 R-2 は、アプリ内で自前の `rayon` やスレッドプールを使うことを禁じている。重い処理は `tauri::async_runtime::spawn_blocking` だけで逃がす。CI は `src-tauri/src` にある `rayon::` を grep で検出する (ADR-0010 §2.5)
- 外部バイナリを同梱した前例は NRBF の .NET sidecar (ADR-0020) だけ。sidecar にした理由は、Tauri 本体と異なる .NET ランタイムが必要なことだった

## 2. Decision

### 2.1 モジュール

- ID は `pngopt`、画面上の表示名は **「PNG最適化」**、アイコンは lucide の `ImageDown`
- `category = other` (PDF 結合と同じ。画像のカテゴリはまだないため)、`is_stateless = true`、既定で有効
- 入力パス、パラメータ、処理結果、一覧を items、設定、横断検索、export / import に保存しない (D-06)。画面を離れたら捨てる

### 2.2 エンジンの取り込み

- shotq のライブラリ部分を `src-tauri/crates/shotq/` に**複製**し、path 依存で使う。複製するのは `Cargo.toml` と `src/{lib,cm,color,deflate,quant,subpal}.rs`、ライセンス関係 (`LICENSE-MIT` / `LICENSE-APACHE` / `LICENSES/` / `THIRD_PARTY_NOTICES.md`)。CLI の `src/main.rs`、テスト用画像、`research/`、`tools/`、`docs/` は複製しない
- 複製したソースには手を入れない。直す場合は shotq 側で直してから複製し直す。複製元の commit、バージョン、複製した日付と、`Cargo.toml` の上流との差分を `src-tauri/crates/shotq/UPSTREAM.md` に記録する
- 複製した `Cargo.toml` からは `liq` feature と `imagequant` 依存を削る。GPL のコードを持ち込まないため。ソース中の `cfg(feature = "liq")` は常に無効になるので、その cfg を既知として宣言する。上流で既知の dead code 警告は抑止する (ここでは開発しないため)
- 出力のバイト列に効く依存 (zlib-rs / flate2 / png / qcms / fdeflate、ほか libdeflater / crc32fast / simd-adler32 / rayon) は、`src-tauri/Cargo.lock` で shotq の `Cargo.lock` と同じ版に揃える。一覧は `UPSTREAM.md` に置く
- 複製した crate は Cargo workspace のメンバーにしない。アプリの `cargo fmt --check` と `cargo clippy -- -D warnings` は path 依存に効かないので、shotq の書式のまま置ける (試験用の crate で確認済み)。shotq 自身の単体テストは shotq リポジトリで実行し、mym-tools では 2.7 の契約テストを実行する
- `src-tauri/Cargo.toml` の `[profile.release.package.shotq]` で `opt-level = 3` と `codegen-units = 1` を指定する。shotq の配布ビルドは `lto = "fat"` だが、LTO なしの速度差は 0〜10% (5K 42 → 42 ms、4,000 万画素 106 → 106 ms、3456×2234 29 → 32 ms) で、出力は同一だった。アプリ全体の LTO は有効にしない
- private の shotq を git 依存にすると、CI に読み取り用のトークンが要り、第三者が mym-tools をビルドできなくなる。複製ならこの問題が起きない。複製したソースは mym-tools 側で公開される

### 2.3 スレッド: ADR-0009 R-2 の限定例外

- **rayon の使用を、複製した `shotq` crate の内部に限って認める**。アプリのコード (`src-tauri/src`) には従来どおり `rayon::` を書かない。ADR-0010 §2.5 の grep は変えない
- `shotq::optimize` は `tauri::async_runtime::spawn_blocking` の中からだけ呼ぶ。rayon の全体プール (論理 CPU 数のスレッド) は、shotq が最初に使ったときに作られる。仕事がない間、そのスレッドは待機していて CPU を使わない
- `pngopt` の処理は、アプリ全体で同時に 1 つだけ実行する (モジュール内の `Mutex` で直列化する)。後から始めた操作は前の操作が終わるのを待ち、その間も取消しを受け付ける。shotq の PNG の復元 (`unfilter_wavefront`) とディザ (`remap_dithered`) は、ワーカーが互いの進捗を待ってスピンする作りになっている。そのため、全体プールをほかの処理と共有しない
- rayon のスレッドは、メモリ上の計算だけをする。ファイル I/O、IPC、DB、Tokio には触れない
- shotq の中で panic が起きると、rayon は呼び出し元へ伝える。これを `catch_unwind` でファイル単位に受け止め、`AppError::Internal` に変える (フォルダ処理では、そのファイルを失敗として続ける)。ただし、上のスピンして待つ処理の途中でワーカーが panic すると、ほかのワーカーが待ち続け、panic が伝わらずに処理が終わらないことがある (4 章)。shotq の `panic = "abort"` は shotq を単独でビルドしたときの設定で、依存として使うときはアプリのプロファイル (unwind) に従う。mym-tools は今後も `panic = "abort"` にしない
- この例外は shotq に限る。ほかのモジュールが並列計算を必要とする場合は、それぞれ ADR を書く。前例として一般化しない

### 2.4 取消し

- shotq は、1 ファイルの最適化を途中で止められない。取消しは次の時点で確認する
  - 処理の順番を待っている間 (50 ms ごと)
  - 入力の読み込み中 (1 MiB ごと)
  - 最適化の後、書き込みの前
  - 置き換えの直前 (`image_export::write_atomically_with_guard`)
  - フォルダ処理では、各ファイルの前
- 最適化中に取消しを押した場合は、そのファイルの最適化が終わるまで待つ。上限の 4,000 万画素でも約 110 ms (2.5)。これは ADR-0009 の「1 MiB ごとに確認する」への例外であり、shotq の中だけに適用する

### 2.5 入力、出力、上限

- 入力は PNG だけ (先頭 8 バイトのシグネチャで確認)。shotq は無圧縮の BMP も読めるが、このモジュールでは扱わない
- 上限:
  - 1 ファイルは 128 MiB 以下 (8K の写真の PNG も収まる大きさ)
  - 画素数は 40,000,000 以下 (8K UHD の 7680×4320 = 33,177,600 が収まる)。デコードの前に IHDR で確認する。shotq 自身の上限は 2^28 画素
  - フォルダ処理は 1 回 10,000 ファイル以下
  - 実測 (Apple M4 Max、shotq CLI、UI 風の合成画像): 7680×5200 (4,000 万画素、11 MB) で約 110 ms・最大メモリ約 394 MB、5120×2880 で約 45 ms・約 159 MB。1 画素あたり約 10 バイト
- 画面で変えられるパラメータは quality の下限と上限 (0〜100、下限 ≤ 上限) と speed (1〜11) だけ。既定値は **70-85 / 11** (普段使っているコマンドと同じ。shotq の CLI の既定は speed 10)。zlib レベル、標本間隔、ディザは shotq の既定値 (CLI でフラグを付けないときの値) に固定する
- 出力の規則は shotq の CLI と同じにする。**出力先には必ず完全な PNG が残り、PNG 入力より大きくならない**
  - `optimized` (CLI の 0): 最適化した PNG を書く
  - `not_smaller` (CLI の 98) と `quality_too_low` (CLI の 99): 入力を残す。出力先が入力と同じなら何も書かない。違う場合は入力のバイト列をそのまま出力先へ書く
- 書き込みは、同じフォルダの一時ファイルに書いてから原子的に置き換える (`image_export::write_atomically_with_guard`)。失敗した場合や、置き換えの前に取り消した場合は一時ファイルを消し、元の出力を残す
- **1 ファイル**: 入力はファイル選択ダイアログか、OS からのドラッグ&ドロップで受け取る。出力は「別名で保存」(保存ダイアログ、既定名は入力と同じフォルダの `<名前>-optimized.png`) か「元のファイルを上書き」を選ぶ。出力先の拡張子は `.png` に限る。上書きは元に戻せないので、実行前に確認する
- **フォルダ**
  - 対象は、指定フォルダ直下の `*.png` (拡張子の大文字小文字は区別しない)。サブフォルダは見ない。シンボリックリンクと隠しファイル (名前が `.` で始まるもの、Windows の隠し属性) は除外する。ファイル名の順に処理する
  - 出力先は「別フォルダに同じ名前で書く」(既定) か「元のファイルを上書き」を選ぶ。別フォルダは入力フォルダと同じにできない。出力先に同じ名前のファイルがあれば上書きする
  - 実行前の確認ダイアログで、対象件数、合計サイズ、対象外の件数、上書きされるファイルの件数を示す
  - 1 ファイルずつ順に処理する。1 ファイルの中は shotq が並列化するので、ファイル単位では並列にしない
  - 1 ファイルが失敗しても続ける。最後に「最適化 / 品質が下限未満のため元のまま / 小さくならず元のまま / 失敗」の件数と、合計サイズの変化を示す
  - 取り消した場合、処理済みのファイルはそのまま残す (どれも完全な PNG)。処理中だったファイルの一時ファイルは消す

### 2.6 IPC

- 画像のバイト列は IPC を通さない。パスだけを渡し、読み書きは Rust 側でする (ADR-0018 と同じ)
- 公開する command:
  - `pngopt_optimize_file(operationId, inputPath, outputPath, qualityMin, qualityMax, speed)` → `{ output_path, status, input_bytes, output_bytes, width, height, duration_ms, detail }`
  - `pngopt_scan_folder(folderPath, outputMode, outputFolder?)` → `{ file_count, input_bytes, conflict_count, skipped_count }`。確認ダイアログ用で、書き込みはしない
  - `pngopt_optimize_folder(operationId, folderPath, outputMode, outputFolder?, qualityMin, qualityMax, speed, onProgress)` → `{ total, optimized, quality_too_low, not_smaller, failed, input_bytes, output_bytes, duration_ms }`。進捗は Tauri Channel で `started { total }` / `file { index, total, name, status, input_bytes, output_bytes, detail }` / `done { duration_ms }` / `cancelled` を送る
- `status` は `"optimized" | "quality_too_low" | "not_smaller" | "failed"` (`failed` はフォルダ処理の 1 ファイルだけ)。`outputMode` は `"separate" | "overwrite"`。画面の文言は日本語に変換する。shotq が返す英語の処理内容 (`detail`) は「詳細」欄にだけそのまま出す
- 取消しは `core_cancel_operation` と `OperationRegistry` を使う (ADR-0009)

### 2.7 検証の契約

- `src-tauri/src/modules/pngopt/contract/` に小さな合成 PNG を 7 枚置く。量子化、ICC プロファイル (qcms)、自前の PNG リーダーの波面並列と deflate の 16 チャンク分割 (1280×800)、半透明、256 色以下の可逆化、98、99 の経路をそれぞれ通る
- 複製元の commit でビルドした shotq の CLI (`--quality=70-85 --speed 11`) の出力の SHA-256 と結果を `expected.txt` に置く。mym-tools の `cargo test` (`contract_matches_the_shotq_cli`) が、同じ入力を `shotq::optimize` に渡し、SHA-256 と結果が一致することを確かめる。複製し直すときは期待値も作り直す (手順は同じフォルダの `README.md`)
- 98 / 99 の入力、壊れた PNG、上限を超える入力、入力と同じ出力先、取消し、フォルダの対象の選び方と集計について Rust のテストを置く

### 2.8 ライセンスと配布

- 複製した shotq のライセンス文と第三者通知をまとめた `third_party/shotq-NOTICES.txt` を置き、About の「Bundled components」と生成配布資産 `licenses/shotq-NOTICES.txt` に含める。リポジトリ直下の `THIRD_PARTY_NOTICES.md` に 1 行加える。shotq は MIT を選ぶ。zlib の `adler32.c` と puff から移植したコード、libdeflate (MIT)、libdeflater (Apache-2.0)、zlib-rs (Zlib)、qcms (MIT) などを含む
- 追加のファイルはない。アプリのリリースビルドのバイナリは、同じフロント資産で比べて +1,473,120 bytes (macOS arm64、圧縮前。21,412,720 → 22,885,840)。portable ZIP の増分は macOS / Windows のリリースビルドで実測し、PR に書く。どちらも 80,000,000 bytes 以下であること (ADR-0017 §4)
- libdeflate の C コードをビルドするため C コンパイラが要る。rusqlite (bundled) のために既に必要なので、CI の手順は増えない

## 3. Alternatives Considered

| 候補 | 判断 |
|---|---|
| ソースを複製してプロセス内で実行 | **採用**。ファイルが増えず、ビルドは cargo だけで済む。フォルダ処理でもファイルごとにプロセスを起動しない。代わりに ADR-0009 R-2 の限定例外 (2.3) と、ファイルの途中では止められないこと (2.4) を受け入れる |
| shotq の CLI を sidecar として同梱 (ADR-0020 と同じ形) | 次点。ADR-0009 をそのまま守れる。プロセスを kill すれば取り消せ、異常終了してもアプリは落ちず、CLI と同じ結果になるのも自明。ただし、2 プラットフォーム分のビルド、`externalBin` への登録、起動の確認を CI に足す必要があり、Windows の portable ZIP は 3 ファイルになる。フォルダ処理ではファイルごとにプロセスを起動する。NRBF を sidecar にした理由 (別のランタイムが必要) は、Rust の shotq には当てはまらない |
| private の shotq を git 依存にする | 不採用。CI に読み取り用のトークンが要り、第三者が public の mym-tools をビルドできなくなる |
| shotq を public にするか crates.io で公開し、版を固定して依存する | 今回は見送る。複製の手間はなくなるが、shotq を公開するかどうかは持ち主が別に決める。公開した場合は、この ADR を supersede して依存の方法を切り替えられる |
| プロセス内で 1 スレッドだけで実行し、例外を避ける | 不採用。1 スレッドのプールでも rayon を使う点は変わらない。速度は約 5 分の 1 に落ちる (1 章の表) |
| WebView 上で WebAssembly として実行 | 不採用。画像のバイト列を JavaScript の heap と IPC に載せることになる。rayon の並列化も使えない |

## 4. Consequences

- 普段使っている `shotq --quality=70-85 --speed 11` と同じ結果を、アプリの中でファイル単位でもフォルダ単位でも得られる
- ADR-0009 R-2 に、複製した shotq crate に限った例外ができる。アプリのコードに rayon を書かない決まりと、それを確かめる grep は変わらない
- shotq の unsafe なコード (並列処理用の生ポインタなど) に不具合があれば、アプリごと落ちうる。shotq は壊れた PNG を変形して与えるテスト (P37) で入力の検査を確かめている。アプリ側では上限 (2.5) で入力を絞る
- PNG の復元やディザの並列処理の途中で panic が起きると、ほかのワーカーが待ち続けて処理が終わらないことがある。その場合、そのワーカーのスレッドは CPU を使い続け、取消しも効かず、アプリを再起動するまで戻らない。起きるのは shotq に不具合があるときだけ (PNG の構造の異常は、並列処理の前の検査でエラーになる) なので受け入れるが、sidecar 方式ならプロセスを kill して回復できる。実際に起きた場合は、shotq 側で直すか、sidecar 方式に切り替えるかを判断し直す
- 実行中は CPU の全コアを使う。UI は WebView の別プロセスなので固まらないが、同時に走る別の重い処理 (Hash など) は遅くなる
- 上限の画像では、メモリを約 400 MB 一時的に使う (入力 128 MiB を読み込んだ場合はその分も加わる)
- shotq を更新するときは、複製、`UPSTREAM.md`、依存の版、期待値の SHA-256、ライセンス表記、ZIP サイズの実測を 1 つの変更でまとめて更新する (同梱エンジンの版を固定する方針と同じ)
- 依存の crate は mym-tools の `Cargo.lock` で固定される。出力に効く crate を更新すると契約テストが落ちるので、shotq 側の版と合わせて更新する

## 5. Validation Criteria

- 2.7 の契約テストが macOS / Windows の CI で通る (出力の SHA-256 が CLI と一致する)
- 同じ入力で、アプリの出力と shotq の CLI の出力が一致する (手元の実際のスクリーンショット数枚で確かめ、画像はコミットしない)
- 98 / 99 の入力で元のファイルが残る。上書きでも別名でも、出力先に完全な PNG が残る
- フォルダ処理で、PNG、PNG 以外、大文字の拡張子、サブフォルダ、シンボリックリンク、隠しファイル、壊れた PNG を混ぜても、対象の選び方、失敗しても続くこと、件数の集計が正しい
- 読み込み中、置き換えの直前、フォルダ処理の途中で取り消しても、既存の出力と一時ファイルが矛盾しない
- Windows でも上限の画像の所要時間と使用メモリを測る
- portable ZIP の増分を両 OS で測り、どちらも 80,000,000 bytes 以下である
- アプリのコードに `rayon::` が現れない (ADR-0010 §2.5 の grep が通る)
