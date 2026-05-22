# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## リポジトリの状態

**現時点ではドキュメントだけのリポジトリ**。実装コード・`package.json` / `Cargo.toml` ・ビルド / テスト / lint コマンドはまだ存在しない。「ビルドして」「テストして」と言われたら、コマンドを捏造せず**まだ実装されていない旨を伝えること**。

Phase 1 の実装は **Tauri 2 のデスクトップアプリ** になる予定 (WebView 側: React 18 + TypeScript + Tailwind v4 + shadcn/ui / ネイティブ側: Rust + rusqlite)。詳細は `docs/`。

## 何を読むか (優先順)

設計が曖昧な時はこの順に確認する。**先に出てくるドキュメントが優先**。

1. `docs/requirements.md` — 何を作る/作らない、決定事項 D-01〜D-14、コア要件 C-01〜C-06
2. `docs/architecture.md` — プロセス/スレッドモデル、レイヤ責務、構造の理由
3. `docs/decisions/000N-*.md` — ADR (改変不可。覆すなら新しい ADR で supersede する)
4. `docs/data-model.md` — SQLite スキーマ、`settings.json` 形式、エクスポート/インポート JSON、payload バージョニング規則
5. `docs/module-contract.md` — モジュールがコアと結ぶ契約 (= モジュール/コア境界)
6. `docs/ui-design.md` — UI の正典: トークン、画面スケルトン (§6 に C-1〜C-16 と P/L/K/H 系)、キーボードショートカット、空状態
7. `docs/MyMyTools Prototype.bundle.html` — 見た目の参考 (Claude Design 出力)。**技術判断のソースにはしない**

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
| 0011 | コアスキーマの **additive** な DDL マイグレーション (新カラム+DEFAULT / 新テーブル / 新インデックス / 新トリガ / VIEW) は枠組み内で許可。`db_schema_version` を bump し pre-migration バックアップを自動取得 |

## 絶対に破ってはいけない不変条件

D-03 (永劫互換) と各 ADR から導かれるもの。破ると静かにユーザーデータを壊すか、配布が破綻する。

- **コアスキーマの破壊的マイグレーションをしない**。`DROP` / `RENAME` / 型変更 / 既存値書き換えは禁止 (ADR-0006 のまま)。本当に必要なら新 ADR + `db_schema_version` 上昇 + C-12 起動停止画面の追加が前提
- **additive な DDL マイグレーション** (新カラム + DEFAULT / 新テーブル / 新インデックス / 新トリガ / VIEW) は **ADR-0011 の枠組みで許可**。`schema.rs::MIGRATIONS` にエントリを追加 + `db_schema_version` を bump + pre-migration バックアップが自動取得される。PR 説明で「additive か / バックアップ取得を確認したか」を必ず書く
- **モジュールデータ変更は引き続き payload バージョニング + Eager-on-Read** (ADR-0006) で吸収する。コアスキーマには触らない
- **フロントエンドから SQLite に直接アクセスしない**。`@tauri-apps/plugin-sql` も使わず、`tauri::command` のみを通す (module-contract §6.2)。フロントは `invoke(...)` で型付き結果を受ける
- **タイムスタンプは必ずアプリ側で生成**。`CURRENT_TIMESTAMP` 等の DB 生成は禁止。JST `+09:00`、ms 3 桁、固定 29 文字 (ADR-0005)。文字列のまま辞書順ソート可
- **Zustand 単一ストアを Day 1 から使う**。アプリ全体状態 (現在プロジェクト / 現在モジュール / テーマ / 設定) はここに集約。モジュール内のローカル状態は `useState` でよい。Context には逃さない (architecture.md §2.3)
- **自動更新なし、起動時の version-check 通信もしない** (ADR-0008)。「最新版を確認」は OS ブラウザで GitHub Releases を開くだけ (`plugin-shell`)
- **`data_revision` の意味**: アイテム内容を変える書込みでのみ増やす。Eager-on-Read による再構築や FTS 再構築では**増やさない** (ADR-0007 §2.2)
- **検索スコープの内部値は `"project" | "global"`** (data-model §11.1)。UI 表示文言は「Current project / All projects」だが内部値は別物

