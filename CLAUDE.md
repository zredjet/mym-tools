# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## リポジトリの状態

**Phase 1 の主要機能を実装済みの Tauri 2 デスクトップアプリ** (macOS Apple Silicon / Windows x64)。WebView 側は React 19 + TypeScript + Tailwind v4 + Zustand、ネイティブ側は Rust (MSRV 1.88) + rusqlite。カテゴリ別の 22 モジュールを一機能一モジュールで統合している (ADR-0014)。実行可能なコマンドは `README.md` と `package.json` / `src-tauri/Cargo.toml` を確認すること。

同梱エンジンの資産は `npm run prepare:drawio` / `prepare:vector` / `prepare:nrbf` で生成する (`dev` / `build` の pre スクリプトで drawio と vector は自動実行)。draw.io は Git submodule で固定している。

## 何を読むか (優先順)

設計が曖昧な時はこの順に確認する。**先に出てくるドキュメントが優先**。

1. `docs/requirements.md` — 何を作る/作らない、決定事項 D-01〜D-17、コア要件 C-01〜C-06
2. `docs/architecture.md` — プロセス/スレッドモデル、レイヤ責務、構造の理由
3. `docs/decisions/00NN-*.md` — ADR (改変不可。覆すなら新しい ADR で supersede する)
4. `docs/data-model.md` — SQLite スキーマ、`settings.json` 形式、エクスポート/インポート JSON、payload バージョニング規則
5. `docs/module-contract.md` — モジュールがコアと結ぶ契約 (= モジュール/コア境界)
6. `docs/ui-design.md` — UI の正典: トークン、画面スケルトン (§6 に C 系と各モジュール画面)、キーボードショートカット、空状態
7. `docs/developer-tools-plan.md` — 開発ツール 11 モジュールの範囲、段階、品質条件
8. `docs/release-process.md` / `docs/vector-editor-verification.md` — リリース手順、ベクター描画の検証・実機受入
9. `docs/MyMyTools Prototype.bundle.html` — 見た目の参考 (Claude Design 出力)。**技術判断のソースにはしない**

プロトタイプ HTML はブラウザで開けば想定の見た目が確認できるが、技術的な決定の根拠は ADR を見ること。

## ADR 一覧

