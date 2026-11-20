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

### 6. 2026-09-01追補: ローカル画像書出しと言語・ページ契約

- Mermaidは現在sourceのrenderに成功している場合だけ、サニタイズ済みpreviewをSVGまたは白背景・2倍のPNGとしてuser-selected pathへ書き出せる。構文error中に保持している直前previewは書出し対象にしない。
- `mermaid_write_file`は`.svg` / `.png`、20MiB以下だけを扱い、SVG active content / 外部参照とPNG署名をbackendでも検証して原子的に置換する。画像書出しはitems payloadと未保存stateを変更しない。
- draw.io UIは同梱済み`resources/dia_ja.txt`を`lang=ja`で読み込み、日本語へ固定する。言語変更や追加downloadは提供しない。
- draw.ioのPNG書出しはembed export protocolの`currentPage: true`を指定し、現在表示中の1ページだけを画像化する。`.drawio`は全ページ、SVGは現在の編集ページという既存契約を維持する。

### 7. 2026-09-30追補: Tauri 2.11.6とeditor iframeのIPC境界

- Tauriは2.11.6以上を使う（GHSA-w28w-mhc8-qvjv）。2.11.5以前は、Tauri内部の`plugin:__TAURI_CHANNEL__|fetch`（8 KiB以上のChannel messageの取得）がremote originに対するACLの拒否から外れており、アプリ全体で共有する連番IDのqueueを他のwebviewやoriginから取得・消費できた。
- 2.11.6でもこのcommandのACL除外自体は残る（Tauri v3で撤去予定）。2.11.6はqueueをwebview単位に分けるが、draw.ioとSVG-Edit（ADR-0021）のeditor iframeはmain webviewのsubframeで同じwebviewに属するため、main frameのqueueから分離されない。§3の「core / plugin IPCを拒否する」は、この1 commandを除いて成り立つ。
- WindowsではWebView2がTauri初期化scriptをsubframeにも挿入するため、editor iframeからもinvoke keyが見える。IPC endpointへの接続を止めているのはeditor CSPの`connect-src 'self'`であり、postMessage経路はtop-level frameのmessageしか受け付けない。macOSでは初期化scriptはmain frameだけに入る。
- したがってdraw.ioとSVG-Editのeditor CSPの`connect-src`へ`ipc:` / `http://ipc.localhost`を加えない。editor CSPを緩める変更は、この境界を再評価してから行う。

### 8. 2026-09-30追補: draw.io 31.5.3へ更新

- draw.ioの固定先を31.5.3（tag `v31.5.3`、commit `0f419a92c769adb5fb20f2b18053a5ae8c7e4993`）へ更新する。§2の資産範囲とprepare方式、§3のセキュリティ境界、§4の配布契約は変えない。上流の`js/PreConfig.js`は、引き続きMyMyToolsの上書き版で置き換える。
- 更新理由（同梱資産のうち実行時に使われるもの）:
  - `js/app.min.js`に内包され実行時に使われるDOMPurifyを3.4.13から3.4.16へ更新する（`js/sanitizer/purify.min.js`は実行経路で読み込まれない）。
  - 図の属性値に含まれるmarkupがhost pageへ届く問題、MathJaxの`\data`マクロによる任意data属性の書込み、font URLのscheme検査の迂回を修正する（31.4.2〜31.4.4）。
  - URL parameterで書出しservice / AI endpointを差し替えられる脆弱性（GHSA-ff67-v9r9-6877 / GHSA-v2pv-rjf8-9w9v、31.4.6で修正）。iframe URLは親が固定し、editor CSPが外部通信を拒否するため直接の影響はないが、多層防御として取り込む。
  - `window.EXPORT_URL = null`が「書出しserviceなし」として保持される。31.4.1では既定の外部URLへ置き換わっており、通信はCSPで遮断していた。
  - 親を持たないcellが混ざった図を読み込むとpageが空になり、次の保存で空のpageが書き戻される問題を修正する（31.5.1）。
  - PlantUML変換器（`js/plantuml/drawio-plantuml.min.js`）は同一loopback originから遅延読込みされるため、更新が実行時に反映される。Mermaid / ELK / JSZipは実行時に変化しない`js/extensions.min.js`から読むため、上流のそれらの更新は反映されない。