## モジュール / データ規約 (間違いやすい)

- `items` は全モジュール共通の単一テーブル (M-Prompt / M-LinkMemo / M-Color)。モジュール固有データは `payload` JSON カラムに入れ、`payload_schema_version` を整数で持つ。**M-Hash は何も書かない** — stateless (D-06)
- `items.title` は全モジュール共通の表示名。M-Color も独自の `name` フィールドは持たず `title` を使う
- M-LinkMemo は `target` 単一フィールド (`url` / `path` の分割なし)。type は `"url" | "path" | "memo"`。URL 欄に `file://...` を入れたら `path` に正規化する (`linkmemo_normalize_target` / module-contract §12.2)
- M-Prompt の `variables` は**永続化しない**。読込み時に `body` から正規表現で抽出する
- Phase 1 の `projects` テーブルは `id / name / description / position / created_at / updated_at` のみ。**`accent` カラムはない**。Phase 1 のアクセント色は blue 固定 (ui-design §10 U-10 に Phase 2 持ち越し記録)

## UI 規約

- **shadcn の既定値 > カスタマイズ** (ui-design §1.2)。CSS を書く前にまず `Button` を試す
- CSS トークン (`--bg`, `--fg`, `--accent`, `--border`, `--row-h` など) は ui-design §2 と §12.4 に定義済。色は `R G B` 数値で持ち、Tailwind の `rgb(var(--bg) / <alpha-value>)` で透過対応する。`--accent` のみ OKLCH なのでこの形ではない
- 行高は **default 32px (compact, Linear 寄り)**、`36px` は comfortable な選択肢。サイドバー幅は default 240px、可変レンジ 180–320px
- キーボード優先。ショートカットは ui-design §8 に網羅。複数箇所に `onKeyDown` を散らさず `react-hotkeys-hook` 等で一元管理する
- 編集フォーム (P-3 / L-3 / K-2) には**プロジェクト欄を出さない**。アイテムは現在サイドバーで選択中のプロジェクトに自動所属する

## 作業時のルール

- `docs/decisions/` の ADR は**追記専用**。受理済 ADR は書き換えず、覆すなら新 ADR で supersede する。軽微な誤字訂正は可、ただし決定そのものは原文を残す
- `docs/ui-design.md` には末尾に改訂履歴テーブルがある。非自明な変更を入れたら 1 行追加し、冒頭の v0.X プレリュードと同期させる
- `docs/MyMyTools Prototype.bundle.html` は 1.7MB の自己完結 HTML (Claude Design 出力)。オフライン参照のためにそのまま置いてある — 再生成・編集はしない
- `src-tauri/src/storage/schema.rs::MIGRATIONS` を変更する PR は、PR 説明に以下を必ず書く (ADR-0011 §2.1 チェックリスト):
  - additive (新カラム+定数 DEFAULT / 新テーブル / 新インデックス / 新トリガ / VIEW) のみで構成されているか
  - 同 PR 内に non-additive (DROP / RENAME / 型変更 / 既存値書き換え) が混ざっていないか — 混ざる場合は別 ADR + C-12 起動停止画面の追加が必須 (ADR-0011 §2.2)
  - 各 Migration エントリ末尾に `UPDATE meta SET value=? WHERE key='db_schema_version'` を含めているか (§2.3)
  - `data-model.md §14.4` のマイグレーション一覧表を更新したか
  - pre-migration バックアップ取得 (`pre-migration-v<N>` プレフィックス) が `schema::take_pre_migration_backup` で起動時に走ることを実装テストで確認したか
- git user は `zredjet`、PR の base は `main` (現在の作業ブランチは `master` なので push 前に確認すること)