| # | 決定 |
|---|------|
| 0001 | デスクトップシェルに Tauri v2 |
| 0002 | React + TypeScript + Tailwind v4 + shadcn/ui + Zustand (+ React Router 7)。TanStack Query / fuse.js は不採用 |
| 0003 | SQLite は rusqlite (bundled) + FTS5 trigram |
| 0004 | モジュールはビルド時静的合成。`items` テーブルを共有。Tauri command は中央で登録 |
| 0005 | タイムスタンプは JST ISO8601 + `+09:00`、固定 29 文字 (`YYYY-MM-DDTHH:MM:SS.sss+09:00`)、アプリ側で生成 |
| 0006 | モジュールデータは payload バージョニング + Eager-on-Read (DB マイグレーションはしない) |
| 0007 | ローカルバックアップは 3 系統: `auto` / `pre-op` / `manual`。リストアはメンテナンスモード経由 |
| 0008 | 自動更新なし。配布は portable 差し替え方式。About 画面は「最新版を確認」リンクのみ |
| 0009 | キャンセル機構: `OperationRegistry` + `tokio_util::sync::CancellationToken` + `core_cancel_operation` IPC。重い処理は `tauri::async_runtime::spawn_blocking` 経由、1 MB チャンク境界で `is_cancelled()` 確認 |
| 0010 | CI パイプライン: GitHub Actions matrix (macOS + Windows) で build / test / lint / typecheck / fmt。`clippy.toml` の `disallowed-methods` で `spawn_blocking` の直接呼び出しを禁止。SHA pin で依存固定 |
| 0011 | コアスキーマの **additive** な DDL マイグレーション (新カラム+DEFAULT / 新テーブル / 新インデックス / 新トリガ / VIEW) は枠組み内で許可。`db_schema_version` を bump し pre-migration バックアップを自動取得 |
| 0012 | モジュール有効状態を `settings.json` に保存し、sidebar / routing / search / 起動復元を frontend registry から導出。全モジュールをプロジェクト配下に置き、無効化しても export/import でデータを保持 |
| 0013 | リリースは `workflow_dispatch` の手動実行のみ。入力バージョンとtag commitの3設定を照合し、macOS / Windowsのportable ZIPを全ビルド成功後に公開。既存Releaseは上書きしない |
| 0014 | 一機能一モジュールを維持し、サイドバーは表示上だけカテゴリ分け (`ModuleDefinition.category`、未指定は `other`)。開閉状態は `core.collapsed_module_categories`。stateless module もプロジェクト配下 route |
| 0015 | HTTP モジュールは Rust の `http_send_request` のみで通信 (Frontend `fetch` / `tauri-plugin-http` 不使用)。stateless・既定無効、request/response を保存・ログしない |
| 0016 | Link / Memo 分離。`linkmemo` は URL / Path 専用に維持し、新規 `memo` を追加。旧 `type=memo` 行は起動時に `pre-split-linkmemo` バックアップ後 1 トランザクションで再所属 (この例外は一般化しない) |
| 0017 | Mermaid 11.17.2 / draw.io 31.4.1 を完全オフライン同梱。draw.io は `127.0.0.1` ランダム port の loopback origin + sandboxed iframe で隔離し Tauri IPC を公開しない。portable ZIP は各 **80,000,000 bytes 以下** のハード上限 |
| 0018 | PDF 結合は Rust の `lopdf` で完全ローカル処理 (stateless)。PDF bytes は IPC を通さず path のみ。暗号化・フォーム・署名等は拒否、出力は一時ファイルから原子的置換 |
| 0019 | required CI の `build-tauri` が生成した portable ZIP + candidate manifest を Release で再利用する。一意に解決できない場合のみ fallback build |
| 0020 | NRBF は `BinaryFormatter.Deserialize` を使わず、`System.Formats.Nrbf` を参照する .NET 10 NativeAOT sidecar で型非生成解析。入力 64 MiB / node 50 万等の上限、stateless |
| 0021 | ベクター描画は SVG-Edit 7.4.2 (上流 Editor.js は無改変) を loopback + sandboxed iframe で同梱。payload v1 `{ svg, text }`、SVG は UTF-8 20 MiB 以下。親子通信は `mym-vector-v1` の限定 postMessage のみ |
| 0022 | 派生データを同期するトリガの置換 (同一 tx の `DROP TRIGGER` + `CREATE TRIGGER`、同期結果不変、値書き換えなし) は ADR-0011 の `MIGRATIONS` 枠で可。v3 で FTS 更新トリガを `UPDATE OF project_id, module_id, search_text` に絞る |

## 絶対に破ってはいけない不変条件

D-03 (永劫互換) と各 ADR から導かれるもの。破ると静かにユーザーデータを壊すか、配布が破綻する。

