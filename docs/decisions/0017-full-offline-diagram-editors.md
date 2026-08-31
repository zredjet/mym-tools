# ADR-0017: Mermaid / draw.ioの完全オフライン同梱と配布サイズ上限

- **Status**: Accepted
- **Date**: 2026-08-31
- **Deciders**: zredjet
- **Related**: requirements D-02 / D-15 / ADR-0012 / ADR-0013 / ADR-0014 / ADR-0015

## Context

Mermaid記法の編集・プレビューと、VS Code draw.io拡張に近いローカル図編集をMyMyToolsへ追加する。オンライン版draw.ioをframeで開く案は、編集中の図データが外部サービスへ送られ得るため採用しない。オンライン／ローカルのモード切替も、誤選択と二重のセキュリティ境界を生むため持たない。

draw.ioの全クライアント編集資産は展開時約147.75MBで、TauriバイナリへBrotli圧縮埋込みした増分は約45.18MBと見積もる。従来の「インストーラ30MB以下」目標とは両立しないが、完全オフラインと全ステンシル・テンプレートの価値を優先する。

| 対象 | 2026-08-31時点の見積り |
|---|---:|
| 現行リリースZIP | macOS 5.34MB / Windows 5.23MB |
| draw.io全クライアント資産（展開時） | 147.75MB |
| Tauri圧縮埋込み後の増分 | 約45.18MB |
| Mermaid追加分 | 約0.8〜1.5MB |
| 統合コード・license等 | 約1〜3MB |
| 想定リリースZIP | 52〜56MB |
| 想定展開後アプリ | 58〜65MB |
| draw.io submodule作業ツリー | 約200MB |

### PoC実測（macOS arm64）

固定した全クライアント資産をTauri release binaryへ実際に埋め込み、portable ZIPまで作成した結果は次のとおりだった。ZIPは`unzip -t`に成功し、ハード上限まで28,747,522 bytesの余裕がある。

| 対象 | 実測値 |
|---|---:|
| draw.io生成asset | 151,656 KiB（`du -sk`） |
| Tauri release binary | 60,256,928 bytes |
| `.app` bundle | 58,952 KiB（`du -sk`） |
| portable ZIP | **51,252,478 bytes** |
| 80,000,000 bytes上限までの余裕 | **28,747,522 bytes** |

Windowsの最終ZIP実測はWindows release workflowで行い、両OSの検査が揃うまでは配布判定を完了扱いにしない。

## Decision

### 1. モジュール境界

- `mermaid`（表示名「Mermaid」）と`diagram`（表示名「ダイアグラム」）を、category `design`、既定有効の独立stateful moduleとして追加する。
- 両モジュールとも一覧を初期画面にせず、直近のitemまたは新規ドラフトを直接開く。共通items CRUD、検索、project export/importへ参加し、DB schemaは変更しない。
- Mermaid payload v1は`{ source: string }`、Diagram payload v1は`{ xml: string, text: string }`とし、各文字列をUTF-8で1MiB以下に制限する。

### 2. 固定バージョンと資産範囲

- Mermaidを11.17.2へ固定し、動的importする。
- draw.ioを31.4.1のcommit `fea5e877f3e6f849331ad09894f7edb9771708fa`へGit submoduleで固定する。build時にネットワークから取得・更新しない。
- `images`、`img`、`js`、`math4`、`mxgraph`、`plugins`、`resources`、`shapes`、`stencils`、`styles`、`templates`を含む全クライアント編集資産を決定的なprepare scriptでbuild用ディレクトリへコピーする。
- Java server用`WEB-INF` / `META-INF`、service worker、cloud storage接続ページ、サーバー依存変換は同梱しない。外部pluginの取得も許可しない。
- 更新時はsubmodule commit、`DRAWIO_VERSION`、asset契約test、license / About表示、本ADRの実測値を同じ変更で更新する。

### 3. セキュリティ境界

