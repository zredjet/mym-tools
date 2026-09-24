# ベクター描画の検証と実機受入

最終確認: 2026-09-24。仕様は[ADR-0021](decisions/0021-offline-vector-editor.md)。実装とローカル検証は完了し、`v0.1.0-alpha.14`として公開した。macOSの実IME受入は公開版で完了した。Windowsの実機受入が未実施のため、両OSの配布受入完了とは扱わない。

## ローカル自動検証

| 対象 | 結果 |
|---|---|
| Frontend typecheck / ESLint / Prettier | 成功 |
| Frontend全体 | 54ファイル・326テスト成功（資産準備2件を含む） |
| Rust fmt / Clippy（警告禁止） | 成功 |
| Rust全体 | 336テスト成功 |
| Chromium実エディタ | 起動、日本語、図形・パス・レイヤー・グラデーションのSVG往復、PNG/JPEG/WebP埋込、Undo/Redo、SVG再読込、PNG生成、透過背景、保存ショートカットを確認 |
| レイヤー操作の回帰 | 表示・順序・SVG文書内タイトルの変更とUndo/Redoでrevisionが増えることを確認。標準UIからの作成・複製・改名、空名・重複名の拒否、取消・Escape・同名改名の無変更、文書切替時の取消、入力中の保存要求拒否とショートカット抑止を確認。複製のUndo/RedoでSVGとレイヤー一覧が一致することを確認 |
| 入力境界 | 共通fixturesをDOM/Rust両方で使用。DTD、script、イベント属性、foreignObject、CSS・href・cursor・color-profileの外部参照、画像形式不一致、不正XMLを拒否。SVG 20MiB / text 1MiBのUTF-8境界を確認 |
| 編集境界 | 保存中の追加編集・タイトル変更を未保存として保持。古いorigin/source/session/文書/要求IDの拒否。30秒timeout、再試行、破棄、ダイアログ取消、安定した終了リスナー、旧文書のショートカット拒否、画像デコード待ち中の追加編集を含む挿入前の容量再判定を確認 |
| 永続化 | アプリ／プロジェクトJSONとSQLiteバックアップの往復、不正payloadのJSON取込拒否、検索テキスト不一致の拒否 |
| 一覧・検索 | 複数の大きいSVGを保存して、一覧はpayloadなし、検索は最大120文字のtextだけを返す。旧API・既存モジュールの検索結果・project scopeを維持 |
| 同梱資産 | 固定version/integrity、資産manifest再現性、IIFE/map/test/opensave/storageの除外、Draw.io再準備でSVG-Edit資産とライセンスが残ることを確認 |
| 外部通信 | ブラウザ検証で同梱origin以外への要求を中断する設定を使用し、実際の外部要求0件・不足資産0件・JS error 0件 |

エディタの資産は347ファイル、約3.6MB。標準Editor.jsは変更せず、アダプター、レイヤー名入力dialog、入力ポリシー、日本語補完を同梱する。source mapは監査時にだけ参照する。入力dialogの表示・フォーカスをスクリーンショットでも確認した。IME変換中のEnterは合成イベントによる検証であり、実際のIME受入とは区別する。

## macOS実アプリ

既存データから分離するため、`com.zredjet.mymtools.vectorqa`、製品名`MyMyTools Vector QA`のrelease `.app`を作成し、実際のWKWebViewとネイティブダイアログで検証した。

| 操作 | 結果 |
|---|---|
| 新規プロジェクトとベクター描画の起動 | 成功 |
| 日本語UI、作品中の日本語表示、日本語の貼付入力 | 成功 |
| SVG取込とPNG画像挿入 | 成功 |
| Cmd+S（親画面／iframe内フォーカス） | 成功 |
| 保存した画像入り作品の再表示・再起動後の読込 | 成功 |
| 検索プレビューと結果から編集画面への遷移 | 成功 |
| SVG/PNG書出しと保存状態の維持 | 成功。PNGは640×480、6,580 bytes |
| 未保存の画面移動と取消／破棄 | 成功 |
| 未保存Cmd+Qの確認・取消・破棄後の実際の終了 | 成功 |
| 保存済み文書の確認なし終了 | 成功 |
| レイヤーの作成・複製・改名と日本語の貼付入力 | 成功。HTML dialogを使い、sandbox権限は追加していない |
| レイヤー複製後のUndo/Redo | 標準ツールバーボタンで成功。レイヤー一覧の削除・復元を確認 |
| レイヤー表示だけを変更した後のCmd+Q | 未保存表示と終了確認、取消後の再保存に成功 |
| レイヤー順序だけを変更した後の画面移動 | 未保存確認、取消後の再保存に成功 |
| レイヤー名入力のEscape取消 | 保存済み状態を維持し、確認なしで終了できることを確認 |
| 実際のIMEによる日本語変換・確定 | 成功。2026-09-24に公開版`v0.1.0-alpha.14`のportable ZIPで確認 |

