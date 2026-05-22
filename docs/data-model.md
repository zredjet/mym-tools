# データモデル (Data Model)

最終更新: 2026-04-25 / ステータス: Draft (Phase 1)

このドキュメントは「**データをどう持つか**」を定義する。
要件 (`requirements.md`) と構造 (`architecture.md`) で確定した方針を、
具体的なテーブル定義 / JSON スキーマ / 整合性ルールに落とし込む。

---

## 1. 目的とスコープ

確定済みの方針 (D-01 〜 D-13) を満たす具体スキーマを定義する。特に:

- **D-03**: 原則マイグレーション不要 — schema 変更は payload 側で吸収
- **D-11**: 各行に `payload_schema_version` を持たせ Lazy Migration on Read を実装
- **D-12**: items 書き込みと FTS5 を同一トランザクションに閉じる (SQLite トリガ)
- **E-04**: コア起因のマイグレーションを発生させない

「コアテーブル」は最小限・概念安定なものに絞り、それ以外はすべて payload に逃がす。

---

## 2. 物理ファイル配置

```
<userdata>/                                  # OS 標準のユーザーデータディレクトリ
├── data.sqlite                              # メイン DB (本書の対象)
├── data.sqlite-wal, data.sqlite-shm         # WAL モード時の付随ファイル
├── settings.json                            # アプリ全体・モジュール設定 (本書 §11)
├── logs/
├── exports/                                 # ユーザーが明示エクスポートしたファイル
└── backups/                                 # DB バックアップ (本書 §13)
    ├── auto/        # 日次自動 (最新10世代)
    ├── pre-op/      # 破壊的操作直前 (最新30世代)
    └── manual/      # 手動取得 (自動削除しない)
```

- DB は **WAL モード** (`PRAGMA journal_mode=WAL`) で動かす
  - 理由: 単一プロセス・単一ユーザーでも、フリーズ耐性とクラッシュ復旧性が上がる
- `PRAGMA foreign_keys = ON` を起動時に必ず発行する (カスケード削除のため)
- `PRAGMA synchronous = NORMAL` を採用 (WAL モード下では FULL より十分高速で安全)

> **重要**: WAL モード運用中、`data.sqlite` 単体には未チェックポイント分のデータが含まれない。
> ユーザーに「ファイルマネージャで `data.sqlite` をコピーするバックアップ」を推奨してはならない (整合性を欠いた状態のコピーになる可能性がある)。
> バックアップは必ず SQLite Online Backup API 経由 (本書 §13) を使う。

---

## 3. データベース全体構造

### 3.1 テーブル一覧

| 種別 | 名前 | 役割 |
|------|------|------|
| 通常 | `meta` | DB スキーマバージョン等の単一行情報 |
| 通常 | `projects` | プロジェクト |
| 通常 | `items` | 全モジュールが共有する項目テーブル (D-01) |
| 仮想 | `items_fts` | FTS5 全文検索インデックス |

### 3.2 ID 体系

- 全テーブルの主キーは **UUID v4 文字列 (TEXT)** とする
  - 採用理由: エクスポート/インポート時に他DBと衝突しない / SQLite の AUTOINCREMENT を使うとエクスポートしたファイルを別端末でインポートしたとき主キー再採番が必要になる
  - フロント (`crypto.randomUUID()`) と Rust (`uuid` クレート v4) の両方から生成可能
- 36 文字の文字列オーバーヘッドは個人ツール規模では無視できる

### 3.3 インポート時の ID 衝突戦略

UUID v4 の理論的衝突率は無視できるが、**実運用では同一 DB を別端末でインポートしてしまう**等のヒューマンエラーで衝突が起こり得る。これを明示的に扱う。

- **既定動作: 衝突した item / project は「スキップ + 警告」**
  - 既存データを上書きしない (ユーザーの直近編集を失わせない)
  - インポート完了画面で件数を集計表示: 「投入 N 件 / スキップ M 件 (重複)」
- **将来オプション (Phase 1 では未提供)**:
  - 衝突時に「新しい UUID を払い出して投入する (= 重複コピーを許可する)」モード
  - 衝突時に「既存を上書きする (= マージ運用)」モード
- **判定単位**:
  - `projects.id` が衝突: そのプロジェクト全体 (配下 items 含む) をスキップ
  - `items.id` が衝突 (プロジェクトは別): その item のみスキップ
- 部分成功方式は §12.3 で具体化する

---

## 4. `meta` テーブル

```sql
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 初期値
INSERT INTO meta (key, value) VALUES ('db_schema_version',     '1');
INSERT INTO meta (key, value) VALUES ('app_initialized_at',    '<JST_ISO8601>');
INSERT INTO meta (key, value) VALUES ('data_revision',         '0');
INSERT INTO meta (key, value) VALUES ('last_backup_revision',  '0');
INSERT INTO meta (key, value) VALUES ('last_auto_backup_at',   '');
```

| key | 意味 |
|-----|-----|
| `db_schema_version` | コア DB スキーマ自身のバージョン (payload_schema_version とは別) |
| `app_initialized_at` | DB 初回作成時刻 (JST_ISO8601) |
| `data_revision` | StorageService のコミットごとに +1 される単調増加カウンタ (§13.2)。SQLite INTEGER (signed 64-bit) で持ち、Rust 側も `i64` で扱う |
| `last_backup_revision` | **最後に成功した任意種別の DB バックアップ** (auto / pre-op / manual いずれでも) 時点の `data_revision` (§13.2) |
| `last_auto_backup_at` | 直近の **auto** バックアップ取得時刻 (JST_ISO8601、未取得時は空文字)。auto 専用の 24 時間ゲート判定にのみ使う。pre-op / manual では更新しない |

- 起動時にアプリは `db_schema_version` を読み、想定値より新しければ起動を停止しエラー画面を表示 (architecture.md §9)
- 古ければ DB 内蔵のマイグレーションシーケンスを順次適用 (D-03 例外運用、後述 §14)

---

## 5. `projects` テーブル

```sql
CREATE TABLE projects (
  id          TEXT PRIMARY KEY,                              -- UUID v4
  name        TEXT NOT NULL,
  description TEXT,
  position    INTEGER NOT NULL DEFAULT 0,                    -- ユーザー並び替え用
  created_at  TEXT NOT NULL,                                 -- JST ISO8601 (D-14)
  updated_at  TEXT NOT NULL                                  -- JST ISO8601 (D-14)
);

CREATE INDEX idx_projects_position ON projects (position);
```

- `name` のユニーク制約は**かけない**(同名プロジェクトを許容。表記が同じでも別物として扱いたいケースを優先)
- 削除は物理削除 (architecture.md §7.1)。配下の items は FK のカスケードで一緒に消える (§9)

---

## 6. `items` テーブル

### 6.1 DDL

```sql
CREATE TABLE items (
  id                     TEXT PRIMARY KEY,                              -- UUID v4
  project_id             TEXT NOT NULL,
  module_id              TEXT NOT NULL,                                 -- "prompt" | "linkmemo" | "color" 等
  title                  TEXT NOT NULL,
  tags                   TEXT NOT NULL DEFAULT '[]'
                                CHECK (json_valid(tags)),               -- JSON 配列 ["foo","bar"]
  search_text            TEXT NOT NULL DEFAULT '',                      -- モジュールが index_text() で生成
  payload_schema_version INTEGER NOT NULL DEFAULT 1,                    -- D-11
  payload                TEXT NOT NULL DEFAULT '{}'
                                CHECK (json_valid(payload)),            -- モジュール固有 JSON
  position               INTEGER NOT NULL DEFAULT 0,                    -- ユーザー手動 D&D 並び (§6.5)
  created_at             TEXT NOT NULL,                                 -- JST ISO8601 (D-14)
  updated_at             TEXT NOT NULL,                                 -- JST ISO8601 (D-14)

  FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
);

-- 検索・フィルタ用
CREATE INDEX idx_items_project                    ON items (project_id);
CREATE INDEX idx_items_module                     ON items (module_id);

-- 一覧表示用 (UI からの「プロジェクト×モジュール×新着順」アクセスに直接効く)
-- 末尾の id DESC は ADR-0005 §2.4 の安定ソート規約 (ORDER BY <ts> DESC, id DESC) を
-- インデックスだけで解決できるようにするためのタイブレーカー
CREATE INDEX idx_items_project_updated            ON items (project_id, updated_at DESC, id DESC);
CREATE INDEX idx_items_project_module_updated     ON items (project_id, module_id, updated_at DESC, id DESC);
CREATE INDEX idx_items_module_updated             ON items (module_id, updated_at DESC, id DESC);

-- D&D 並び表示用 (§6.5、PR-Y / ADR-0011 で導入)
-- (project_id, module_id) スコープ内で position ASC を効かせる
CREATE INDEX idx_items_project_module_position    ON items (project_id, module_id, position, updated_at DESC, id DESC);
```

> `position` カラムは **ADR-0011 (additive マイグレーション)** に基づき DB schema v2 で追加された。新規 DB は本 DDL でそのまま立ち上がり、既存 DB は起動時に `ALTER TABLE items ADD COLUMN position INTEGER NOT NULL DEFAULT 0` が冪等に適用される。詳細は §14 を参照。

`json_valid()` の CHECK は SQLite が標準で提供する関数で、パースに失敗する文字列を弾く。
モジュールバグや手動編集による壊れた JSON が混入することを最低限防ぐ防御層として置く。
スキーマレベルの構造制約 (フィールド有無等) はかけず、それは `validate_payload()` で行う (§6.3)。

### 6.2 カラム責務

| カラム | 誰が意味を持つか | コアの扱い |
|-------|--------------|---------|
| `id` / `project_id` / `module_id` | コア | リレーションとフィルタ |
| `title` / `tags` | コア | UI 共通表示 / 共通検索 |
| `search_text` | モジュールが生成 | コアは中身を解釈せず、FTS5 に渡すのみ |
| `payload` | モジュール | コアからは不透明な JSON 文字列 |
| `payload_schema_version` | モジュール | コアは値を読み書きするのみ、解釈はモジュール |
| `position` | コア | ユーザーの手動並び替え (D&D) 結果。`(project_id, module_id)` スコープ内で連番 (§6.5) |
| `created_at` / `updated_at` | コア | 自動更新 |

