# ADR-0018: ローカルPDF結合の処理境界

- **Status**: Accepted
- **Date**: 2026-09-02
- **Related**: requirements §2.2 / architecture §10.5 / module-contract §12.9 / ADR-0009

## Context

複数PDFを任意のファイル順で結合し、1つのローカルPDFとして保存したい。PDF本体を
WebViewへ渡す方式はIPCとメモリの負担が大きく、外部サービスや別途インストールするCLIは
完全ローカルかつportableな配布要件と合わない。PDFのフォーム、署名、しおり、添付は
Catalog単位の統合規則を必要とし、ページ連結だけでは安全に保持できない。

## Decision

- `pdfmerge`を有効既定、`category = other`、`is_stateless = true`の独立モジュールとする。
  入力一覧・順序・結果はitemsやsettingsへ保存しない。
- 入力はuser-selected pathだけを扱い、Frontendは複数選択dialogまたはTauriのOS drag/dropで
  pathを得る。PDF bytesはIPCを通さない。
- Rust側は`lopdf 0.44.x`を`default-features = false`で使用する。同版のMSRVに合わせて
  アプリの`rust-version`を1.88へ上げる。`lopdf`が許容する`aes 0.9.3`はRust 1.89を要求するため、
  lock解決を1.88対応の`aes 0.9.2`へ固定する。
- 1回の処理は2〜50ファイル、同一pathの重複を許可し、並び順をそのまま出力ページ順とする。
  入力ファイルサイズは重複分も数えて合計200 MiB以下、1 streamの展開は64 MiB以下とする。
- 暗号化、AcroForm / Widget、署名、Outlines、EmbeddedFiles / AF、Collectionを検出したPDF、
  ページ0件、壊れたPDFは拒否する。高度構造を黙って欠落させた出力は作らない。
- 各入力の既存page treeを新しい`Pages` rootの子として接続し、ページ内content、resources、
  annotation、page box、rotationと継承属性を維持する。元Catalog、Info、文書単位metadataは
  引き継がず、最小Catalogを新規生成する。出力versionは入力中の最大versionと1.5の大きい方。
- 事前検査と結合開始時の両方で入力を検証する。出力pathが入力自身と一致する場合は拒否する。
- 検査と結合は`spawn_blocking`で実行し、1 MiB読込単位、ファイル間、object統合後、出力置換直前に
  `CancellationToken`を確認する。進捗はoperation単位のTauri Channelで通知する。
- 出力は同一directory内の一時ファイルへ書き、flush / sync後に原子的に置換する。失敗または
  置換前キャンセルでは一時ファイルを削除し、既存出力を維持する。置換完了をcommit pointとする。

## Alternatives Considered

| 候補 | 判断 |
|---|---|
| `lopdf`をRust側で使用 | **採用**。portable配布を保ち、ページobjectを再エンコードせず結合できる |
| `pdf-lib`をWebViewで使用 | 不採用。全入力と出力をJavaScript heapへ載せ、binary IPCも増える |
| qpdf等の外部CLIを同梱 | 不採用。別binary、platform別配布、起動・エラー境界が増える |
| 全ページを画像化してPDFを再生成 | 不採用。検索可能text、vector、link、画質を失う |

## Consequences

- macOS / Windowsで同じRust実装を使い、ネットワークなしで結合できる。
- 初版の互換範囲をページ中心に限定することで、署名失効やフォーム破損を成功扱いしない。
- `lopdf`は文書objectをメモリに保持するため、200 MiB上限内でも入力構造に応じた一時的な
  メモリ増加がある。64 MiB stream展開上限と入力総量上限を安全弁とする。
- ページ単位の並べ替え、削除、thumbnail、高度構造の統合、password入力は別ADRで拡張する。

## Validation Criteria

- 2件、10件、重複入力を結合し、再読込したpage countとpage orderが一致する。
- 縦横、異なるpage box、rotation、画像、日本語textを含む代表PDFを結合して描画確認する。
- 非対応構造、壊れたPDF、上限超過、入力消失、入力と同じ出力先を拒否する。
- 読込中・統合中・置換直前のキャンセルで既存出力と一時ファイルの整合を確認する。

## 2026-09-30追補: lopdf 0.45.0への更新

- `lopdf`を0.45.x（`default-features = false`）へ更新する。0.44.0は、相互参照streamの`/W`に巨大な幅を持つ約112 bytesのPDFを読むと、その幅で領域を確保しようとしてpanicではなくプロセスのabortで終了する（lopdf #532の3、#533で修正）。事前検査に入力を追加しただけでアプリ全体が終了し、上記の「壊れたPDFは拒否する」を満たせない。
- 0.45.0のMSRVも1.88のため`rust-version`は変えない。`lopdf`が許容する`aes 0.9.3`は引き続きRust 1.89を要求するため、`aes 0.9.2`固定を維持する。0.45.0で必須依存に加わった`brotli-decompressor`は、Tauriがasset展開に使う同じ版（5.0.0）を共有する。
- 0.45.0は相互参照の軽微な誤り（`startxref`のずれ、stream `/Length`の不一致など）を修復し、解決できない場合はobjectの走査で相互参照表を再構築する。上記の「壊れたPDF」は、この修復後も解析できないPDFを指す。読み込めた入力にも、従来どおり非対応構造とページ0件の検査を適用する。
- 再構築の走査は、最後の`endstream`より後ろにある終端のない`stream`ごとに入力の末尾まで読み直すため、入力の大きさの2乗の時間がかかり、途中で取り消せない（64 KiBの細工入力でrelease build 0.23秒、1 MiBで約1分の見込み）。読み込む前に同じ条件の`stream`を線形時間で数え、4つを超える入力は、相互参照の再構築とstartxrefの補正を行わない`strict`で読めた場合だけ受け付け、読めない場合は拒否する。途中で切れたファイルは1つしか持たないため影響せず、コメントや文字列に`stream`が並ぶだけの正常なPDFもstrictで読めるため受け付ける。
- 0.45.0のerror表示は原因を含まなくなったため、拒否理由には原因の連鎖を展開して表示する。展開サイズ上限（64 MiB）の理由は、上限を超えた場合だけ表示する。
- 残るリスク（上流で未修正、このアプリの経路から到達し得るもの）:
  - 間接参照された`/Length`の連鎖の深さに上限がない。
  - 相互参照streamのpredictorが、攻撃者の`/Columns`で行bufferを確保する（lopdf #569の2）。
  - `/Prev`で連なる相互参照の和集合に上限がない（lopdf #563）。
  - object streamの上限errorがlenientな読込では握りつぶされる（lopdf #569の1）。
- 検証: 上記の細工PDF（`/W`が2^40とi64::MAX）と、終端のない`stream`を多数持つ入力を、事前検査と結合開始時の再検証の両方で拒否し、既存出力を変更しないことを単体テストで確認する。