- `index.html`、embed JSON protocol（`init` / `load` / `autosave` / `save` / `textContent` / `export` / `openLink`）、同梱directory構成と拡張子は31.4.1と同じため、親画面、`drawioBridge`、Rustのasset serverとCSPは変えない。資産は3,362から3,366 files、`resources/dia_ja.txt`は2,003から2,022 keysになる。
- 31.5.0から、すべてのmodel変更（`mxChildChange` / `mxTerminalChange` / page操作）にundo / redoの実行時修復が入った。これを主な回帰リスクとし、Chromium上の自動検証（`npm run test:diagram:browser`、ローカル専用）と、macOS実アプリの手動受入で確認した。31.4.6（commit `744cb5420fdf126efd7a09b1d7082ca3e12c0841`）へ戻すのは、31.5.3でだけ起き、実アプリで手動再現できるundo / redoの回帰を確認した場合だけとする。今回は該当しなかった。記録は[ダイアグラムの検証と実機受入](../diagram-editor-verification.md)に置く。
- 更新時に同じ変更で揃える対象（§2）に、資産契約の`DRAWIO_DOMPURIFY_VERSION`（`js/app.min.js`内のDOMPurifyの版）と、`scripts/drawio/browser-support.mjs`の版ごとの実行時期待値を加える。

| 対象 | 31.4.1 | 31.5.3 |
|---|---:|---:|
| draw.io生成asset（`du -sk`）/ files | 151,604 KiB / 3,362 | 153,868 KiB / 3,366 |
| Tauri release binary（macOS arm64、ローカル） | 69,854,992 bytes | 70,388,096 bytes |
| portable ZIP（macOS arm64、ローカル） | 55,471,762 bytes | 56,010,464 bytes |
| portable ZIP（macOS arm64、CI） | 55,468,344 bytes | **56,009,715 bytes**（+541,371） |
| portable ZIP（Windows x64、CI） | 55,357,651 bytes | **55,893,321 bytes**（+535,670） |

CIの値は、31.4.1がTauri 2.11.6のmain（commit `73de392`）、31.5.3がこの更新のPRのbuild-tauriである。両ZIPは§4の80,000,000 bytes上限と、CIのsize gate（ADR-0020、alpha.10比+10,000,000 bytes以下: macOS 61,390,662 / Windows 61,105,964 bytes）を満たし、size gateまでの余裕はmacOS 5,380,947 bytes、Windows 5,212,643 bytesである。

### 9. 2026-11-20追補: draw.io 32.7.4へ更新

- draw.ioの固定先を32.7.4（tag `v32.7.4`、commit `f411a11f4f6b8994d869bdbc45f4d4d9e2284f34`）へ更新する。§2の資産範囲（11 directoryと4 file）とprepare方式、§3のセキュリティ境界、§4の配布契約は変えない。上流の`js/PreConfig.js`は31.5.3から1 byteも変わっておらず、引き続きMyMyToolsの上書き版で置き換える。
- 更新理由（同梱資産のうち実行時に使われるもの）:
  - 図に置いたSVG画像のstyle `editableCssRules`の正規表現によるReDoS（GHSA-55cm-f4p8-xq88、medium、32.6.8以前が対象）。32.6.9で正規表現を制限し、32.6.10でselectorごとの長さの上限を加えた。細工した`.drawio`を開くとeditor iframeが応答しなくなる。macOSではiframeが親画面と同じWeb Content processで動くため、アプリの画面全体が止まり得る。31.x系に修正は無い。
  - `js/app.min.js`に内包され実行時に使われるDOMPurifyを3.4.16から3.4.18へ更新する。3.4.16には低深刻度の既知の問題が3件ある（GHSA-cg2g-xh64-v4q7 / GHSA-mrv2-3pqr-j5jr / GHSA-c6gr-qvv4-5v3f、いずれも3.4.17で修正）。draw.ioの`Graph.sanitizeNode`は`IN_PLACE`で呼び、`afterSanitizeAttributes` hookで`node.remove()`を行うため、GHSA-mrv2（IN_PLACEのhookで親や兄弟を消すと、切り離された部分のevent handlerが残る）の条件に近い。
  - 31.6〜32.7で入った、実行時に使われる部分の強化: DOMPurifyの後でsanitize済みの属性を確かめる（32.3.0）、XMLのdecodeに最大の深さを設け、methodへのdecodeを止め、styleを文字列としてだけ読む（32.3.0）、MathJaxのsafe filterを起動時に適用しAsciiMathの出力にも掛ける（31.6.0）、細工した値に対する図形・layout・ELKの上限（32.4〜32.6）。