### 6.3 制約上の注意

- `tags` は SQLite の JSON 関数 (`json_each`) で展開可能。専用テーブルにせず JSON で持つのは「個人ツール規模ではタグ単独検索の高速化要件が無い」ため
- `search_text` の生成はモジュールの責務。コアは StorageService の書き込み API で `index_text(payload)` をコールバック経由で呼ぶ (詳細は `module-contract.md`)
- `payload` の JSON 文字列に対する SQL レベルの構造制約は**かけない**(`json_valid` のみ)。バリデーションはモジュールの `validate_payload()` で行う

### 6.4 時刻フォーマットと自動更新 (D-14)

#### フォーマット

- 全ての時刻は **JST (Asia/Tokyo, +09:00) を ISO8601 拡張形式** で記録する。ADR-0005 で **`JST_ISO8601`** 用語として確定
- フォーマット: `YYYY-MM-DDTHH:MM:SS.sss+09:00` (29 文字固定幅、ミリ秒 3 桁、タイムゾーンオフセット明示)
- 例: `2026-04-26T15:30:45.123+09:00`
- オフセットを省略しない (`Z` も `+0900` 連結形式も使わない) — 文字列比較でのソートを保つため、桁数を一定にする
- SQLite の TEXT カラムにそのまま格納。SQLite の datetime 関数はオフセット付き ISO8601 をパース可能 (検索やソートに利用可能)
- **ファイル名で使う場合**は `:` を `-` に置換した **`JST_FILENAME_TIMESTAMP`** 形式 (`2026-04-26T15-30-45.123+09-00`) を使う (ADR-0005 §2.1)
- **安定ソートが必要な一覧クエリ**は `ORDER BY <ts_col> DESC, id DESC` のように **`id` をタイブレーカーに付ける**規約とする (ADR-0005 §2.4)。ミリ秒衝突時の表示順揺れを防止

なぜ JST 固定なのか:
- 個人ツールであり、ユーザーは日本タイムゾーン固定を前提に使う (要件 D-14)
- 他端末への移植時 (export → import) もタイムゾーン情報を持って渡るため、解釈が変わらない
- UTC 保存 + 表示時 JST 変換は将来海外利用が出てきた時に検討可

#### 自動更新の責務

- **アプリケーション側で生成して書き込む** — トリガで自動付与しない
  - 理由: SQLite の `CURRENT_TIMESTAMP` は UTC で生成されるため、JST 固定方針と整合させるには値を変換する必要があり、アプリ側で生成するほうが制御がシンプル
- Rust 側: `chrono::FixedOffset::east_opt(9 * 3600)` でオフセットを取り、`format("%Y-%m-%dT%H:%M:%S%.3f%:z")` で生成
- StorageService は INSERT/UPDATE 直前に `created_at` (新規時のみ) / `updated_at` (常に) を上書き設定する
- フロント側で時刻を生成してコマンドに渡すことは禁止 (端末時計のずれを Rust 側で吸収できなくなるため)

### 6.5 `position` カラム — D&D 並び替え (PR-Y / ADR-0011)

ユーザーがリストを D&D で並び替えた順序を永続化する。Sidebar の `projects.position` と同じ思想を items に適用したもの。

#### スコープと連番ルール

- **スコープは `(project_id, module_id)` のペア**。同じ project でも prompt / linkmemo / color は独立した並びを持つ
- 同スコープ内で **`0..N-1` の密な整数**(欠番なし)。reorder API が常に全件再付番する形で運用する
- スコープを跨いだ意味は無い (project A の prompt[3] と project B の prompt[3] は無関係)

#### 既定値と「未編集状態」の扱い

「未編集スコープ」とは **全行 `position = 0`** のスコープを指す。reorder API は必ず **`0..N-1` の連番** を書くため、全行 0 という状態は「**一度も reorder されていない**」と一意に判別できる (これがフォールバックの根拠)。

- **未編集スコープへの新規追加**: `position = 0` のまま append (全行 0 を維持)。これにより `ORDER BY position ASC, updated_at DESC, id DESC` のタイブレーカーで **新規が先頭 (updated_at 最新)** に来る。Sidebar projects と挙動を揃える
- **reorder 済スコープへの新規追加**: `position = MAX(position) + 1` で末尾追加
- **判定の SQL**: 新規 INSERT 時、同 tx 内で `SELECT COUNT(*) = SUM(CASE WHEN position = 0 THEN 1 ELSE 0 END) FROM items WHERE project_id=? AND module_id=?` 相当 (全行 0 かどうか) を見て、上記 2 分岐を選ぶ
- **削除時**: position の再詰めは **しない** (穴あきを許容)。次回 reorder API で 0..N-1 に正規化される。この方針なら delete 時に同スコープを scan しなくて済む
- **DB schema v2 マイグレーション直後**: 既存全行が `position = 0` で並ぶ → 全スコープが「未編集」状態 → `ORDER BY position ASC, updated_at DESC, id DESC` のタイブレーカーで updated_at DESC が効く (= マイグレーション前と同じ表示順)
- **表示クエリは常に同じ ORDER BY** (`position ASC, updated_at DESC, id DESC`)。「未編集なら updated_at」「編集済なら position」のような分岐はしない (`idx_items_project_module_position` 一本でカバーする)

#### 書き込み API

新規 Tauri command を 1 本追加する (`module-contract.md` §6.2 の `core_*` 規約):

```
core_reorder_items(project_id, module_id, ordered_ids: string[])
```

- `ordered_ids` には **`(project_id, module_id)` スコープ内の全 item ID が過不足なく** 含まれていなければならない (`projects.reorder` と同じ厳格性、§5)
- **実装規約 (スコープ二重ガード)**: 1 トランザクション内で
  1. `SELECT id FROM items WHERE project_id=? AND module_id=?` で取得した集合と `ordered_ids` の集合を比較し、**完全一致** を検証 (欠損 / 余分 / 未知 ID は `AppError::Validation` で reject)
  2. UPDATE 句は `UPDATE items SET position = ? WHERE id = ? AND project_id = ? AND module_id = ?` の **三条件 WHERE** で他スコープへの誤書き込みを物理的に防止
- 1 トランザクション内で全 UPDATE → `data_revision +1`
- `updated_at` は **触らない** (並び替えはユーザー編集だが「内容」を変えないため、`updated_at` の意味論 = "本文最終更新" を守る)
- **`data_revision +1` の根拠**: ADR-0006 §2.2 / CLAUDE.md は「アイテム内容を変える書込みでのみ +1」と書いているが、reorder は **ユーザー意図の永続化** であり、バックアップ判定の対象に含めるべき。Eager-on-Read の自動再構築 / FTS 再構築 (これらは +1 しない) とは別カテゴリとして整理する

#### 検索結果での扱い

横断検索 (`core_search`、§8) は FTS5 / LIKE のスコア順 / 検索順序を優先するため、`position` は **検索結果には反映しない**。`position` は「リスト画面でのユーザー意図順」専用のフィールド。

却下根拠 (将来「検索結果も position 順で」要望が出た時の判断材料):

- (a) スコープを跨ぐ検索結果に position の連番意味が無い (`(project_id, module_id)` ペアごとに 0 から振られているため、グローバル並びにすると衝突だらけになる)
- (b) FTS5 ランキング情報を捨てるとヒット品質が悪化する
- (c) ユーザーが意図する「並び順」と「関連度」は別の軸 (UI 設計 §10 U-11 で Phase 2 再評価予定)

#### export / import (§12) での扱い

- **export**: `position` を JSON にそのまま書き出す
- **import**: 衝突しない item の投入時は `position` をそのまま保存。`apply_import` 完了後に **追補処理として** `(project_id, module_id)` 各スコープに対し **ROW_NUMBER による再付番** を 1 回かける (`data-model.md` §12.4 step 9 / `core_reorder_items` の内部発火相当):

  ```sql
  UPDATE items SET position = sub.new_pos
    FROM (
      SELECT id,
             ROW_NUMBER() OVER (
               PARTITION BY project_id, module_id
               ORDER BY position, created_at, id
             ) - 1 AS new_pos
      FROM items
      WHERE project_id = :pid AND module_id = :mid
    ) AS sub
    WHERE items.id = sub.id;
  ```

  これにより、JSON 内の元順序 (= position 昇順、同点は created_at 昇順、最終的に id) を保ったまま 0..N-1 の連番に詰める。インポート JSON が古くて全行 position=0 の場合は created_at 順になる。完璧な順序保全 (例: 元 DB の reorder 履歴) は Phase 1 では追跡しない (UI 設計 §10 U-11 で Phase 2 再評価)

---

## 7. payload バージョニング (D-11 の運用 — Eager-on-Read 方式)

### 7.0 方針の変更点と理由

当初は「読み込み時にメモリ上で変換、DB は書き換えない」純粋な Lazy Migration を想定していたが、
これでは**古い行の `search_text` が古いまま残り、検索結果が一貫しない**問題があった。
そこで **Eager-on-Read 変種** に変更する:

- 読み込み時に古い payload を検出したら、payload と search_text を**現行版に再生成して `items` を UPDATE**
- FTS5 はトリガで自動同期される (D-12)
- 起動時の一括マイグレーションは行わない (D-03 の精神は維持)
- マイグレーション負荷は読み込み発生のたびに分散し、N 行のモジュールでは最大 N 回の単一行 UPDATE で収束

### 7.1 書き込み時

```
[書き込み時の流れ]
1. モジュールはアプリ内オブジェクトを「現行スキーマ」の payload にシリアライズ
2. StorageService に { ..., payload_schema_version: <現行版>, payload: <JSON> } を渡す
3. StorageService が search_text = index_text(payload) を計算
4. items に INSERT / UPDATE される (FTS5 トリガが連動)
```