- **コアスキーマの破壊的マイグレーションをしない**。`DROP` / `RENAME` / 型変更 / 既存値書き換えは禁止 (ADR-0006 のまま。派生データ同期トリガの置換だけは ADR-0022 の条件で可)。本当に必要なら新 ADR + `db_schema_version` 上昇 + C-12 起動停止画面の追加が前提
- **additive な DDL マイグレーション** (新カラム + DEFAULT / 新テーブル / 新インデックス / 新トリガ / VIEW) は **ADR-0011 の枠組みで許可**。`schema.rs::MIGRATIONS` にエントリを追加 + `db_schema_version` を bump + pre-migration バックアップが自動取得される。PR 説明で「additive か / バックアップ取得を確認したか」を必ず書く。現在の `CURRENT_DB_SCHEMA_VERSION` は 4
- **モジュールデータ変更は引き続き payload バージョニング + Eager-on-Read** (ADR-0006) で吸収する。コアスキーマには触らない。ADR-0016 の Link / Memo 再所属は限定的な例外であり、値書き換えの前例にしない
- **フロントエンドから SQLite に直接アクセスしない**。`@tauri-apps/plugin-sql` も使わず、`tauri::command` のみを通す (module-contract §6.2)。フロントは `src/ipc/*.ts` 経由の `invoke(...)` で型付き結果を受ける
- **タイムスタンプは必ずアプリ側で生成**。`CURRENT_TIMESTAMP` 等の DB 生成は禁止。JST `+09:00`、ms 3 桁、固定 29 文字 (ADR-0005)。文字列のまま辞書順ソート可
- **Zustand 単一ストアを Day 1 から使う**。アプリ全体状態 (現在プロジェクト / 現在モジュール / テーマ / 設定) はここに集約。モジュール内のローカル状態は `useState` でよい。Context には逃さない (architecture.md §2.3)
- **設定の永続化は `settings.json` だけを使う**。Zustand `persist` / `localStorage` を使わず、Rust の SettingsService 経由で未知キーを保持しながら原子的に保存する (ADR-0002 §4.4.3 / ADR-0012)
- **フロントエンドのモジュール列挙は `src/modules/registry.ts` を唯一の正典にする**。Shell / router / search / settings / 起動復元へモジュール ID の分岐を重ねない。カテゴリ定義と順序も同ファイル (ADR-0014)。無効化の詳細は ADR-0012 に従う
- **自動更新なし、起動時の version-check 通信もしない** (ADR-0008)。「最新版を確認」は OS ブラウザで GitHub Releases を開くだけ (`plugin-shell`)
- **完全オフラインを守る**。同梱エディタ (draw.io / SVG-Edit) はビルド時にもネットワーク取得しない。外部 script / font / plugin を読み込ませない。外部への通信は HTTP モジュールの `http_send_request` だけ (ADR-0015 / ADR-0017 / ADR-0021)
- **iframe エディタへ Tauri IPC を公開しない**。loopback origin はリモート扱いで、app command ACL は local app origin だけに付与する。親子通信は source / origin / session / token / サイズを検証する (ADR-0017 §3 / ADR-0021)
- **NRBF で型を生成しない**。`BinaryFormatter` / `Deserialize` / 任意型ロードは禁止 (CI で検出) (ADR-0020)
- **portable ZIP は各 80,000,000 bytes 以下** (ADR-0017 §4)。大きな資産や sidecar を足すときはサイズ増分を確認する
- **`data_revision` の意味**: アイテム内容を変える書込みでのみ増やす。Eager-on-Read による再構築や FTS 再構築、ADR-0016 の所属移行では**増やさない** (ADR-0007 §2.2)
- **検索スコープの内部値は `"project" | "global"`** (data-model §11.1)。UI 表示文言は「Current project / All projects」だが内部値は別物

## モジュール / データ規約 (間違いやすい)

- `items` は stateful モジュール共通の単一テーブル。モジュール固有データは `payload` JSON カラムに入れ、`payload_schema_version` を整数で持つ
  - **stateful (8)**: `prompt` / `linkmemo` / `memo` / `color` / `palette` / `mermaid` / `diagram` / `vector`
  - **stateless (14)**: `hash` / `codec` / `urlquery` / `datetime` / `idgen` / `secretgen` / `regex` / `textdiff` / `jwt` / `cron` / `a11y` / `http` / `pdfmerge` / `nrbf`。**何も書かない** (D-06)。入力・結果は画面を離れたら破棄する