- 32.0での構成の変化と、変わらないもの:
  - stencil XMLが上流のrepositoryから無くなり、`js/stencils.min.js`の新しいbinary形式のbundleだけになった。`stencils/`は206から2 files（LICENSEとclipartのPNG 1つ）になる。stencilは同一loopback originの`js/stencils.min.js`から読まれ、`/stencils/*.xml`への要求は起きない。
  - MathJaxは31.6.0から1 fileのbundle（`math4/es5/drawio-mathjax.min.js`）になり、`math4/`は78から2 filesになる。数式の描画ではWorkerを作らず、検証でもCSP違反は起きなかった。bundleには読み上げ（speech rule engine）用に`blob:`のWorkerを作る経路があるが、31.5.3の`math4/es5/core.js`にも同じ経路があり、使われてもeditor CSPの`worker-src 'none'`が遮断する。
  - 同梱資産は3,366から3,065 files、`du -sk`で153,868から117,136 KiBになる。§2の11 directoryと4 fileはすべて残り、新しい拡張子は無いため、`CLIENT_DIRECTORIES` / `CLIENT_FILES`と`protocol.rs`のMIME表は変えない。
  - `index.html`は起動中の表示（logoとstatus）だけが変わり、読み込むfileは同じ。embed JSON protocolの追加（hostが`configure`を送った時の`configuration` event、plugin向けの`embedLoaded`、`load` eventの`readOnly`など）は`drawioBridge`の解釈を変えず、実ブラウザ検証でもアプリが拒否するmessageは0件だった。`mxfile`形式の変更は省略できる属性の追加だけ。したがって親画面、`drawioBridge`、Rustのasset serverとCSPは変えない。
  - `resources/dia_ja.txt`は2,022から2,998 keysになる。`save` / `orthogonalEnds`の訳は同じ。
  - SVG書出しは前景色を`light-dark()`でなくCSS変数`var(--ge-adaptive-fg, #000000)`で書く。キャンバスの取込変換（`drawio_import.rs`）はこれを既定値へ置き換え、32.7.4の書出しをfixtureに加えた。
- §8の訂正: §8は「Mermaid / ELK / JSZipは実行時に変化しない`js/extensions.min.js`から読む」としたが、32.7.4では`js/extensions.min.js`も3,909,802から4,745,297 bytesへ変わる（同梱のJSZipは3.10.0から3.10.1）。今回の更新では、`js/extensions.min.js`の変更も実行時に反映される。
- 32.6.2から、選択が無い時のShift+矢印はフォーカスの移動になり、ページの移動はCtrl（macOSは⌘）+Shift+矢印になった。上流の操作の変更であり、アプリでは上書きしない。
- 主な回帰リスクは、stencilとMathJaxの読込み方式の変更、XMLのdecodeの強化による旧版の図の読込み、undo / redoである。Chromium上の自動検証（`npm run test:diagram:browser`、ローカル専用）とmacOS実アプリの手動受入で確かめた。記録は[ダイアグラムの検証と実機受入](../diagram-editor-verification.md)に置く。
- 32.6.10（commit `c72c9a98b7a6ce392556ed04c05e0ff19f43f5c3`、上流のstable channel、DOMPurify 3.4.17）へ戻すのは、32.7.4でだけ起き、実アプリで手動再現できる回帰（図の読込み・保存・書出し、既存の図の表示、undo / redo）を確認した場合だけとする。32.6.10もGHSA-55cm-f4p8-xq88とDOMPurifyの3件の修正を含み、§9の構成の変化とページ移動のキーも32.7.4と同じである。今回は該当しなかった。

| 対象 | 31.5.3 | 32.7.4 |
|---|---:|---:|
| draw.io生成asset（`du -sk`）/ files | 153,868 KiB / 3,366 | 117,136 KiB / 3,065 |
| Tauri release binary（macOS arm64、ローカル） | 70,554,784 bytes | 62,447,376 bytes |
| portable ZIP（macOS arm64、ローカル） | 55,516,891 bytes | 47,431,683 bytes |
| portable ZIP（macOS arm64、CI） | 55,512,992 bytes | **47,430,363 bytes**（−8,082,629） |
| portable ZIP（Windows x64、CI） | 55,468,756 bytes | **47,455,041 bytes**（−8,013,715） |

