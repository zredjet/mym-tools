# ADR-0024: テキストファイルの文字コード判定・変換の境界

- **Status**: Accepted
- **Date**: 2026-10-07
- **Related**: requirements §2.2 / architecture §10.8 / module-contract §12.13 / ADR-0009 / ADR-0018

## Context

Excel が書き出す Shift_JIS の CSV や、古いシステムの EUC-JP のログなど、UTF-8 以外のテキスト
ファイルを手元で読み替えたい。WebView に貼り付けたテキストは既に Unicode になっているため、
文字コードの判定・変換はファイルのバイト列に対して行う必要がある。CSV ビューア (`csvview`) も
同じ判定でファイルを読む予定である。

文字コード変換では、表せない文字を `?` や `&#NNNN;` に置き換えたり、読めないバイトを U+FFFD に
したりして「成功」させると、利用者が気付かないままデータを壊す。Shift_JIS は Windows の CP932
との差 (〜 と ～ など) があり、Mac で入力した文字がそのままでは変換できないことも多い。

## Decision

- `encoding` (表示名「文字コード変換」) を `category = text`、`is_stateless = true`、
  既定有効の独立モジュールとする。入力 path・設定・結果は items や settings に保存しない。
- 判定・復号・符号化は Rust で行い、既存の依存の `encoding_rs` を使う。共通処理は
  `src-tauri/src/modules/text_encoding.rs` (`pub(crate)`) に置き、`encoding` と `csvview` が使う。
  モジュール同士は直接依存しない。
- Frontend は path だけを渡し、ファイルの中身は IPC に流さない (ADR-0018 と同じ)。
  プレビューとして先頭 2,000 文字だけを返す。
- 文字コードは閉じた enum で受け取る。`Encoding::for_label` は使わない
  (`iso-2022-kr` などのラベルが REPLACEMENT 符号化に解決され、全体が U+FFFD 1 文字になるため)。
  - 変換元: 自動 / UTF-8 / UTF-16LE / UTF-16BE / Shift_JIS / EUC-JP / ISO-2022-JP
  - 変換先: UTF-8 / UTF-8 (BOM 付き) / Shift_JIS / EUC-JP。encoding_rs は UTF-16 と
    ISO-2022-JP 以外の符号化を持つが、用途を絞ってこの 4 つにする
  - Shift_JIS は WHATWG の Shift_JIS (CP932 相当) である。UI では「Shift_JIS (CP932 相当)」と書く
- 自動判定は次の順に行う。chardetng は使わない (rayon を含む feature があり、扱えない文字コードを
  答えることがあるため)。
  1. BOM があれば確定
  2. BOM の無い NUL を含めば拒否 (バイナリか、BOM の無い UTF-16)
  3. すべて ASCII なら ISO-2022-JP のエスケープ (`ESC $ B` / `ESC $ @` / `ESC ( J` / `ESC ( I`) を
     探し、無ければ ASCII (UTF-8 として扱う)
  4. 正しい UTF-8 なら UTF-8
  5. Shift_JIS と EUC-JP を厳密に復号し、片方だけ読めればそれを推定とする。両方読めれば、
     かな・漢字を加点し半角カナ・私用領域を減点した点数で選ぶ (同点なら Shift_JIS)
  6. どれでも読めなければ判定できないとし、候補ごとの結果を返して利用者に選ばせる
- **置換文字で黙って壊さない。**
  - 復号は `decode_to_string_without_replacement`、符号化は `encode_from_utf8_*_without_replacement`
    だけを使う。`_without_replacement` が付かない `encode*` は使わない
  - 変換元の読めないバイト、変換先で表せない文字が 1 つでもあれば出力せず「拒否」として返す。
    件数は最後まで数え、先頭 20 件の位置 (バイト位置・行、または行・桁) を返す
  - encoder がエラーにせず別の文字に寄せるもの (¥ → 0x5C、‾ → 0x7E、− → 0x817C / 0xA1DD) は
    変換するが、件数と最初の行を警告として返す
  - 私用領域の文字 (Shift_JIS の外字) を UTF-8 に書くときも警告する
- 「Mac 由来の記号を Windows で使われる形に寄せる」オプションを設ける (既定は off)。
  〜→～、‖→∥、—→―、¢→￠、£→￡、¬→￢、−→－ に置き換え、件数を返す。
