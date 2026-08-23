# 開発ツール拡張ロードマップ

最終更新: 2026-08-23 / ステータス: 実装済み

## 1. 方針

- 一機能一モジュールを維持し、統合モジュールは作らない。
- 新規 11 モジュールはすべて stateless とし、入力・履歴・プリセットを永続化しない。
- モジュール増加はカテゴリ別の折りたたみ表示で扱い、機能境界を崩さない。
- ローカル完結の 10 モジュールは既定で有効、ネットワーク通信を行う HTTP だけは既定で無効とする。
- 既存のプロジェクト配下 route、Frontend / Backend registry の集合一致、モジュール間直接依存禁止を維持する。

## 2. 導入段階

### Stage 1: ローカル変換・生成

- `codec`: Base64 / Base64URL / URL percent / HTML entity / Unicode escape
- `urlquery`: URL 分解とクエリパラメータ編集
- `datetime`: Unix 秒・ミリ秒・ISO 8601・IANA タイムゾーン変換
- `idgen`: UUID v4 / UUID v7 / ULID / NanoID
- `secretgen`: 暗号学的乱数によるパスワード・Hex / Base64URL token

### Stage 2: 解析・検証

- `regex`: ECMAScript RegExp、match / capture / replace preview
- `textdiff`: 行・単語差分、空白・大文字小文字の無視
- `jwt`: 3 segment JWS の decode と `exp` / `nbf` / `iat` 表示。署名検証は行わない
- `cron`: Unix 5 field / seconds 付き 6 field、IANA timezone、次回 10 件
- `a11y`: WCAG 2.2 contrast と色覚シミュレーション

### Stage 3: ネットワーク

- `http`: Rust IPC 経由の軽量 HTTP client。履歴、cookie jar、multipart、TLS 検証無効化は提供しない

## 3. 表示カテゴリ

| ID | 表示名 | モジュール |
|---|---|---|
| `manage` | 管理 | prompt, linkmemo |
| `design` | カラー・デザイン | color, palette, a11y |
| `text` | テキスト・解析 | hash, codec, regex, textdiff |
| `web` | Web・通信 | urlquery, jwt, http |
| `generate` | ID・秘密値 | idgen, secretgen |
| `time` | 日時・スケジュール | datetime, cron |

開閉状態は `settings.json` の `core.collapsed_module_categories` に保存する。キーがない初回はすべて展開し、現在表示中のモジュールを含むカテゴリは自動的に開く。

## 4. 品質条件

- 各モジュールに純粋処理の単体テストと代表的な UI interaction test を置く。
- Worker 処理は timeout / unmount / 再実行で終了し、古い結果を表示しない。
- HTTP は scheme、timeout、redirect、response size、cancel、秘密 header の origin 跨ぎを検証する。
- DB schema、items、FTS、data_revision、export / import の shape を変更しない。
- 各 Stage 完了時に Frontend lint / format / typecheck / test / build と Rust fmt / clippy / test を実行する。
- リリース前に macOS / Windows CI、起動時間、メモリ、portable ZIP size を確認する。

## 5. 対象外

- 履歴、プリセット、お気に入り、横断検索、export / import
- JWT の署名検証・生成、JWE
- Cron の Quartz 固有記号と year field
- HTTP の cookie 管理、multipart、ファイル送信、proxy、無効証明書の許可
- URL 取得によるアクセシビリティ監査、HTML 静的監査

## 6. 実装結果

- 11機能を個別のFrontend / Backend moduleとして登録し、既存5機能と合わせて16モジュールになった。
- カテゴリ別の折りたたみSidebarとSettings表示を追加し、開閉状態を`core.collapsed_module_categories`へ保存する。
- 全新規画面をroute単位で遅延読込し、未使用モジュールの処理ライブラリを起動時bundleから分離した。
- Frontendの純粋処理テスト、11画面の代表操作テスト、registry / settingsテストを追加した。
- HTTPはRust native client、既存OperationRegistryのcancel、2 MiB request / 5 MiB response上限、5回redirect、1〜120秒timeoutを実装した。
- DB schema、items、FTS、data_revision、export / importのshapeは変更していない。