新規IPCのACLとSDKの`onCloseRequested`が使用するclose/destroy権限は親ウィンドウのlocal capabilityだけに付与し、iframe originへは付与しない。macOSメニューのCmd+Qもwindow close経路を使う。2026-09-13の修正版ではレイヤー操作・入力dialog・未保存確認・保存・終了を再検証した。外部cursor/color-profile拒否、文書ID付き操作要求、画像デコード後の容量再判定は自動テストとChromiumで検証済みだが、修正版のネイティブ受入一式は繰り返していない。

検証用データと成果物は`.generated/vector-verification/`、アプリデータは検証用identifierの専用フォルダに置く。既存の通常identifierのユーザーデータで受入操作は行っていない。

## portable ZIP

| 対象 | 結果 |
|---|---|
| macOS arm64、通常identifier `com.zredjet.mymtools` | **54,756,523 bytes**、上限80,000,000 bytesまで25,243,477 bytes |
| ZIP CRC・内部パス | 成功。MyMyTools.app、実行ファイル、NRBF sidecarを確認 |
| SHA-256 | `c7cbb23434e8fbcb2f282bd6c2599c455761948a252018441828f00ddb9b9f03` |
| Windows x64（ローカル） | 未作成。公開版で判定する |

macOS成果物は`.generated/vector-verification/MyMyTools_vector-local_macos_aarch64.zip`。NRBF/UIの既存未コミット変更を含む作業ツリーのローカル検証用ZIPであり、公開用リリースではない。JSON実測結果を同フォルダの`portable-result.json`に記録している。

### 公開版 `v0.1.0-alpha.14`

Release workflowはrequired CIのcandidateを再利用し、fallback buildはskipした。公開後にassetを再ダウンロードし、release contractの`check-assets`、ZIP CRC、内部構造、SHA-256とRelease digestの一致を確認した。

| 対象 | サイズ | alpha.13からの増分 | SHA-256 |
|---|---:|---:|---|
| macOS arm64 | 54,528,926 bytes | +975,324 | `520a1a1adc0e0693338bdd9dc96c01ef7dffa0683962ca92b8272cce31296f6b` |
| Windows x64 | 54,205,156 bytes | +955,081 | `547a1a79f4253b691ba8fd51c364c9ac86caa549f4bac012bba67ec117f0acfc` |

macOS ZIPは`MyMyTools.app`とNRBF sidecar、Windows ZIPは`MyMyTools.exe`と`nrbf-decoder.exe`の2ファイルだけを含む。SVG-Edit資産はアプリ本体へ埋め込まれる。

Windowsの実行受入（IME・ショートカット・ネイティブダイアログ・終了確認・メニューバーが表示されないこと・画像出力）は未実施として残す。ローカルでのWindows検証は、Parallelsのサービスへ接続できず実施できなかった。

## 再実行

Node 22とリポジトリ指定Rustを使用する。依存とdraw.io submoduleを初期取得した後、通常prepare/buildはローカル配布物だけを参照する。

```sh
npm run prepare:vector
npm run test:vector:assets
npm run typecheck
npm run lint
npm test
npx playwright install chromium
npm run test:vector:browser
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features --locked --offline -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --all-targets --all-features --locked --offline
npm run tauri -- build --bundles app -- --locked --offline
```

ブラウザ検証はユーザーのアプリDBを使わず、独立した同梱資産サーバーを起動する。Chromiumのローカルネットワーク権限は検証用contextだけに指定する。assetテストは生成フォルダを更新するため、同じ生成フォルダを使うビルドと同時実行しない。

Windows受入では、画像入り作品を複数保存した一覧／検索の返却データにSVG本文がないこと、JSON往復、未保存確認、SVG/PNG書出しを確認し、既存release contractで最終ZIPを検査する。Windows結果が揃うまで未実施欄を成功へ変更しない。