### 7.2 読み込み時 (Eager-on-Read)

```
[読み込み時の流れ]
1. StorageService が items から行を取得 (payload_schema_version, payload を含む)
2. version が現行と同じ → そのままアプリ内オブジェクトに変換して返す (DB 書き換えなし)
3. version が古い:
   3.1. モジュールがアップグレード関数を順次適用 (v → v+1 → ... → 現行版)
   3.2. StorageService が新しい payload で search_text を再生成
   3.3. items を {payload, search_text, payload_schema_version} で UPDATE
        - 楽観的並行制御: WHERE 句に元の payload_schema_version を含める (下記)
        - FTS5 トリガが連動して items_fts も更新
        - 単一トランザクション
        - updated_at は触らない (モジュール内バージョン更新はユーザー編集ではないため)
   3.4. アップグレード後オブジェクトを返す
```

#### 楽観的並行制御 (UPDATE WHERE 句)

writer mutex は同時書き込みを直列化するが、「Command A / B が同じ行を v1 で読んだ後にそれぞれ書き戻そうとする」競合は防げない。
そのため Eager-on-Read の UPDATE は次の形にする:

```sql
UPDATE items
SET payload = ?,
    search_text = ?,
    payload_schema_version = ?  -- 新版
WHERE id = ?
  AND payload_schema_version = ?  -- 元バージョン (読み込み時の値)
```

- `rows_affected == 0` の場合は他の処理が先にアップグレード済み → **行を再読み込み**して、必要なら再度アップグレード経路に入る (既に最新版ならそのまま返す)
- writer mutex 内で再 UPDATE するため再読み込み後の再衝突は起きない

#### 二系統の内部更新 API (実装規律)

「ユーザー編集」と「Eager-on-Read 自動更新」を実装レベルで分離する (詳細は ADR-0006 §2.2):

| 内部 API | 更新カラム | data_revision |
|--------|---------|--------------|
| 通常更新 (`update_item`) | `payload` / `search_text` / `updated_at` | **+1** |
| Eager-on-Read 内部更新 (`upgrade_item_inplace`) | `payload` / `search_text` / `payload_schema_version` のみ | **+0** |

Eager-on-Read 内部更新 API はクレート内可視性 (`pub(crate)`) に閉じ、モジュールや Tauri コマンドからは触れない。

**読み込みが書き込みを引き起こす点について**:
- 通常の SELECT でこの動作が起きるとロック取得順や読み取り専用想定が崩れるため、
  アップグレードが発生し得るのは StorageService の「読んでアプリへ返す」高レベル API のみとする
- 集計や検索のような low-level 経路は payload を解凍せずに走らせ、アップグレードを発火させない

### 7.3 検索インデックスとの整合性

Eager-on-Read により、**読まれた行は必ず最新の search_text を持つ**。
ただし**読まれていない古い行は古い search_text のまま残る** ため、その行は最新の検索条件に部分的にしかヒットしない可能性がある。

**緩和策 — 管理コマンド「検索インデックス再構築」**:
- ユーザーが設定画面から起動できる Rust 側コマンド `core:rebuild_search_index(module_id?)` を提供
- 指定モジュール (省略時は全モジュール) の全行を読み出して Eager-on-Read を強制発火 → 全行最新化
- ペイロードバージョンを上げたモジュールアップデート直後にユーザーに案内する選択肢として持つ
- バックグラウンドで黙って走らせない (data_revision を一気に増やしバックアップ判定を狂わせるため、ユーザー判断にする)

### 7.4 モジュール側の宣言形 (概念)

```rust
// 概念コード: 詳細は module-contract.md
struct PromptModule;

impl ModuleBackend for PromptModule {
    fn id(&self) -> &'static str { "prompt" }
    fn current_payload_version(&self) -> u32 { 1 }

    fn upgrade_payload(&self, from_version: u32, payload: serde_json::Value) -> serde_json::Value {
        match from_version {
            // v1 -> v2 のときに増える
            _ => payload,
        }
    }
    // ...
}
```

### 7.5 運用ルール

- **payload 内の構造を変更したら必ず version を上げる**(プロパティ追加だけでも)
- 削除されたプロパティはアップグレード関数で「無視する / デフォルト値を入れる」を明示
- バージョンは**単調増加の整数**。スキップしない
- アップグレード関数は冪等であること (同じ入力に何度走らせても同じ結果)
- payload 構造を変えたが `index_text()` の出力が一切変わらない場合でも、version は上げる (運用シンプルさ優先)

### 7.6 Eager-on-Read 失敗時の扱い

アップグレード経路で発生し得る失敗パターンと、それぞれの扱いを以下に定める。
**いずれの失敗ケースでも、items 行や payload を勝手に書き換えない / 削除しない**(ユーザーデータの欠損方向の自動修復は行わない)。

| 失敗ケース | 原因例 | 扱い |
|---------|-------|-----|
| `payload_schema_version` が現行版より**新しい** | 新版アプリで作ったデータを旧版アプリで開いた | 起動時の `db_schema_version` 同様、**起動を停止しエラー画面**を出す (黙って動作させない) |
| `payload_schema_version` が現行版より古いが**未知の値**(連続性が無い) | バージョン番号スキップ等の運用ミス | `AppError::PayloadUpgradeFailed { reason: "unknown version" }` を返す |
| アップグレード関数が例外を投げる | 旧データに想定外の形 / panic | `AppError::PayloadUpgradeFailed { reason: "upgrade error", source: ... }` を返す |
| アップグレード後の `validate_payload()` が失敗 | アップグレード関数のバグでスキーマ違反を生成 | `AppError::PayloadUpgradeFailed { reason: "validation failed" }` を返す |
| items の UPDATE が失敗 | DB ロック / ディスク満杯等 | `AppError::Storage` を返す。アップグレード後オブジェクトはメモリ上にあるのでアプリは**結果は返す**が「永続化未完了」フラグを立てて UI に通知 |
| FTS5 トリガが失敗 | トリガ定義の不整合等 | `AppError::Storage` (UPDATE 全体がロールバックされる) |

**呼び出し元の振る舞い**:
- **詳細取得 API** (1件読み込み): エラーをそのまま返す。UI 側でエラーカード表示 (「この項目はアップグレードに失敗しました。詳細はログを参照」)
- **一覧取得 API** (複数件): 失敗 item は**スキップせず**、共通カラム (`title` / `tags` / `updated_at` 等) は表示し、本文・詳細領域には「破損項目」マーカーを出す。少なくともログに残す
- **検索経路**: §7.3 の通り Eager-on-Read を発火しないため、検索ヒット自体は古い search_text に基づいて発生し得る。クリックして詳細を開いたタイミングで上記のエラー扱いに進む
- **エクスポート経路**: 失敗 item は**そのままの (古い) payload と payload_schema_version で書き出す**。アップグレード前提の処理を export 時にも行うと「アプリで開けなかった item を export で消す」事故が起きるため

**ユーザー向けリカバリ**:
- アプリは「破損項目」を一覧化する管理画面を持つ (Phase 1 では設定 → メンテナンスから手動起動)
- 各破損項目に対して「個別に payload を表示してコピー (退避)」「項目を削除 (確認モーダル付き)」のアクションを提供
- バックアップから復元する選択肢も同画面から案内

---

## 8. FTS5 仮想テーブルとトリガ (D-12)

### 8.1 仮想テーブル DDL

```sql
CREATE VIRTUAL TABLE items_fts USING fts5(
  item_id UNINDEXED,
  project_id UNINDEXED,
  module_id UNINDEXED,
  search_text,
  tokenize = 'trigram'
);
```

**MATCH 対象カラムの絞り込み**:
- 当初検討した `title` / `tags` の独立カラム化は廃し、**MATCH 対象は `search_text` 1本のみ**にする
- `title` と `tags` の文字列はモジュールの `index_text()` 内で `search_text` に連結して入れる責務にする
- 理由: trigram トークナイザはカラム数だけインデックスが線形に増える。本ツールではカラムごとの重み付け検索は要求されておらず、複数カラムを持たせる利得がない (個人ツール規模では search_text 1本で十分)

**トークナイザ選定**:
- `trigram` を採用 — 日本語を含む任意の言語で動作する。形態素解析を持たない SQLite で日本語全文検索を実用化する標準的な選択
- インデックスサイズは大きめになるが、個人ツール規模では問題にならない
- 必要 SQLite バージョン: 3.34+ (rusqlite + bundled feature で同梱)

**サイズ肥大化が顕在化した場合の逃げ道** (将来):
- **External content モード** — `items_fts` に search_text 本体を持たせず `items.search_text` を参照させる。インデックス分しか持たないので容量を半減できる。トリガ定義が複雑になるため Phase 1 では導入しない
- **トークナイザ変更** — trigram から unicode61 への切り戻し。日本語の検索品質と引き換えに容量を 1/3〜1/4 にできる
- いずれも DB スキーマ変更を伴うため D-03 の例外運用 (§14) で扱う

#### 制限事項: 3 文字未満の検索語は MATCH にヒットしない

trigram tokenizer は文字 3-gram でインデックスを作るため、SQLite 公式ドキュメントの通り **`MATCH` クエリで検索語が 3 文字未満のときヒットを返さない**。
「PR」「色」「@a」のような短い語の検索が想定される場合は、以下のフォールバック戦略を取る:

- **検索語の長さで経路を切り替える** (StorageService 内部の検索 API で実装):
  - 検索語 ≧ 3 文字 → 通常通り `items_fts MATCH ?` で検索
  - 検索語 < 3 文字 → `items` テーブル直接の `LIKE '%query%'` フォールバック (対象カラム: `title` / `tags` / `search_text`)
- LIKE は B-tree インデックスを使えないためテーブル全スキャンになるが、検索語が短いケースは頻度・件数ともに限定的と想定 (個人ツール規模で実害は出にくい)
- フォールバック発火の有無は UI に出さない (検索体験の一貫性を優先)
- Phase 1 ではまず計測なしで素朴に LIKE フォールバックを実装し、性能課題が出た場合のみ別案 (例: 1〜2 文字インデックス専用テーブルの構築) を検討する