- Mermaidは`securityLevel: strict`、HTML label無効で初期化し、描画結果からactive contentとHTTP(S)外部参照を再除去してから親DOMへ挿入する。構文失敗時は最後の成功SVGを維持して保存を拒否する。
- draw.ioはmoduleを開いた時だけ`127.0.0.1`のrandom portへbindする専用loopback originから配信し、sandboxed iframeへ置く。asset serverはGET / HEADと厳密なHost / pathだけを受理し、図dataは扱わない。親React画面とのデータ交換はJSON `postMessage`だけとする。
- 親は`event.source`、許可origin、event順序、request token、受信サイズを検証する。iframeへTauri core IPCを公開しない。
- Tauri app command ACLをlocal app originだけへ付与する。loopback editorはremote originとして扱われ、Windows WebView2が初期化scriptをsubframeへ挿入する場合もcore / plugin IPCを拒否する。
- editor CSPは言語・テンプレート等の同梱資産をXHRで読むため`connect-src 'self'`だけを許可し、外部script / font / image / frame / WebSocketを拒否する。親CSPの`frame-src`は`http://127.0.0.1:*`だけを追加し、`embed.diagrams.net`等を追加しない。受信messageは起動時に確定したrandom-port originとの完全一致を要求する。
- `.drawio` / `.xml`取込はrootを`mxfile` / `mxGraphModel`へ限定し、DTDとentity宣言を拒否する。書出しは`.drawio` / `.xml` / `.svg` / `.png`だけを同一ディレクトリの一時ファイルから原子的に置換する。
- 図内のHTTP(S)リンクはeditor自身に開かせず、親で確認してから既存OS browser起動境界へ渡す。図XMLは渡さない。

### 4. 配布契約

- requirementsの30MB目標を廃止し、macOS / Windowsの各portable ZIPを**80,000,000 bytes以下**とするハード上限へ置換する。
- Release workflowは両ZIPの実sizeを検査し、上限超過時にpublishを失敗させる。直前Releaseに同名assetがある場合はsize差分もStep Summaryへ記録する。
- portable ZIP、手動version入力、macOS / Windowsの既存配布方法はADR-0013どおり維持する。
- 全クライアント資産を実バイナリへ埋め込むPoCでどちらかの最終ZIPが80MBを超えた場合、機能や資産を黙って縮小せず実装を停止して再判断する。

### 5. License

- MermaidのMIT licenseとdraw.ioのApache License 2.0全文、固定version、source linkを配布assetとAboutへ含める。
- Mermaid / draw.ioの公式logoは使用しない。

## Consequences

- 図編集はネットワーク断でも同じ機能・資産で動き、図データ送信のオンライン経路を持たない。
- 19 moduleのregistry、検索、設定、有効／無効、direct URL、project export/importを既存共通契約のまま利用できる。
- repository checkoutとrelease artifactが大きくなり、submodule初期化とbuild前asset準備が必須になる。
- 起動直後にはdraw.io iframeを生成しないため100MB目標は維持対象だが、editor利用中memoryは別計測となる。

## Validation Criteria

- [x] 現行macOS arm64の実portable ZIPが80,000,000 bytes以下（51,252,478 bytes）
- [ ] Windowsの実portable ZIPが80,000,000 bytes以下
- [ ] Windows 10 / 11、macOS 12最新patch、現行macOSで編集、全asset、保存、再読込、SVG / PNG書出しが成功
- [ ] 代表操作中の外向き通信0件、全asset requestがlocal originで解決
- [ ] editorから親DOM、Tauri core IPC、外部URLへアクセス不能
- [ ] draw.io moduleを開くまでeditor assetを初期化せず、起動直後memory 100MB目標を維持
- [ ] Mermaidの成功／失敗／連続入力／theme／保存制御／検索／未保存遷移testが成功
- [ ] DiagramのXML検証／不正message／init-load-save-export／file I/O／text検索／破損／容量testが成功

## References

- Mermaid 11.17.2: <https://www.npmjs.com/package/mermaid/v/11.17.2>
- draw.io pinned source: <https://github.com/jgraph/drawio/tree/fea5e877f3e6f849331ad09894f7edb9771708fa>
- draw.io embed mode: <https://www.drawio.com/doc/faq/embed-mode>