- 変換元と変換先が同じ文字コードで、記号の置換もしない場合は、文字を往復させずにバイトのまま
  改行と BOM だけを変える (検証のための厳密な復号はする)。往復させると NEC 選定 IBM 拡張
  (ED/EE) が IBM 拡張 (FA–FC) に変わるなど、元のバイトが変わるため。CR / LF は UTF-8・
  Shift_JIS・EUC-JP の多バイト文字の中に現れないので、バイト単位で安全に置き換えられる。
- 改行は「そのまま / LF / CRLF」。CRLF・単独の CR・LF をそれぞれ 1 つの改行として数え、
  1 MiB の区切りをまたぐ CR は次の区切りへ持ち越す。
- 出力は別名で保存する (元のファイルは上書きしない)。出力先が入力と同じファイル (hardlink、
  大文字小文字だけ違う名前を含む) なら拒否する。判定には `same-file` を直接の依存として使う
  (既に間接依存している版)。拡張子は問わない。
- 上限は `encoding` が 1 ファイル 64 MiB。`csvview` はファイル 10 MiB、復号後 32 MiB とし、
  復号済みの文字列を返す (`vector_read_file` と同じく、表示に文字列が要るため)。
- 処理は `tauri::async_runtime::spawn_blocking` で行い、読込・判定・復号・符号化を 1 MiB ずつ
  区切って `CancellationToken` を確かめる。変換は 1 MiB ずつ 復号 → 記号の置換 → 符号化 →
  改行の変換 と流して一時ファイルに書き、置換の直前にも取消しを確かめる (ADR-0009 / ADR-0018 の
  原子的保存)。拒否・取消し・失敗では一時ファイルを消し、既存の出力を残す。
- 結果は `Ok({status: "written" | "rejected", ...})` で返し、`AppError` に variant を足さない。

## Alternatives Considered

| 候補 | 判断 |
|---|---|
| Rust の `encoding_rs` | **採用**。既に依存しており、WHATWG 準拠の Shift_JIS / EUC-JP / ISO-2022-JP を扱える |
| WebView の `TextDecoder` + JS の符号化ライブラリ | 不採用。ファイルの中身を IPC に流すことになり、`TextDecoder` の表は WebView / ICU の版で違う |
| `chardetng` で判定 | 不採用。扱えない文字コードを答えることがあり、Shift_JIS と EUC-JP の区別は厳密な復号で足りる |
| 表せない文字を `?` や数値文字参照にして成功させる | 不採用。利用者が気付かないままデータが壊れる |
| 上書き保存 | 不採用 (初版)。誤った変換元で上書きすると元に戻せない |

## Consequences

- ネットワークも外部ツールも使わずに、Shift_JIS・EUC-JP・UTF-16 のファイルを UTF-8 などへ
  変換できる。変換できない場合は理由と位置が分かる。
- 自動判定は推定を含む。windows-1252 のテキストが Shift_JIS として読めてしまう場合などは
  誤判定するため、確度 (BOM / 確定 / 推定 / 判定できません)、候補ごとの結果、プレビューを
  表示し、変換元を手動で選び直せるようにする。
- EUC-JP の補助漢字 (JIS X 0212) は復号できるが符号化できないため、EUC-JP → EUC-JP でも
  文字を往復させる場合 (記号の置換をするとき) は拒否されうる。
- 64 MiB のファイルは全体を読み込むため、その分のメモリを一時的に使う。変換の出力は区切り
  ごとに書くので、出力全体をメモリに持たない。

## Validation Criteria

- BOM 付き UTF-8 / UTF-16LE / UTF-16BE、ASCII、ISO-2022-JP、UTF-8、Shift_JIS、EUC-JP、
  どれでも読めないバイト列を判定し、確度と候補が期待どおりになる。
- 読めないバイトと表せない文字の位置 (バイト位置・行・桁) が正しい。
- ¥ / ‾ / − の警告と、Mac 記号の置換の件数が正しい。
- Shift_JIS → Shift_JIS の改行だけの変換で、NEC 選定 IBM 拡張のバイトが変わらない。
- 1 MiB の区切りをまたぐ CRLF と多バイト文字を正しく扱う。
- 拒否・取消しで既存の出力が残り、一時ファイルが残らない。入力と同じファイルへの出力を拒否する。
- Excel が書き出した Shift_JIS の CSV、Mac で入力した 〜 を含む UTF-8 を実機で変換し、
  出力を `iconv` / `xxd` で確かめる。
