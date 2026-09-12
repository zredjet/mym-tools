# ADR-0021: SVG-Editによるオフラインのベクター描画

- **Status**: Accepted
- **Date**: 2026-09-12
- **Deciders**: zredjet（実装計画の承認）
- **Related**: ADR-0004 / ADR-0007 / ADR-0009 / ADR-0012 / ADR-0017

## Context

図解用のdraw.ioに加え、パス・文字・図形を編集するベクター描画をプロジェクトの作品として保存する。画像入りSVGは従来の図より大きくなるため、一覧と検索が作品本文を返す既存APIをそのまま使わない。

## Decision

### 機能と保存

`vector`を「ベクター描画」、カテゴリ`design`（カラー・デザイン）、既定有効のstateful moduleとして登録する。初期画面では直近の作品を開き、存在しない場合は640×480の新規文書を開く。標準の図形、パス、文字、レイヤー、グラデーション、整列、Undo/Redoを使い、PNG/JPEG/WebPは親画面の画像挿入で埋め込む。

共通itemsへpayload v1 `{ svg: string, text: string }`、タイトル、タグを保存する。DB / JSON export schemaは変更しない。UTF-8でSVGは20MiB以下、SVGのtext/title/descから生成する検索テキストは1MiB以下とする。Rustでも文字抽出を行い、不一致のpayloadを拒否する。バックアップとアプリ／プロジェクトJSON入出力は共通の経路を使う。

### 配布とライセンス

npm `svgedit`を7.4.2に完全固定し、package-lock.jsonのintegrityで取得物を固定する。`prepare:vector`はインストール済み配布物の`dist/editor/Editor.js`、CSS、画像、コンポーネント、およびconnector/eyedropper/grid/markers/panning/shapes/polystar/layer_viewとその共有ES Module補助資産をコピーする。IIFE、テスト、サンプル、ソースマップ、opensave/storage拡張は含めない。通常prepare/buildでは取得・更新しない。Draw.ioとSVG-Editのprepareはそれぞれ自身の資産だけを更新する。

本体のMITだけでなく、配布物のsource mapから内包ライブラリを調査する。`scripts/svgedit/license-audit.json`が対象部品、`third_party/svgedit-NOTICES.txt`がライセンス全文・著作権表示を保持する。MIT、Apache-2.0、BSD系、Zlib等を含む。DOMPurifyはApache-2.0、rgbcolorはMITを選択する。旧LGPL svgToPdfプラグイン／旧X11 jsPDFは選択したruntimeに含まれず、そのためのソース提供義務は発生しない。現行jsPDF関連コードは上流のES bundleに含まれるため、UIを隠してもライセンス対象として扱う。Aboutと配布資産へ全文を同梱する。固定版更新時はこの監査をやり直す。

### 隔離と入力検証

モジュールを初めて開く時に専用の`127.0.0.1`ランダムportを起動する。HTTPはGET/HEADのみで、Host、パス、peerを検証する。iframeは`allow-scripts allow-same-origin`だけを持ち、remote originにTauri capabilityを与えない。CSPで外部接続、外部画像・フォント、子frame、popupを遮断する。

上流のEditor.jsは変更せず、専用host adapterで読込・ソース編集・貼り付け・画像挿入を共通検証へ接続する。DTD、実体宣言、処理命令、script、イベント属性、foreignObject、外部href/CSS参照、未対応要素を理由付きで拒否する。許可する画像は形式と内容を照合したPNG/JPEG/WebPのbase64だけ。内部の`#id`参照は保持する。保存時にも検証し、禁止内容を除去して成功扱いにはしない。

エディタのlocalStorage/sessionStorageはインスタンス内のメモリ実装に置き換える。ブラウザ保存は使用せず、初期版には永続エディタ設定を設けない。将来必要な設定は共通settings経路へ追加する。日本語の標準UIと、同梱拡張の翻訳補完を使う。

### 親子通信と未保存状態

`mym-vector-v1`の限定postMessageだけを公開する。起動、load、changed、snapshot、png、insertImage、操作要求、errorを扱う。親子でsource/origin/sessionを照合し、要求ID・文書ID・受信形式・サイズを検証する。旧文書・旧要求への応答は破棄する。汎用の任意メソッド呼出しは提供しない。

変更通知はrevisionだけを送り、全文は保存・書出しなどの要求時に取得する。保存は明示操作とCmd/Ctrl+S。取得したrevisionとその時点のタイトル・タグを基準に保存し、その後の編集は未保存として残す。新規・取込・作品／プロジェクト切替・画面移動・ウィンドウ終了で破棄確認を行う。macOSのCmd+Qはwindow close経路へ接続し、SDKが確認後に使うclose/destroyは親画面だけに許可する。要求は30秒でタイムアウトし、失敗・破棄でもロックを解除する。キャンセルしたファイル選択は文書を変更しない。

### 一覧・検索と出力

`core_list_item_summaries`はpayloadをSELECTせず、ItemSummaryだけを返す。`core_search_previews`はモジュール契約`search_preview_field()`をSQL投影に反映する。vectorの返却payloadは`{text: 最大120文字}`であり、画像入りSVGをRustの行デコードやIPCへ読み出さない。既存モジュールは従来の検索表示用payloadを返す。SearchPreviewは表示専用で、編集時はIDから完全なitemを取得する。旧core_list_items/core_searchは互換のため維持する。

SVGは編集情報を保ったまま書き出す。PNGは文書寸法の1倍、透過背景で、文書内の背景オブジェクトは描画する。20MiB、1辺16,384px、16,777,216画素を上限とし、拡張子と形式を確認して同一ディレクトリの一時ファイルから原子的に置換する。書出しはプロジェクト保存済み状態を変えない。

## Acceptance

互換性の基準はSVG-Editで作成した文書の保存・再編集。任意の外部SVGの完全互換、PDF、クラウド、外部プラグイン、Illustrator形式は対象外。自動テスト、macOS/Windows実アプリ受入、各portable ZIPの80,000,000 bytes上限検証を別々に記録する。実行方法と未実施項目は[ベクター描画の検証](../vector-editor-verification.md)を参照する。
