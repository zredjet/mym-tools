# ADR-0020: NRBFを型非生成NativeAOT sidecarで解析する

- **Status**: Accepted
- **Date**: 2026-09-03
- **Deciders**: zredjet
- **Related**: requirements D-17 / architecture §10.6 / module-contract §12.10 / ADR-0009 / ADR-0013 / ADR-0017

---

## 1. Context

BinaryFormatterで作成されたNRBF payloadの内容を、項目名・値で検索できるtreeとして確認したい。一方、`BinaryFormatter.Deserialize`はpayloadが選んだ型を生成し、信頼できない入力に対する安全なinspection境界にならない。

独自NRBF parserをRustだけで実装すると、record graph、配列、共有参照、循環参照、上限処理を含む仕様追従と検証の責任が大きい。Microsoft公式の`System.Formats.Nrbf`は型を生成せずにNRBF recordを読み取れるが、Tauri本体とは異なる.NET runtimeを必要とする。

配布サイズを判断するため、本実装前に`NrbfDecoder`とJSON出力を実参照する.NET 10 NativeAOT helperをTauri sidecarとして両OSでbuildした。alpha.10とのportable ZIP比較は次のとおりで、増分10,000,000 bytes以下・総量80,000,000 bytes以下のgateを通過した。

| OS | alpha.10 | size gate build | 増分 |
|----|---------:|----------------:|-----:|
| macOS arm64 | 51,390,662 | 53,402,444 | 2,011,782 bytes |
| Windows x64 | 51,105,964 | 53,119,285 | 2,013,321 bytes |

## 2. Decision

### 2.1 Decoder境界

- `.NET 10 NativeAOT`の自己完結sidecarを採用し、`System.Formats.Nrbf 10.0.11`へ固定する。NuGet lockとruntime pack versionを固定する
- sidecarは`NrbfDecoder`から得たrecordだけを反復走査し、assembly / 型をロードしない。`BinaryFormatter`、`Deserialize`、任意型生成を禁止し、CIでソース混入を検査する
- 最初に現れたrecordを正規nodeとし、同じrecord IDの共有参照・循環参照は参照nodeにして再展開しない
- 読みやすい名前はauto-property backing fieldだけを機械的に短縮する。`List<T>` / `Dictionary<TKey,TValue>`は既知の内部形状へ厳密に一致した場合だけUIで論理表示し、それ以外はRaw構造を維持する
- 対象はファイル先頭にheaderを持つ既定`FormatterTypeStyle.TypesAlways` payloadとする。圧縮、暗号化、独自header、非ゼロ下限配列、型ロードなしで安全に展開できない複雑な多次元配列は対象外とする

### 2.2 Resource limits

| 対象 | 上限 |
|------|------|
| 入力 | 1 file / 64 MiB |
| 実行 | sidecar 55秒で省略、Rust wrapper 60秒で強制終了 |
| node | 500,000 |
| 1 arrayの展開 | 50,000要素 |
| 1 scalar | UTF-8 1 MiB |
| 検索対象文字列 | UTF-8合計32 MiB |
| protocol stdout | 256 MiB |
| protocol stderr | 64 KiB |

部分的な上限超過は、解析済み結果を捨てずに省略nodeとwarningで表す。byte配列は既定で長さだけを表示し、利用者が読込前に明示的に許可した場合だけ50,000要素まで展開する。500,000個の最小nodeだけでも見積り上約128 MiBとなるため、protocol stdoutは256 MiBとする。破損header、非対応形式、上限、sidecar異常終了を日本語errorへ変換する。

### 2.3 IPC・状態・UI