ローカルの値は、検証用identifierのrelease buildを同じ作業ツリーで比べたものである。CIの値は、31.5.3がmain（commit `adc3cdb`）、32.7.4がこの更新のPRのbuild-tauriである。両ZIPは§4の80,000,000 bytes上限とCIのsize gate（macOS 61,390,662 / Windows 61,105,964 bytes）を満たし、size gateまでの余裕はmacOS 13,960,299 bytes、Windows 13,650,923 bytesになる。

### 10. 2026-11-20追補: Mermaid 12.3.0へ更新

- Mermaidの固定先を12.3.0へ更新する（§2の「11.17.2へ固定」を置き換える）。動的import、§3の`securityLevel: strict`・HTML label無効・描画後の再除去、§6の書出し契約は変えない。11.x系は11.17.2が最後で、以後の修正は12.x系にだけ入る。
- 更新理由:
  - DOMPurifyの下限が`^3.4.17`になる（12.3.0）。lockのDOMPurifyは3.4.18。11.17.2のままでも範囲内で3.4.18にできるが、Mermaid自身の下限が上がるので古い版へ戻らない。
  - KaTeXが0.18系になり、GHSA-238p-pmpm-9mq7（low、0.18.2で修正）が`npm audit`から消える（12.2.0）。数式は`foreignObject`に描かれ`sanitizeRenderedSvg`が除去するので、11.17.2でも表示には届いていなかった。
  - flowchartの構文解析とfront matterの正規表現にあった二次時間の処理が直る（12.0.0 / 12.1.0）。
- 見た目は12の既定を採る。既定のlayoutはELK、既定のlookは`neo`で、`initialize`では`layout` / `look`を指定しない。テーマ（`default` / `dark`）は従来どおり明示する。
- 保存済みの図はsourceを変えないまま、次に開いた時から新しい並びと見た目で描かれる。変わるのは、flowchart / state / class / ER / requirementの並び（辺は直角に曲がる）、影や光彩、ひし形などの図形の大きさとラベルの折返し。PNG書出しも同じ見た目になる。diagramのfront matterで`layout: dagre`や`look: classic`を指定すれば、図ごとに従来の見た目へ戻せる。
- 互換性:
  - edge IDに`[ ] ( ) { } |`を含む図は構文errorになり、§3どおり保存を拒否する。
  - ラベル中の`</br>`は改行として扱う。
- ELKは`elkjs` 0.12.1（EPL-2.0 OR GPL-3.0-or-later、MyMyToolsはEPL-2.0を選ぶ）で、Mermaidのbuildが遅延chunkとして含む。同一originのchunkから読み、外部から取得しない。§5と同じく、license全文（`licenses/elkjs-LICENSE.txt`）とsource linkを配布assetとAboutに加える。
- 動作環境: Mermaid 12はES2024 / Safari 17.4以上を前提にする。macOSのWKWebViewはシステムのWebKitを使うため、macOS 12 / 13はSafari 17.4以降へ、macOS 14は14.4以降へ更新していることを前提にする（requirements §3.2に注記）。WindowsのWebView2は自動更新されるため影響しない。macOS 12〜14の実機では確かめていない。
- 実描画の検証: 単体testはMermaidをmockするため、ローカル専用の`npm run test:mermaid:browser`（Chromium）を足した。
  - 本番と同じvite buildの出力に、アプリのCSPを付けて`127.0.0.1`から配信する。
  - 17種類の図（`scripts/mermaid/corpus.mjs`）を、default / darkの両テーマで`renderMermaid`と`renderMermaidPng`に通す。
  - 全件が描画できること、ラベルの文字がSVGに残ること、active content / 外部参照が残らないこと、CSP違反・外向き通信・console errorが0件であることを確かめる。
  - 版ごとのPNGを`.generated/mermaid-verification/compare.html`に並べる。
  - 11.17.2と12.3.0の両方で34件すべて成功した。12.3.0ではELKのchunkが同一originから読み込まれた。