### 8.2 同期トリガ

`items` への書き込みは必ず `items_fts` に伝搬する。アプリケーションコードは **`items_fts` を直接触らない**。

```sql
CREATE TRIGGER trg_items_fts_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts (item_id, project_id, module_id, search_text)
  VALUES (new.id, new.project_id, new.module_id, new.search_text);
END;

CREATE TRIGGER trg_items_fts_au AFTER UPDATE ON items BEGIN
  UPDATE items_fts SET
    project_id  = new.project_id,
    module_id   = new.module_id,
    search_text = new.search_text
  WHERE item_id = new.id;
END;

CREATE TRIGGER trg_items_fts_ad AFTER DELETE ON items BEGIN
  DELETE FROM items_fts WHERE item_id = old.id;
END;
```

トリガは元の INSERT/UPDATE/DELETE と同一トランザクション内で実行されるため、
`items` 側がロールバックされれば `items_fts` 側もロールバックされる (D-12 の整合性保証)。

### 8.3 検索クエリ (パターン例)

```sql
-- プロジェクト内検索
SELECT i.*
FROM items_fts f
JOIN items i ON i.id = f.item_id
WHERE f.project_id = ?
  AND items_fts MATCH ?
ORDER BY rank;

-- 横断検索 + モジュールフィルタ
SELECT i.*
FROM items_fts f
JOIN items i ON i.id = f.item_id
WHERE f.module_id IN ('prompt', 'linkmemo')
  AND items_fts MATCH ?
ORDER BY rank;
```

**`project_id` / `module_id` を UNINDEXED で `items_fts` に冗長持ちしている理由**:
- これらは検索結果の本体取得に `items` への JOIN が必要なので、JOIN を回避できるわけではない
- 期待される効果は「**SQLite が `WHERE f.project_id = ?` を先に評価できる実行計画を選んだ場合に、FTS5 が MATCH 評価対象を絞り込める可能性がある**」というもの。実際にどう実行されるかは SQLite のクエリプランナ次第なので、本書としては効果を保証しない
- 検証が必要な場合は `EXPLAIN QUERY PLAN` で実行計画を確認する
- `items_fts` は通常テーブルではないため、UNINDEXED カラムの `=` 比較は B-tree インデックスのような探索ではなく、FTS5 内部の行スキャンに対するフィルタとして働く点に注意
- 個人ツール規模 (数万件オーダー) ではこの最適化があってもなくても体感差はほぼ出ないが、設計意図として記録しておく

---

## 9. プロジェクト削除のカスケード (Q-14)

### 9.1 ルール

- `items.project_id` に **`ON DELETE CASCADE`** を付与済み (§6.1)
- 起動時に **`PRAGMA foreign_keys = ON`** を発行 (SQLite はデフォルト OFF のため必須)
- アプリは `DELETE FROM projects WHERE id = ?` を1文発行するだけで、
  - 配下の items が物理削除される
  - items の DELETE トリガ (`trg_items_fts_ad`) が走り、`items_fts` からも消える
- すべて単一トランザクション内で完結

### 9.2 確認モーダル (タイプ・トゥ・コンファーム)

DB 側で削除を防がない代わりに、**UI 側で必ず削除確認モーダルを出す**。
クラウドサービスで一般的な「リソース名を手入力させる」方式を採用する。

仕様:
- モーダルに「以下に **`<プロジェクト名>`** を入力すると削除されます」と表示
- ユーザーがプロジェクト名を完全一致で入力するまで削除ボタンは無効化
- 配下 items 数も事前カウントして表示 (例: 「このプロジェクトには 142 件の項目があります」)
- 削除ボタンのラベルは `削除` ではなく `<プロジェクト名> を完全に削除` のように具体名を含める

この仕様は破壊的操作 (project 削除 / restore 実行 / import の上書きモード等) で**共通コンポーネント化**して使う。

### 9.3 削除前バックアップ (§13 と連動)

project 削除実行時、StorageService は**削除トランザクションの前に pre-op バックアップ**を取る (§13.4)。
復旧手段が手動エクスポートではなく、バックアップ復元によって即座に取れるようになる。

### 9.4 取消 (Undo) は持たない

- ローカル個人ツールであり、Undo スタックの実装コストに見合う価値が薄い
- ユーザーが誤削除した場合、**§13 のバックアップ復元** または **手動エクスポートからの復旧** を案内する
- C-06 のエクスポート機能と §13 のバックアップ機能が事実上のセーフティネットを構成する

---

## 10. モジュール別 payload 仕様 (Phase 1)

すべての payload は `payload_schema_version = 1` から開始。

### 10.1 M-Prompt

```jsonc
// items.payload (version 1)
{
  "body": "Translate the following to {{language}}: {{text}}"
}
```

- `title` (共通カラム): プロンプトのタイトル
- `tags` (共通カラム): タグ
- `body`: プロンプト本文 (Markdown)
- 変数プレースホルダ (`{{name}}`) は**保存しない**。読み込み時に正規表現で抽出してフォーム生成
  - 理由: 変数は body から導出可能。冗長持ちするとずれる
- 変数名の許容文字 (PR-AD で日本語対応):
  - **Unicode letter / number + `_`** を許容 (1 文字以上)
  - Rust `char::is_alphanumeric()` / TS `[\p{L}\p{N}_]` (`u` flag) で実装。Latin / CJK の範囲では完全一致
  - ✅ `{{topic}}` / `{{lang_1}}` (ASCII) / `{{言語}}` / `{{トピック}}` / `{{ぷろんぷと}}` (CJK)
  - ❌ 空白 (`{{ topic }}`) / ハイフン (`{{a-b}}`) / 記号 (`{{a.b}}`) は **silently 無視** (構文エラーは出さない)
  - 半角 / 全角は別変数として区別 (例: `topic1` ≠ `topic１`)
  - **未解決の発展余地** (U-13): Mustache / Handlebars / Jinja 慣例の `{{ name }}` 前後空白許容は Phase 2 候補

**search_text 生成**: `title + " " + body`

### 10.2 M-LinkMemo (Q-08 の決着)

> **採用案**: 単一テーブル + `type` フラグ (architecture.md §4.4 の方針と整合)

```jsonc
// items.payload (version 1)
{
  "type": "url" | "path" | "memo",
  "target": "https://example.com" | "/Users/x/folder" | "\\\\nas\\share\\dir" | null,
  "body": "任意のメモ本文"
}
```

| `type` | `target` | `body` | 「開く」アクション |
|--------|----------|--------|------------------|
| `url`  | URL 文字列 (必須) — `http` / `https` のみ | 任意 | 既定ブラウザで `target` を開く |
| `path` | OS パス (必須) — ローカル / UNC 形式 / `file://` 由来のパス | 任意 | OS 既定ファイラーで `target` を開く |
| `memo` | `null` | 必須 | アプリ内で `body` を表示 |

**ローカルとネットワークパスを `type` で分けない理由**:
- 「開く」の挙動は同じ (OS の Explorer / Finder が透過的にローカル/UNC を解釈する)
- フィルタ用途で区別したくなったら、UI で `target.startsWith("\\\\") || target.startsWith("smb://")` で分類すれば足る
- スキーマレベルで分けると、ユーザーが「ローカルだと思っていたら NAS だった」のような移動時に再分類が必要になる

**`file://` の扱い** (Q-08 関連の決定):
- `file://` 形式で入力された URL は **`type = path` に正規化して保存** する
- 正規化処理 (`validate_payload()` の前段で実行):
  - `file:///Users/x/folder` → `/Users/x/folder` (macOS / Linux)
  - `file:///C:/Users/x/folder` → `C:\Users\x\folder` (Windows)
  - `file://server/share/dir` → `\\server\share\dir` (UNC)
- 理由: `file://` は意味的にファイルシステムを指すので、`type=url` (=ブラウザで開く) で扱うと矛盾する。OS ファイラーで開くべきもの = `type=path` に寄せる

**バリデーション**:
- `type=url` のとき: `target` は `http://` または `https://` で始まる (`file://` 入力は path に正規化されているのでここに来ない)
- `type=path` のとき: `target` は空文字でない
- `type=memo` のとき: `body` は空文字でない (空メモは項目化させない)

**search_text 生成**: `title + " " + (target ?? "") + " " + body`

### 10.3 M-Color

```jsonc
// items.payload (version 1)
{
  "hex": "#FF5733"
}
```

- `title`: 色の名前 (例: "アクセント1", "primary", "ロゴ赤")
- `hex`: `#RRGGBB` または `#RRGGBBAA` の正規化済み (大文字)
- RGB / HSL は表示時に変換 (保存は HEX に正規化)

**search_text 生成**: `title + " " + hex`

色名 (例: "red") で検索したい場合は、ユーザーが `title` に色名を入れる前提とする。
`hex` から自動で色名を引く辞書 (例: CSS Named Colors) は持たない (Phase 1 では YAGNI / 言語依存の温床になりやすい)。

### 10.4 M-Hash (D-06)

`items` テーブルには**何も保存しない**。
モジュールは `is_stateless = true` を宣言する (詳細は `module-contract.md`)。

---

## 11. 設定 JSON (`settings.json`, Q-13)

### 11.1 ファイルレイアウト

```jsonc
{
  "schema_version": 1,
  "core": {
    "theme": "system" | "light" | "dark",
    "default_project_id": "<uuid>" | null,
    "last_opened_project_id": "<uuid>" | null,
    "last_opened_module_id": "prompt" | "linkmemo" | "color" | "hash" | null,
    "search": {
      "default_scope": "project" | "global"
    },
    "log_level": "info" | "debug" | "warn" | "error"
  },
  "modules": {
    "prompt": {
      "last_seen_payload_version": 1
    },
    "linkmemo": {
      "favicon_fetch_enabled": false,
      "last_seen_payload_version": 1
    },
    "color": {
      "last_seen_payload_version": 1
    },
    "hash": {}
  }
}
```