- 公開commandは`nrbf_inspect_file(operationId, path, expandByteArrays, onProgress)`とし、Tauri Channelで`started / nodes / done / cancelled`を通知する。nodeは500件ずつ送る
- `OperationRegistry`の`CancellationToken`を使い、cancel・60秒timeout時はsidecarを終了する。UIはcurrent operation IDと一致しない遅延eventを破棄する
- node契約はID、親ID、表示名、Raw名、kind、型名、assembly名、整形値、record ID、参照先ID、配列shapeを持つ。summaryはfile情報、root型、node数、warning、所要時間を持つ
- 検索は読みやすい名前・Raw名・整形済みscalar値に対するNFKC正規化・case-insensitive部分一致とする。項目名と値は独立入力とし、両方を指定した場合は同一nodeへのAND条件とする。一致nodeと祖先だけを表示する絞り込みと、通常tree上の前後の一致へ移動するジャンプを提供し、対象は先頭1,000件で打ち切る
- treeは32px固定行高で仮想化し、矢印key操作、展開／折りたたみ、参照先移動を提供する。Raw切替は受信済みnodeから導出し、再解析しない
- `nrbf`は既定有効・`text` category・statelessとする。入力、結果、検索、履歴をDB、設定、横断検索、export / importへ保存しない。編集・再シリアライズ・JSON出力は対象外とする

### 2.4 配布・検証

- Tauri `externalBin`へsidecarを登録する。macOSは`.app`内、Windows portable ZIPは`MyMyTools.exe`と`nrbf-decoder.exe`の2ファイル構成にする
- required check 6件は変更せず、macOS / Windowsの既存`build-tauri`内で.NET test、禁止API検査、NativeAOT publish、sidecar起動smoke testを実行する
- release candidate manifest、ZIP layout検査、第三者notice / license、fallback buildも同じ2ファイル契約へ同期する

## 3. Consequences

### 3.1 Positive

- BinaryFormatter deserializationを実行せず、Microsoft公式decoderで過去dataの構造と値を確認できる
- NativeAOTにより利用端末への.NET事前installを要求しない
- graphとresource limitを明示し、巨大・循環・破損payloadでUI processを直接消費しない
- DB schemaと既存module契約を変更せず、完全に画面内のinspectionへ閉じる

### 3.2 Negative / Risks

- Rust / TypeScriptに加えて.NET toolchain、NuGet lock、sidecar protocolの保守が必要になる
- Windows ZIPは単一実行fileではなく2ファイルになり、利用者は同じfolderへ展開する必要がある
- `System.Formats.Nrbf`が型非生成で提供できる情報に限定されるため、全BinaryFormatter payloadを元のobjectと同じ形で再現できない
- 解析結果はsidecar完了後にRustからbatch送信するため、非常に大きなfileではnode progressが完了近くに偏る

## 4. Rejected alternatives

- **`BinaryFormatter.Deserialize`**: payload由来の任意型生成を許すため不採用
- **Rust独自parserへ自動移行**: size gate不合格時のfallbackにはしない。安全性と仕様追従を別計画で評価する必要がある
- **framework-dependent .NET helper**: 利用端末へ.NET runtime installを要求するため不採用
- **解析結果のDB保存**: 原fileと重複する機微情報・巨大dataを永続化し、stateless要件を崩すため不採用

## 5. Validation Criteria

- [ ] primitive、Unicode、nested class、List / Dictionary、一次元・多次元・jagged array、null、共有参照、循環参照、DateTime / TimeSpan / Decimalを固定fixtureで検証する
- [ ] 破損入力、巨大null圧縮、許可あり／なしのbyte配列、各resource limit、非対応形式を検証する
- [ ] 名称／値の単独・AND検索、絞り込み／ジャンプ、Raw切替、参照移動、virtualization、keyboard、cancel、古いevent破棄をfrontend testで検証する
- [ ] sidecar protocol、Rust wrapper、両OS NativeAOT起動を検証する
- [ ] .NET / Rust / frontendの全gate、両OS Tauri build、ZIP layout・展開・size検査が成功する

## 6. References

- Microsoft: [BinaryFormatter payloadsを安全に読み取る](https://learn.microsoft.com/dotnet/standard/serialization/binaryformatter-migration-guide/read-nrbf-payloads)
- Microsoft: [BinaryFormatter security guide](https://learn.microsoft.com/dotnet/standard/serialization/binaryformatter-security-guide)
- Microsoft: [Native AOT deployment](https://learn.microsoft.com/dotnet/core/deploying/native-aot/)
- Tauri: [Embedding external binaries](https://v2.tauri.app/develop/sidecar/)