| 対象 | 11.17.2 | 12.3.0 |
|---|---:|---:|
| Mermaid部分のbuild出力（検証用entry、JS / CSS） | 61 files / 3,412,409 bytes | 62 files / 5,223,038 bytes |
| 同上のBrotli（品質9）合計 | 895,510 bytes | 1,370,543 bytes（+475,033） |
| うちELKのchunk | — | 1,512,970 bytes |

## Consequences

- 図編集はネットワーク断でも同じ機能・資産で動き、図データ送信のオンライン経路を持たない。
- 19 moduleのregistry、検索、設定、有効／無効、direct URL、project export/importを既存共通契約のまま利用できる。
- repository checkoutとrelease artifactが大きくなり、submodule初期化とbuild前asset準備が必須になる。
- 起動直後にはdraw.io iframeを生成しないため100MB目標は維持対象だが、editor利用中memoryは別計測となる。

## Validation Criteria

- [x] 現行macOS arm64の実portable ZIPが80,000,000 bytes以下（47,430,363 bytes、§9のdraw.io 32.7.4）
- [ ] Windowsの実portable ZIPが80,000,000 bytes以下
- [ ] Windows 10 / 11、macOS 12最新patch、現行macOSで編集、全asset、保存、再読込、SVG / PNG書出しが成功
- [ ] 代表操作中の外向き通信0件、全asset requestがlocal originで解決
- [ ] editorから親DOM、Tauri core IPC、外部URLへアクセス不能
- [ ] draw.io moduleを開くまでeditor assetを初期化せず、起動直後memory 100MB目標を維持
- [ ] Mermaidの成功／失敗／連続入力／theme／保存制御／検索／未保存遷移testが成功
- [x] MermaidのSVG／白背景2倍PNG、構文error時の書出し拒否、容量・active content検証が成功
- [ ] DiagramのXML検証／不正message／init-load-save-export／file I/O／text検索／破損／容量testが成功
- [ ] draw.io UIが完全offlineで日本語表示され、複数ページ図のPNGが現在pageと一致

## References

- Mermaid 11.17.2: <https://www.npmjs.com/package/mermaid/v/11.17.2>
- draw.io pinned source: <https://github.com/jgraph/drawio/tree/fea5e877f3e6f849331ad09894f7edb9771708fa>
- draw.io pinned source（§8、31.5.3）: <https://github.com/jgraph/drawio/tree/0f419a92c769adb5fb20f2b18053a5ae8c7e4993>
- draw.io ChangeLog（31.5.3）: <https://github.com/jgraph/drawio/blob/0f419a92c769adb5fb20f2b18053a5ae8c7e4993/ChangeLog>
- GHSA-ff67-v9r9-6877: <https://github.com/jgraph/drawio/security/advisories/GHSA-ff67-v9r9-6877>
- GHSA-v2pv-rjf8-9w9v: <https://github.com/jgraph/drawio/security/advisories/GHSA-v2pv-rjf8-9w9v>
- draw.io pinned source（§9、32.7.4）: <https://github.com/jgraph/drawio/tree/f411a11f4f6b8994d869bdbc45f4d4d9e2284f34>
- draw.io ChangeLog（32.7.4）: <https://github.com/jgraph/drawio/blob/f411a11f4f6b8994d869bdbc45f4d4d9e2284f34/ChangeLog>
- draw.io 32.6.10（§9の戻し先）: <https://github.com/jgraph/drawio/tree/c72c9a98b7a6ce392556ed04c05e0ff19f43f5c3>
- GHSA-55cm-f4p8-xq88: <https://github.com/jgraph/drawio/security/advisories/GHSA-55cm-f4p8-xq88>
- DOMPurify GHSA-cg2g-xh64-v4q7 / GHSA-mrv2-3pqr-j5jr / GHSA-c6gr-qvv4-5v3f: <https://github.com/cure53/DOMPurify/security/advisories>
- draw.io embed mode: <https://www.drawio.com/doc/faq/embed-mode>
- Mermaid 12.3.0（§10）: <https://github.com/mermaid-js/mermaid/releases/tag/mermaid%4012.3.0>
- Mermaid 12.0.0の変更点（§10）: <https://github.com/mermaid-js/mermaid/releases/tag/mermaid%4012.0.0>
- elkjs 0.12.1（§10）: <https://github.com/kieler/elkjs/tree/0.12.1>
- GHSA-238p-pmpm-9mq7（§10）: <https://github.com/advisories/GHSA-238p-pmpm-9mq7>