### 11.2 名前空間ルール

- ルート直下: `schema_version` / `core` / `modules` の3つだけ
- `core.*`: コアの設定。コアが意味を理解する
- `modules.<id>.*`: 各モジュールの設定。**コアは中身を解釈しない**
- モジュール ID をキーにすることで、モジュール削除時の設定残骸も `modules` ブロックを覗けば分かる

#### 例外: `modules.<id>.last_seen_payload_version` (コアが解釈する規約フィールド)

`modules.<id>.last_seen_payload_version` は **コアが意味を理解する規約フィールド** (整数)。
ステートフルなモジュール (`is_stateless = false`) では、payload version 上昇時の検索インデックス再構築通知 UX (ADR-0006 §2.4) に使う:

- アプリ起動時 / 該当モジュール画面初回表示時に `module.current_payload_version()` と比較
- 不一致 (上昇) を検出したら、再構築を推奨する通知を出す
- ユーザーが実行 / 却下したら値を `current_payload_version()` に更新して通知を消す

「`modules.<id>` の中身はコアが解釈しない」原則の例外として明示する。Phase 1 ではこのキーのみが例外。

### 11.3 永続化方針

- 起動時に1回読み、メモリ上で保持 (Zustand の core ストアに同期)
- 変更時は **debounce 500ms 付きでファイルに書き戻し**(キーストロークごとに書かない)
- 書き込みは `<settings>.tmp` → `rename` の atomic 置換で行う(電源断時の破損対策)

### 11.4 マイグレーション

- ルートの `schema_version` を見て、起動時にコンバータを通す
- 旧版の不要キーは無視 (前方互換)
- 認識できないキーは保持して書き戻す (ユーザー手編集の意図を壊さない)

### 11.5 参照先が消えた場合の扱い

`core.default_project_id` / `core.last_opened_project_id` のように、DB 内の他レコードを参照する設定値は、参照先が削除されているケースを考慮する。

- 起動時の設定読み込み後、StorageService に対して各参照先の存在確認を行う
  - `default_project_id` / `last_opened_project_id` → projects テーブルに該当 ID があるか
  - `last_opened_module_id` → モジュールレジストリに登録されているか (有効な ID か)
- **参照先が無効なキーは `null` に置き換えてメモリ上保持** (ユーザーの設定変更操作と同様に debounce 経由でファイルに書き戻される)
- アプリは起動時の振る舞いを fallback で決める:
  - `last_opened_project_id` が無効 → 最初のプロジェクト (`projects.position` 順) を開く / プロジェクト 0 件なら新規作成画面を出す
  - `default_project_id` が無効 → 「既定プロジェクトなし」状態として扱う
- 無効化されたことをユーザーに通知する (例: トースト「以前開いていたプロジェクトが見つからなかったので最初のプロジェクトを開きました」)

---

## 12. エクスポート / インポート JSON (D-05 / D-07)

### 12.1 ファイル形式

単一 JSON ファイル。拡張子は `.mymtools.json` を推奨 (識別性のため)。

```jsonc
{
  "schema_version": 1,                            // この JSON 自身のバージョン
  "exported_at": "2026-04-25T12:00:00.000+09:00", // JST ISO8601 (D-14)
  "app_version": "0.1.0",
  "scope": "app" | "project",
  "module_versions": {                            // 各モジュールが書き出した時の payload 版を記録
    "prompt": 1,
    "linkmemo": 1,
    "color": 1
  },
  "projects": [
    {
      "id": "<uuid>",
      "name": "...",
      "description": "...",
      "position": 0,
      "created_at": "...",
      "updated_at": "...",
      "items": [
        {
          "id": "<uuid>",
          "module_id": "prompt",
          "title": "...",
          "tags": ["..."],
          "payload_schema_version": 1,
          "payload": { /* モジュール固有 */ },
          "position": 0,                            // §6.5、export 時の position をそのまま保存
          "created_at": "...",
          "updated_at": "..."
        }
      ]
    }
  ]
}
```

### 12.2 設計上のポイント

- `search_text` は**書き出さない** (再生成可能なため。インポート時にモジュールの `index_text()` で再構築)
- `module_versions` は「エクスポート時点で各モジュールが現役だった版」のメモ。インポート先がそれより新しい版を持っていれば Eager-on-Read と同じ仕組みで吸収できる
- インポート時のプロジェクト名衝突は許容 (別プロジェクトとしてそのまま投入)
- **エクスポートは StorageService の高レベル読み込み API を通すため、古い payload を含む items は Eager-on-Read により自動的に最新版へ更新された上で出力される**。結果として、エクスポート JSON 内の `payload_schema_version` は該当モジュールの現行版に揃う
- 大量件数のエクスポート時は **進捗表示**を UI に出す
- エクスポート前の pre-op backup は取らない (個別 UPDATE が独立トランザクション + idempotent なので、export 中の中断は data の一貫性を損なわない)。ADR-0006 §2.5 参照

### 12.3 インポートは部分成功方式

**方針**: 「全件成功か全件失敗か」の二分ではなく、**取り込めるものだけ取り込み、取り込めなかったものは詳細とともに報告する**。

理由:
- バックアップ目的のエクスポートが他端末で開けるとき、1件のフォーマット異常で全件入れられないと現実的に困る
- ID 衝突や payload バリデーション失敗は 1 件単位で起こり得る

**集計対象 (インポート完了画面に表示)**:
- 投入成功 / スキップ (重複) / 失敗 (バリデーション NG / payload アップグレード失敗) の件数
- スキップ・失敗の各件について、原因と対象を**ログに残す** (CSV エクスポート可能にしておくとよい)

### 12.4 インポート時の処理順序 (重要)

`payload_schema_version` が古い item を投入する場合、**必ず先に payload を現行版にアップグレードしてから `index_text()` を実行する**。
そうしないと、古いフィールド構造を前提にした index_text() の旧コードがアプリ内に存在せず、search_text を正しく作れない。

#### トランザクション粒度

部分成功を実現するため、以下の二段階モデルを採用する:

- **プロジェクトごと: 1トランザクション** で、当該 project の INSERT のみを行う
  - project のバリデーション or INSERT が失敗 → そのプロジェクトの items はすべて**スキップ**(親が無いので投入できない)
  - project の INSERT が成功 → 個別 item の処理ループへ進む
- **個別 item ごと: 1トランザクション** で、その item の INSERT を行う
  - item 1件の失敗は他の item をロールバックさせない
  - 失敗した item は集計に記録 (§12.3)

「孤児」の懸念 (project だけ入って items が落ちる) は本モデルでも残るが、`project_id` で参照する設計上、空のプロジェクトが残るだけで他 item に害は無い。
「project + items を全件 atomic に投入」する選択肢は取らない (1 件のバリデーション失敗で 100 件の正常な item を捨てることになり、部分成功の利点を相殺する)。

#### 1 item あたりの処理フロー

```
[インポート 1 件あたりの流れ]
1. JSON ルートの schema_version を見てコンバータを通す (バッチ全体の前処理)
2. item の module_id をモジュールレジストリで解決
3. ID 衝突チェック (§3.3 のスキップ規則)
4. payload を現行 payload_schema_version までアップグレード (モジュールの upgrade_payload を順次適用)
5. アップグレード後 payload を validate_payload() で検証
6. アップグレード後 payload に対して index_text() を実行し search_text を生成
7. items に INSERT (1 トランザクション、FTS5 トリガが連動)
8. 失敗時は当該行のトランザクションのみロールバックし、残りは継続
```

#### 投入後の追補処理 (バッチ全体に対して 1 回)

step 1-8 を全件回し終えた後、**`apply_import` の責務として** 以下を実行する:

```
9. 投入された (project_id, module_id) 各スコープに対し、position を ROW_NUMBER で再付番する
   (§6.5 末尾の SQL を 1 回発行)。
   - 既存 item と新規 item の position 衝突を解消し、0..N-1 の密な連番に正規化
   - 1 トランザクションで実施、data_revision は +1 (= 並び替えの 1 操作とみなす、§6.5)
```

step 9 は「インポート完了後の補正」であり、`core_reorder_items` を内部発火するのではなく、`apply_import` 内で **直接 SQL を発行する**。理由: API 呼び出しコストを避け、ordered_ids を作る必要が無いため (現在の position 順をそのまま採用すればよい)。

### 12.5 インポート前バックアップ

import 実行ボタン押下時、StorageService は**実行前に pre-op バックアップ**を取る (§13.4)。
取り込みに失敗 / 期待と違う結果になった場合、ユーザーは pre-import バックアップに戻すだけで原状復帰できる。

---

## 13. バックアップ機構 (Q-18 の決着)

> Q-18 (Phase 1 で DB 自動バックアップを持つか) を **持つ** で確定。
> Export JSON が「他端末への可搬」であるのに対し、本節のバックアップは「ローカル復旧」を担う。

### 13.1 取得方法

- **SQLite Online Backup API** を使用する (`rusqlite::backup::Backup`)
- 単純なファイルコピーは禁止 (WAL 由来の不整合リスク §2 の警告参照)
- バックアップ中もアプリは通常通り使用できる (Online Backup API はオンラインで動作)

### 13.2 `data_revision` カウンタ

「変更が無いのにバックアップを作る」を防ぐためのカウンタ。

- 型: 整数。`meta.data_revision` に保存
- 増分タイミング: **StorageService の書き込みトランザクションがコミットされたとき +1** (1コミット = +1)
  - import で 100 items 投入 → 1 トランザクション → +1
  - DB schema migration → 適用版数ぶんの増分でなく、ひとまとまりで +1
  - データに変化を起こさない読み取りオンリー処理では増えない
- 増分の対象となる操作 (= 「データが変化した」と見なす操作):
  - item の create / update / delete
  - project の create / update / delete
  - import の投入
  - DB schema migration の適用