- フロントの `ModuleDefinition.isStateless` と Rust の `ModuleBackend::is_stateless` は一致させる。stateful module は `searchAdapter` 必須 (`validateModuleDefinitions` が起動時に検査)
- モジュール ID は `^[a-z0-9]{3,32}$`。Tauri command 名は `<module_id>_<action>`、コアは `core_*`
- `items.title` は全モジュール共通の表示名。M-Color も独自の `name` フィールドは持たず `title` を使う
- M-Link (`linkmemo`) は `target` 単一フィールド (`url` / `path` の分割なし)。type は `"url" | "path"`。URL 欄に `file://...` を入れたら `path` に正規化する (`linkmemo_normalize_target` / module-contract §12.2)
- M-Memo (`memo`) の payload v1 は `{ body: string }` (空文字不可)。export schema v1 の旧 `linkmemo` + `type=memo` は import 時に `memo` へ正規化する (ADR-0016)
- Mermaid は `{ source }`、Diagram は `{ xml, text }` (各 UTF-8 1 MiB 以下)、Vector は `{ svg, text }` (SVG 20 MiB 以下)。`text` は検索用の抽出テキスト。いずれも一覧を挟まず直近 item か新規ドラフトを開く
- 大きな payload を持つモジュールの一覧・検索は `core_list_item_summaries` / `core_search_previews` (payload を SELECT しない) と `search_preview_field()` を使う (ADR-0021)
- M-Prompt の `variables` は**永続化しない**。読込み時に `body` から正規表現で抽出する
- Phase 1 の `projects` テーブルは `id / name / description / position / created_at / updated_at` のみ。**`accent` カラムはない**。Phase 1 のアクセント色は blue 固定 (ui-design §10 U-10 に Phase 2 持ち越し記録)

## UI 規約

- **shadcn の既定値 > カスタマイズ** (ui-design §1.2)。CSS を書く前にまず `Button` を試す。共通部品は `src/components/ui/` (`Button` / `Modal` / `ToolPage` / `EmptyState` など)
- CSS トークン (`--bg`, `--fg`, `--accent`, `--border`, `--row-h` など) は ui-design §2 と §12.4 に定義済。色は `R G B` 数値で持ち、Tailwind の `rgb(var(--bg) / <alpha-value>)` で透過対応する。`--accent` のみ OKLCH なのでこの形ではない
- 行高は **default 32px (compact, Linear 寄り)**、`36px` は comfortable な選択肢。サイドバー幅は default 240px、可変レンジ 180–320px
- キーボード優先。ショートカットは ui-design §8 に網羅。複数箇所に `onKeyDown` を散らさず `react-hotkeys-hook` 等で一元管理する
- 編集フォーム (P-3 / L-3 / K-2 など) には**プロジェクト欄を出さない**。アイテムは現在サイドバーで選択中のプロジェクトに自動所属する

## 作業時のルール

- `docs/decisions/` の ADR は**追記専用**。受理済 ADR は書き換えず、覆すなら新 ADR で supersede する。軽微な誤字訂正は可、ただし決定そのものは原文を残す。新 ADR を足したらこのファイルの ADR 一覧にも 1 行追加する
- `docs/ui-design.md` には末尾に改訂履歴テーブルがある。非自明な変更を入れたら 1 行追加し、冒頭の「v1.X の主な変更」プレリュードとヘッダのバージョン・最終更新日を同期させる
- `docs/MyMyTools Prototype.bundle.html` は 1.7MB の自己完結 HTML (Claude Design 出力)。オフライン参照のためにそのまま置いてある — 再生成・編集はしない
- 同梱エンジン (Mermaid / draw.io / SVG-Edit / NRBF sidecar) のバージョンは完全固定。更新時は対応 ADR が列挙するもの (submodule commit、定数、資産契約テスト、ライセンス表記、About 表示、実測サイズ) を同じ変更で更新する
- `src-tauri/src/storage/schema.rs::MIGRATIONS` を変更する PR は、PR 説明に以下を必ず書く (ADR-0011 §2.1 チェックリスト):
  - additive (新カラム+定数 DEFAULT / 新テーブル / 新インデックス / 新トリガ / VIEW) のみで構成されているか
  - 同 PR 内に non-additive (DROP / RENAME / 型変更 / 既存値書き換え) が混ざっていないか — 混ざる場合は別 ADR + C-12 起動停止画面の追加が必須 (ADR-0011 §2.2)
  - 各 Migration エントリ末尾に `UPDATE meta SET value=? WHERE key='db_schema_version'` を含めているか (§2.3)
  - `data-model.md §14.4` のマイグレーション一覧表を更新したか
  - pre-migration バックアップ取得 (`pre-migration-v<N>` プレフィックス) が `storage::bootstrap::take_pre_migration_backup` で起動時に走ることを実装テストで確認したか
- git user は `zredjet`、PR の base は `main`。作業開始時と push 前に現在ブランチを確認すること