- 増分の対象に**しない**操作:
  - **Eager-on-Read による payload 自動アップグレード** — 旧 payload から決定的に再生成可能な派生更新であるため、バックアップ判定上の `data_revision` には含めない。ただし、直後にバックアップが取得された場合、そのバックアップには最新化後の payload / search_text が含まれてよい (バックアップ内容としては正しい状態)
  - meta テーブル自身への書き込み (バックアップ取得記録など) — バックアップ判定がループしてしまうため
  - 検索インデックス再構築管理コマンド (§7.3) — Eager-on-Read を一括発火するだけのため
- `last_backup_revision`: **最後に成功した任意種別の DB バックアップ** (auto / pre-op / manual いずれでも) 時点の `data_revision` を記録。次回 auto バックアップの要否判定で比較
- `last_auto_backup_at`: 直近の **auto** バックアップ取得時刻のみ更新する (pre-op / manual では更新しない)。auto 専用の 24 時間ゲートに使う

> 設計意図: pre-op / manual 取得で 24 時間タイマーを巻き戻すと本来取りたい日次自動が抑止されるため、`last_auto_backup_at` は auto 専用にする。一方 `last_backup_revision` は「最後にどこかでバックアップが取れていれば auto を急がない」判定のため、種別を問わず最新を保持する

### 13.3 自動バックアップ (auto)

**取得タイミング**: アプリ起動時に下記を**両方**満たす場合に取得。

- `data_revision != last_backup_revision` (前回バックアップ以降に変更がある)
- 直近の `last_auto_backup_at` から 24 時間以上経過 (もしくは `last_auto_backup_at` が空)

両方を要求するのは、「24時間経ってもデータが変わっていなければ取らない」「同日中に何度起動しても1回」「起動時刻が深夜2時でも昼でも問題なく動く」を満たすため。

**取得後の更新**:
- `last_auto_backup_at` を現在時刻 (JST ISO8601) に更新
- `last_backup_revision` を現在の `data_revision` に更新
- これらは meta テーブルへの書き込みなので**それ自体は `data_revision` を増分しない** (バックアップ取得を「ユーザー編集」と見なさない)

**ローテーション**:
- `<userdata>/backups/auto/` 内の最新 10 世代を保持
- 11 個目を作る時点で最古を削除
- 命名: `auto-<JST_FILENAME_TIMESTAMP>-r<revision>.sqlite` (例: `auto-2026-04-26T03-00-00.000+09-00-r142.sqlite`)
  - `JST_FILENAME_TIMESTAMP` は `JST_ISO8601` の `:` を `-` に置換した形式 (詳細は ADR-0005 §2.1)。Windows でファイル名に `:` が使えないため

### 13.4 破壊的操作直前バックアップ (pre-op)

以下の操作実行前に、StorageService が **必ず** 操作と同一の上位処理内でバックアップを取る:

| 操作 | 命名 prefix |
|------|------------|
| project 削除 | `pre-delete-project-<projectId>` |
| import 実行 | `pre-import` |
| DB schema migration 適用 | `pre-migration-v<N>` |
| restore 実行 (バックアップからの DB 上書き) | `pre-restore` |
| `core_rebuild_search_index` (検索インデックス一括再構築) | `pre-rebuild-search-index-<module_id>` (全体実行時は `pre-rebuild-search-index-all`) |

- バックアップ取得が失敗した場合、操作自体を中止する (バックアップ無しで破壊的操作を実行しない)
- **対象操作が失敗した場合の扱い**: pre-op バックアップ取得後に対象操作 (project 削除等) が失敗しても、**取得済みバックアップは削除しない**。失敗直前の状態を示す診断資料として残し、必要に応じてユーザーが復元に使える。ローテーションで自然に古くなったときに削除される (ADR-0007 §2.3)
- ローテーション: `<userdata>/backups/pre-op/` 内の最新 30 世代を保持
- 命名: `<prefix>-<JST_FILENAME_TIMESTAMP>-r<revision>.sqlite`

将来 UI から「モジュール一括削除」のようなバルク破壊操作を提供する場合は、この一覧に追加する (Phase 1 では UI 未提供のため対象外)。

### 13.5 手動バックアップ (manual)

- 設定画面の「バックアップ」セクションに「今すぐバックアップ」ボタンを置く
- 押下時、`<userdata>/backups/manual/` に `manual-<JST_FILENAME_TIMESTAMP>-r<revision>.sqlite` を作成
- **自動ローテーションしない**。ユーザーが UI から個別に削除する
- 一覧 UI では各バックアップの取得時刻 / リビジョン / ファイルサイズを表示
- 「リネームしてラベルを付ける」機能は Phase 1 では非対応 (ファイル名のメモを変えたければユーザーが OS のファイラーで直接編集すれば足る)

### 13.6 リストア (復元)

- 設定画面の「バックアップ」セクションから対象ファイルを選んで「このバックアップに戻す」を実行
- 実行前に**必ず pre-restore バックアップを取る** (§13.4) — 戻したあとに「やはり戻す前に戻したい」を可能にする
- **復元前の整合性検証** (ADR-0007 §2.4.1):
  - 選択されたバックアップファイルに対し `PRAGMA integrity_check` を 1 回実行
  - DB サイズによって数秒かかるため、UI に進行中表示 (スピナー / プログレス) を出す
  - 失敗時はリストアを中止し、別のバックアップファイル選択を促す
- 復元方式:
  1. 整合性検証通過後、すべての DB 接続をクローズ
  2. WAL ファイル (`data.sqlite-wal`, `data.sqlite-shm`) を削除して綺麗にする
  3. pre-restore バックアップを取得 (§13.4)
  4. 選択されたバックアップファイルを Online Backup API で **`data.sqlite` に上書き書き戻し**
  5. 復元後、アプリを **再起動** する (DB 接続を作り直してメモリ状態をリセットする最も確実な方法)
- 復元 UI 操作には §9.2 のタイプ・トゥ・コンファーム (バックアップファイル名の手入力) を要求

### 13.7 排他制御モデル (StorageService レベル)

バックアップ・リストアを含む、データの整合性を脅かしうる操作の同時実行を防ぐためのロックモデル。
これは StorageService 全体の排他制御方針であり、バックアップに限らない。

#### 排他対象の操作

以下の操作はすべて **StorageService の単一の書き込みロック (writer mutex)** を介して直列化する。
同時に 2 つ以上は実行しない。

- 通常の DB 書き込み (item / project の create / update / delete)
- backup (auto / pre-op / manual)
- restore
- DB schema migration
- import
- project delete (上記の「DB 書き込み」に含まれるが、ユーザー操作の塊として明示)

待機中の操作は FIFO で順番待ちさせる。Phase 1 では「他の操作が走っているのでお待ちください」のスピナーを UI に出す程度で十分。

#### 読み取りとの関係

| 状況 | 読み取り (item 一覧 / 検索 / 詳細) |
|------|--------------------------------|
| 通常の書き込み実行中 | 許可 (WAL モードで並行可能) |
| backup 実行中 | 許可 (Online Backup API は読み取りと並行可能) |
| migration 実行中 | 許可 (短時間 / 通常は数 ms オーダー) |
| import 実行中 | 許可 (1 件単位のトランザクションのため、その間の読み取りは「投入済み分のみが見える」状態) |
| **restore 実行中** | **全面停止** (DB ファイル自体を上書きするため、読み取り中の接続は切断する必要がある) |

#### restore の特別扱い

restore は他の操作と異なり「DB 接続を一度全閉鎖し、ファイルを上書きしてからアプリを再起動する」必要がある:

1. UI を「メンテナンスモード」に遷移させ、すべての画面で操作を不可にする
2. 進行中の書き込みトランザクションの完了を待つ (writer mutex を取得)
3. すべての読み取り接続をクローズ
4. WAL ファイル (`-wal`, `-shm`) をクローズ・削除
5. バックアップファイルを Online Backup API で `data.sqlite` に書き戻し
6. アプリ再起動 (新しい DB 接続をクリーンに作り直す)

5 までの過程で**何らかの失敗があった場合**:
- pre-restore バックアップ (§13.4) が `<userdata>/backups/pre-op/` に残っているので、ユーザーは手動でそれを使ってリトライできる
- アプリは「リストアに失敗しました。pre-restore バックアップから復元してください」のガイドを表示

#### 実装上の指針 (Phase 1)

- writer mutex は Tokio の `Mutex<()>` を `Arc` で共有
- restore は writer mutex に加えて「メンテナンスモード」状態フラグ (Zustand の core ストア) を立てる
- 排他制御は StorageService の中に閉じ込める。モジュールバックエンドは mutex を直接触らない (StorageService の高レベル API を使う)
- IPC コマンド層では、ロック取得待ちタイムアウトを設けない (個人ツールであり、デッドロックの方がレアなので待たせる方が安全)

### 13.8 各バックアップの保存先と命名 (まとめ)

```
<userdata>/backups/
├── auto/     auto-<datetime>-r<rev>.sqlite                   (最新10)
├── pre-op/   pre-<op>-<...>-<datetime>-r<rev>.sqlite          (最新30)
├── manual/   manual-<datetime>-r<rev>.sqlite                  (自動削除なし)
└── README.txt
```

`README.txt` には以下を記載:
- ファイル名規則
- 「バックアップは SQLite Online Backup API で取得済みのため、別の SQLite クライアントから直接読める」旨
- 「アプリのリストア機能を使わずに `data.sqlite` を手動で差し替える場合は、必ずアプリを終了してから行う」旨

---

## 14. DB スキーマ進化方針 (ADR-0006 + ADR-0011)

> **本節の位置づけ**: 詳細仕様は **ADR-0011 §2 を一次ソース** とし、本節は data-model 視点でのダイジェスト + マイグレーション一覧表 (§14.4) を提供する。§14.4 のみは「ADR-0011 §5 (歴史記録)」を継承する **一覧の一次ソース** として独立運用する (ADR の追記専用ポリシーで一覧表更新ができないため)。

コア DB スキーマの変更可否は **2 つのレイヤ** で運用する:

- **ADR-0006 (原則)**: モジュールデータ変更は payload バージョニング + Eager-on-Read で吸収。コア DB スキーマには触らない
- **ADR-0011 (例外)**: 機能拡張で本当に必要な **additive な DDL マイグレーション** に限り、別 ADR を切らずに `MIGRATIONS` 配列に追加してよい (詳細条件は ADR-0011 §2.1)。**破壊的な変更** (DROP / RENAME / 型変更 / 既存値書き換え) は引き続き別 ADR + C-12 起動停止画面が必要

### 14.1 何が「コア DB スキーマ変更」に当たるか

- `meta` / `projects` / `items` テーブルへのカラム追加・削除
- インデックスの追加・変更
- FTS5 トリガの再定義
- FTS5 仮想テーブルの再構築 (トークナイザ変更 / external content への切替)

これに該当しない変更 (各モジュールの payload 構造変更) は §7 の Eager-on-Read で吸収し、DB スキーマには触れない。

### 14.2 additive マイグレーション運用 (ADR-0011)

#### 14.2.1 許可される変更

ADR-0011 §2.1 のチェックリストを満たすものに限る:

- **新カラム + NOT NULL DEFAULT `<定数>`** (既存全行に対して既定値が即時確定すること)
- **新規 `CREATE TABLE IF NOT EXISTS`** (旧データは参照しない、新機能だけが使う)
- **新規 `CREATE INDEX`** (既存クエリの意味論は不変)
- **新規 `CREATE TRIGGER`** (既存行への遡及書き換えなし)
- **`CREATE VIEW`** (read-only、既存テーブルへの書き戻し無し)

#### 14.2.2 禁止される変更 (引き続き別 ADR が必須)

`DROP` / `RENAME` / 型変更 / 既存カラムへの後付け NOT NULL / 既存データの値書き換え / FK 制約の変更 / インデックスの削除。

#### 14.2.3 起動時の適用フロー

```
1. StorageService::open で `meta.db_schema_version` を読む
   ├ CURRENT_DB_SCHEMA_VERSION と一致 → 通常起動
   ├ 未来 (新版 DB を旧版アプリで開いた) → UnsupportedDbSchemaVersion → 起動停止
   └ 古い (旧 DB を新版アプリで開いた) → 次のステップへ
2. pre-migration バックアップ取得 (`pre-migration-v<N>` プレフィックス、§13.4 / ADR-0011 §2.4。`<N>` は適用後の `CURRENT_DB_SCHEMA_VERSION`)
   ├ 失敗 → 起動停止 + エラー画面 (path / 容量を表示)
   └ 成功 → 次へ
3. MIGRATIONS[from..to] を順次適用 (1 マイグレーション = 1 トランザクション)
   ├ いずれかが失敗 → 該当 tx をロールバック / db_schema_version は最後の成功値
   │                  → 起動停止 + エラー画面 (失敗 SQL + 原因 + 「次回起動で再試行」案内)
   └ 全成功 → db_schema_version を CURRENT_DB_SCHEMA_VERSION に書き換えて通常起動
```

#### 14.2.4 実装上の規約

- `MIGRATIONS: &[Migration]` 配列 (`src-tauri/src/storage/schema.rs`) に追加する。**Phase 1 の Migration 構造体は `{ from_version: i64, to_version: i64, sql: &'static str }` の 3 フィールド固定** (ADR-0011 §2.3)。`fn(&Transaction)` 形式は Phase 1 では採用しない
- **段階制約**: `to_version = from_version + 1` の 1 段ずつ。複数段ジャンプ (1→3 等) は不可
- **各エントリの末尾で必ず `UPDATE meta SET value = '<to>' WHERE key = 'db_schema_version'` を含める** — DDL と bump を同一トランザクションに同居させ、途中失敗時に `db_schema_version` だけ進む / DDL だけ進む の片寄りを防ぐ
- 新規 DB の DDL (`SCHEMA_DDL`) も同時に更新し、新規 DB は migration を **走らせずに** 最新版で立ち上がるようにする
- **`SqliteStorage::open` の外で migration を実行する** (ADR-0011 §2.4 bootstrap 経路)。具体的には `schema::migrate_if_needed(&Path)` という独立関数を `open` の前に呼び、pre-migration バックアップは rusqlite Backup API を直接叩く独立ヘルパで取得する
- マイグレーションテスト: `src-tauri/src/storage/migrations/v<N>.rs` 内に Migration 定義 + `#[cfg(test)] mod tests` で同居 (既存 storage テストと同じスタイル、別途 `tests/` ディレクトリは作らない)。in-memory `:memory:` SQLite で旧 schema を立てて migration を流し、行数 + 新カラム値 + 連続適用 idempotency を assert

### 14.3 不可逆な変更を避ける

- カラム削除より「使わないカラムを残す」を優先 (古い版で動かす可能性は無視できるが、エクスポート JSON 側にも影響するため)
- データの破壊的書き換えは避ける (特にユーザーデータの欠損方向)
- 上記が必要になる場合は **ADR-0011 §2.2 の禁止枠** に該当 → 別 ADR を切る

### 14.4 マイグレーション一覧 (一次ソース)

本表は `MIGRATIONS` 配列の **唯一の一次ソース**。ADR-0011 §5 は受理時点の歴史記録であり、以後の追加は本表のみを更新する (ADR は追記専用ポリシーのため)。

| from → to | 概要 | 導入 PR / ADR |
|---|---|---|
| 1 → 2 | `items.position` カラム追加 (`NOT NULL DEFAULT 0`) + `idx_items_project_module_position` 追加 | PR-Y / ADR-0011 |

---

## 15. 整合性テスト一覧 (Acceptance Test Scenarios)

実装時に必ず通すべきデータモデル整合性のテストシナリオ。
これらが全て満たされない設計変更は受け入れない。

| ID | シナリオ | 期待結果 |
|----|---------|---------|
| T-01 | project 削除 | 配下 items が物理削除される (FK CASCADE 経由) |
| T-02 | project 削除 (T-01 と同一操作) | 削除された items に対応する `items_fts` 行も消える (DELETE トリガ経由) |
| T-03 | item update | `items_fts` の対応行 (project_id / module_id / search_text) が更新される |
| T-04 | items 書き込みトランザクションのロールバック | items / items_fts の両方が書き込み前の状態に戻る (同一トランザクション保証) |
| T-05 | 古い `payload_schema_version` の item を読み込む | 現行版にアップグレードされた payload を返し、行も最新版に UPDATE される (Eager-on-Read) |
| T-06 | T-05 と同一行を再度読み込む | 既に最新版なので追加の DB 書き込みは発生しない |
| T-07 | export → 別 DB への import | `search_text` が `index_text()` で再生成され、検索が機能する |
| T-08 | import で 1 件が `validate_payload()` 失敗 | 失敗行のみスキップされ、残りは投入される (部分成功方式) |
| T-09 | import で `id` が衝突 | 衝突行はスキップされ警告される。既存データは上書きされない |
| T-10 | settings.json 書き込み中のプロセス強制終了 | 既存の `settings.json` は壊れず、変更は失われるだけ (atomic rename 経由) |
| T-11 | `last_opened_project_id` が指す project が削除済み | 起動時に `null` に置換され、最初のプロジェクトが開かれる |
| T-12 | 自動バックアップ取得後、`data_revision` 不変で再起動 | バックアップ取得がスキップされる |
| T-13 | project 削除前 / import 前 / migration 前 / restore 前 | pre-op バックアップが対応するファイル名で保存されている (migration 前は `pre-migration-v<CURRENT_DB_SCHEMA_VERSION>-*` フォーマット、§13.4 / ADR-0011 §2.4) |
| T-14 | バックアップ取得失敗 | 紐づく破壊的操作 (例: project 削除) が中止され、データが変更されない |
| T-15 | restore 実行 | 実行前に pre-restore バックアップが残っており、復元後にアプリ再起動が促される |
| T-16 | `tags` カラムに不正 JSON を直接 INSERT | CHECK 制約 (`json_valid`) でエラーになる |
| T-17 | trigram トークナイザでの日本語検索 | 「プロンプト」「ぷろんぷと」のような部分一致が期待通り動作する |
| T-18 | アプリの新版で作った `payload_schema_version` を旧版アプリで開く | 起動が停止しエラー画面が出る (黙って動作しない) |
| T-19 | 壊れた payload を含む item を一覧で読み込む | 共通カラム (title 等) は表示され、本文部分は破損マーカー表示。一覧自体はエラーで全停止しない |
| T-20 | Eager-on-Read 内の UPDATE が失敗した場合 | アプリは結果オブジェクトをメモリ上で返しつつ「永続化未完了」を UI に通知する |
| T-21 | 同時に 2 件の書き込みが走った場合 | StorageService の writer mutex で直列化される (片方が完了するまで他方は待つ) |
| T-22 | restore 実行中に他のコマンドを発火 | UI がメンテナンスモードで操作不可。コマンドは弾かれる |
| T-23 | restore 失敗時 | pre-restore バックアップが `<userdata>/backups/pre-op/` に残る |
| T-24 | Eager-on-Read 自動アップグレードのみ発生 | `data_revision` は増えない |
| T-25 | export JSON の `exported_at` フォーマット | JST ISO8601 (`+09:00` を含む) で書き出される |
| T-26 | 検索語 1〜2 文字での検索 | trigram MATCH ではヒットしないが、LIKE フォールバックにより `title` / `tags` / `search_text` 内の部分一致が返る (§8.1 制限事項) |
| T-27 | 同一行を 2 つのコマンドが v1 として並行に読み込んだ後、両方が v2 へアップグレードを試みる | 楽観的並行制御により、後発の UPDATE は `WHERE payload_schema_version = ?` で空振りし、再読み込み後に最新版と認識して再衝突せず収束する (§7.2) |
| T-28 | `core_rebuild_search_index` 実行 | 実行前に `pre-rebuild-search-index-<module_id>` (or `-all`) のバックアップが取得されている (§13.4) |
| T-29 | `core_rebuild_search_index` 実行後 | 全行が最新の `payload_schema_version` と最新の `search_text` に揃う |
| T-30 | エクスポート実行 | 出力 JSON 内の各 item の `payload_schema_version` がすべて該当モジュールの現行版に揃う (Eager-on-Read による自動最新化、§12.2) |
| T-31 | モジュールの `current_payload_version` 上昇後の起動 | `settings.json` の `modules.<id>.last_seen_payload_version` と比較、不一致なら再構築推奨通知が出る (§11.2 例外) |
| T-32 | リストア対象に破損ファイルを選択 | `PRAGMA integrity_check` が失敗を返し、リストアが中止される。別ファイル選択を促すダイアログが出る (ADR-0007 §2.4.1) |
| T-33 | pre-op バックアップ取得後に対象操作が失敗 | pre-op バックアップは削除されず `<userdata>/backups/pre-op/` に残る (§13.4) |
| T-34 | pre-op / manual バックアップ取得 | `last_backup_revision` は更新されるが、`last_auto_backup_at` は変わらない (§13.2) |
| T-35 | 旧 schema (v1) DB を含む状態でアプリ起動 | `schema::migrate_if_needed` が `MIGRATIONS[0]` を適用し、`items.position` 全行 `0`、`idx_items_project_module_position` が `EXPLAIN QUERY PLAN` で使用される、`meta.db_schema_version` が `2` に更新される (ADR-0011 §2.3 / §2.4) |
| T-36 | T-35 の migration 完了後に再起動 | `db_schema_version` が CURRENT と一致するため migration は走らず通常起動。pre-migration バックアップは新規取得されない (冪等性) |
| T-37 | pre-migration バックアップ取得失敗 (例: backups dir への書込み権限なし) | migration が中止され起動停止画面に遷移する (path / 容量を表示)。DB ファイルは元の v1 状態のまま (ADR-0011 §2.4 / §2.5) |
| T-38 | `core_reorder_items` の引数検証 | `ordered_ids` 集合が `SELECT id FROM items WHERE project_id=? AND module_id=?` と完全一致しない (欠損 / 余分 / 他スコープ ID 混入) → `AppError::Validation` で reject。1 件成功時は全件 UPDATE → `data_revision +1`、`updated_at` 不変 (§6.5) |
| T-39 | `core_reorder_items` で他スコープの item ID を ordered_ids に混入 | UPDATE 句の三条件 WHERE (`id=? AND project_id=? AND module_id=?`) で物理的に弾かれ、他スコープが silently 上書きされない (§6.5) |
| T-40 | 未編集スコープ (全行 position=0) への新規 INSERT | 新規行も `position=0` で append され、全行 0 が維持される。ORDER BY タイブレーカーで updated_at DESC により先頭に表示される (§6.5) |

---

## 16. オープン論点の解決提案サマリ

| ID | 論点 | 提案 |
|----|------|------|
| Q-08 | M-LinkMemo: 単一テーブル+種別フラグ vs 種別ごと分割 | **単一テーブル+`type`フラグ** (§10.2)。ローカル/ネットワークパスは `type=path` に統合。`file://` 入力は path に正規化 |
| Q-11 | items 具体スキーマと FTS5 トリガ設計 | 本書 §6 / §8 で確定 |
| Q-13 | 設定 JSON の名前空間設計 | `core` / `modules.<id>` の2階層 (§11) |
| Q-14 | プロジェクト削除のカスケード | FK の `ON DELETE CASCADE` + `PRAGMA foreign_keys = ON` (§9) |
| Q-17 | エクスポートのファイルサイズ上限 / 分割の必要性 | Phase 1 では単一 JSON ファイルで十分。サイズ上限は設けない |
| Q-18 | DB の自動バックアップを Phase 1 で持つか | **持つ**。Online Backup API + `data_revision` 連動 (§13) |

→ レビューで合意できた段階で `requirements.md` の Q-08 を **D-08** として確定し、JST 時刻方針を **D-14** として新規確定。
Q-11 / Q-13 / Q-14 / Q-17 / Q-18 は本書内で完結するため D-番号は付けず、本書を正とする。
D-11 (Lazy Migration on Read) の文言は **Eager-on-Read** に改訂する (§7.0 参照)。

---

## 17. 残オープン論点

| ID | 論点 | 決着先 |
|----|------|--------|
| Q-12 | `ModuleBackend` トレイトと TS 側 `ModuleDefinition` の正確な API | `module-contract.md` |
| Q-19 | バックアップ復元 UI の具体仕様 (一覧表示のソート / 検索 / プレビュー有無) | architecture.md 追補 or 実装時 |

> Q-15 (重い処理のキャンセル機構) は ADR-0009 で **Tauri Channel + `CancellationToken` + `core_cancel_operation`** として解決済み。export / import / FTS 再構築 / リストアの進捗 Channel と writer mutex 中の挙動も同 ADR §1 表 / §7.2 を参照。

---

## 18. 改訂履歴

| 日付 | 版 | 内容 |
|------|----|------|
| 2026-04-25 | 0.1 | 初版ドラフト (要件 0.3 / アーキテクチャ 0.2 を前提) |
| 2026-04-26 | 0.2 | レビュー反映: ID 衝突戦略を §3.3 に明記 / json_valid CHECK と一覧用 index 3 種を items に追加 / JST ISO8601 タイムスタンプ規約を §6.4 として確定 (D-14 候補) / Lazy Migration を Eager-on-Read 変種に改訂し search_text 整合性を担保 (§7) / 検索インデックス再構築管理コマンドを §7.3 に追加 / FTS5 の MATCH 対象を `search_text` 1本に絞り込み外部コンテンツ等の逃げ道を §8.1 に明記 / §8.3 の JOIN 説明を実態に合わせて修正 / 削除確認をタイプ・トゥ・コンファーム方式に変更 §9.2 / `file://` 入力を path に正規化 §10.2 / M-Color の search_text 説明から「red」例を削除 §10.3 / settings の dangling 参照処理を §11.5 に追加 / import を部分成功方式・1件1トランザクション・payload upgrade → index_text の順序で明記 §12 / バックアップ機構を §13 として新設 (Online Backup API / data_revision / auto・pre-op・manual / リストア手順) / WAL モード下のファイルコピー禁止を §2 に明記 / 整合性テスト一覧を §15 に追加 / Q-17 / Q-18 を確定 / Q-19 を新規起票 |
| 2026-04-26 | 0.3 | レビュー反映: export JSON の `exported_at` を JST ISO8601 に統一 §12.1 / Eager-on-Read による更新は `data_revision` を増やさない旨を §13.2 に明記 / Eager-on-Read 失敗時の扱い (5 ケース別の AppError と呼び出し元振る舞い) を §7.6 として追加 / import のトランザクション粒度を「project は 1tx、各 item は 1tx」と明確化 §12.4 / バックアップ・リストア中の操作ロック方針を §13.7 として追加 / FTS5 の MATCH 評価前絞り込みの言い切りを「実行計画次第で可能性がある」に修正 §8.3 / StorageService の writer mutex による排他制御モデルを §13.7 に明文化 / 整合性テストに T-18〜T-25 を追加 |
| 2026-04-30 | 0.4 | ADR-0003 反映: §8.1 に trigram の 3 文字未満非ヒット制限と LIKE フォールバック戦略を追記 / 整合性テストに T-26 (短い検索語の LIKE フォールバック動作) を追加 / Q-16 (Shiki vs rehype-highlight) を §17 から削除済み |
| 2026-04-30 | 0.5 | ADR-0005 反映: 時刻文字列の用語を **`JST_ISO8601`** (DB / JSON 用) と **`JST_FILENAME_TIMESTAMP`** (ファイル名用) に明確に分離 / §6.4 に安定ソートのタイブレーカー規約 (`ORDER BY <ts> DESC, id DESC`) を追記 / §13 のバックアップ命名で `<JST-ISO8601>` プレースホルダを `<JST_FILENAME_TIMESTAMP>` に置換 / §4 meta テーブルの `app_initialized_at` プレースホルダ表記を `<JST_ISO8601>` に統一 |
| 2026-04-30 | 0.6 | §6.1 の 3 つのリスト用インデックスすべての末尾に `id DESC` を追加し、安定ソート規約 (`ORDER BY <ts> DESC, id DESC`) をインデックスのみで解決できるようにした。同一 ms 衝突時の tied group メモリソートを排除 |
| 2026-04-30 | 0.7 | ADR-0006 反映: §7.2 に楽観的並行制御 (UPDATE WHERE 句にバージョン条件 + rows_affected==0 で再読み込み) と二系統の内部更新 API (通常更新 / Eager-on-Read 内部更新) を追記 / §13.4 の pre-op バックアップ対象に `core_rebuild_search_index` を追加 / §12.2 にエクスポート時の Eager-on-Read 自動発火 + 進捗表示を明記 / §11.1 / §11.2 に `modules.<id>.last_seen_payload_version` を導入 (コアが解釈する例外フィールド) / 整合性テストに T-27〜T-31 を追加 |
| 2026-04-30 | 0.8 | ADR-0007 反映: §4 meta テーブルの `data_revision` に SQLite INTEGER / Rust `i64` 整合の注記を追加 / `last_backup_revision` を「最後に成功した任意種別の DB バックアップ時点 revision」、`last_auto_backup_at` を「auto 専用 24 時間ゲート」と責務を明確化 / §13.2 で同責務分離を再掲 / §13.4 に「pre-op 取得後に対象操作が失敗してもバックアップを削除しない」旨を追加 / §13.6 リストア手順に `PRAGMA integrity_check` 事前実行 + UI 進行中表示 + 失敗時別ファイル選択促しを追加 / 整合性テストに T-32〜T-34 を追加 |
| 2026-04-30 | 0.9 | ADR-0009 受理反映: §17 から Q-15 を削除し ADR-0009 解決済みのフットノートを追加 (export / import / FTS 再構築 / リストアの進捗 Channel と writer mutex 中の挙動は ADR-0009 §1 表 / §7.2 を参照) |
