# ADR-0022: FTS 同期トリガの置換を additive マイグレーションとして扱う条件

- **Status**: Accepted
- **Date**: 2026-09-25
- **Deciders**: zredjet
- **Related**: ADR-0003 (FTS5 trigram) / ADR-0006 / ADR-0011 (additive 限定マイグレーション) / ADR-0016 (Link / Memo 所属移行) / `data-model.md` §8.2 / §14

---

## 1. Context

`items` と `items_fts` は同期トリガ 3 本 (`trg_items_fts_ai` / `_au` / `_ad`) で揃えている (`data-model.md` §8.2)。更新トリガ `trg_items_fts_au` は次の 2 つの理由で遅い。

- `AFTER UPDATE ON items` で、**どの列の更新でも** 発火する。D&D 並び替え (`position` だけの更新) でも発火する
- 本体が `UPDATE items_fts ... WHERE item_id = new.id` になっている。`item_id` は FTS5 の `UNINDEXED` 列で、FTS5 は UNINDEXED 列で絞り込めないため、1 行ごとに `items_fts` を全件走査する

実測値 (SQLite 3.50、trigram、1 item あたり 300 文字):

| 操作 (全体 10,000 item) | 現行トリガ | `UPDATE OF` に絞ったトリガ |
|---|---|---|
| 1 プロジェクト 1,000 item の並び替え | 968 ms | 1.4 ms |
| 1 item の編集 | 約 1 ms | 約 1 ms |
| 1,000 item を持つプロジェクトの削除 | 915 ms | 884 ms |

並び替えは item 数 N に対して O(N²) になり、通常操作としては許容できない。ADR-0016 の所属移行後に行う位置の正規化や、import 後の正規化も同じ経路を通る。

SQLite には `ALTER TRIGGER` / `CREATE OR REPLACE TRIGGER` が無いため、トリガの発火条件や本体を変えるには `DROP TRIGGER` + `CREATE TRIGGER` が必要になる。ADR-0011 §2.1 は「新トリガ追加」を additive として許可しているが、既存トリガの置換には触れていない。CLAUDE.md の不変条件は `DROP` 全般を禁止している。そのため、本 ADR で扱いを明確にする。

## 2. Decision

### 2.1 許可する条件

次の条件を **すべて** 満たす場合、トリガの置換 (`DROP TRIGGER IF EXISTS` + `CREATE TRIGGER`) を ADR-0011 の `MIGRATIONS` 枠組み (1 段ずつ、1 トランザクション、末尾で `db_schema_version` を bump、起動時の pre-migration バックアップ) で行ってよい。C-12 の起動停止画面は要らない。

1. 対象は、**派生データ (検索インデックス等) を同期するトリガ** に限る。ユーザーデータを書き換えるトリガは対象外
2. `DROP` と `CREATE` を同じ Migration エントリ (= 同じトランザクション) に入れる。トリガが存在しない瞬間を外部から観測できないようにする
3. 置換後のトリガは、置換前と **同じ同期結果** を保つ。発火条件を狭める場合は、同期先が参照する列の更新をすべて含める
4. マイグレーションで既存行の値を書き換えない (ADR-0011 §2.2 の「値書き換え」に当たらない)
5. 新規 DB 用の `SCHEMA_DDL` も同じ定義に更新する

テーブル / カラム / インデックスの `DROP` は、引き続き ADR-0011 §2.2 の重い経路 (新 ADR + C-12) に乗せる。本 ADR はトリガ定義の置換に限った補正であり、`DROP` 全般を緩めるものではない。

### 2.2 今回の適用 (v2 → v3)

```sql
DROP TRIGGER IF EXISTS trg_items_fts_au;
CREATE TRIGGER trg_items_fts_au AFTER UPDATE OF project_id, module_id, search_text ON items BEGIN
  UPDATE items_fts SET
    project_id  = new.project_id,
    module_id   = new.module_id,
    search_text = new.search_text
  WHERE item_id = new.id;
END;
UPDATE meta SET value = '3' WHERE key = 'db_schema_version';
```

- `items_fts` に写す列は `item_id` / `project_id` / `module_id` / `search_text` の 4 つ。`id` は更新しないので、残りの 3 列を `UPDATE OF` に並べれば同期結果は変わらない (§2.1 条件 3)
- title / tags / payload の編集は、常に `search_text` の再生成と同じ UPDATE で書かれる。Eager-on-Read (ADR-0006) と ADR-0016 の所属移行も同様。したがってこれらの更新では従来どおり発火する
- `position` だけの更新 (並び替え・正規化) では発火しなくなる

### 2.3 採らなかった案

| 案 | 採らなかった理由 |
|---|---|
| FTS の rowid を `items.rowid` に揃え、`WHERE rowid = ...` で引く | 削除も O(1) になるが、`items` は `INTEGER PRIMARY KEY` を持たない。SQLite の `VACUUM` はそのようなテーブルの rowid を振り直す場合があり、索引が黙ってずれる。まれな操作 (プロジェクト削除、PR-6 以降はメインスレッド外で実行) の改善のために、恒久的に壊れ得る対応関係は持ち込まない |
| `item_id` → FTS rowid の対応表を別テーブルで持つ | トリガが 2 表を同期する必要があり、複雑さに見合わない |
| トリガはそのままにする | 並び替えが O(N²) のまま残る |

## 3. Consequences

- 並び替え・位置の正規化の FTS 同期コストが消える (1,000 item の並び替えで 968 ms → 1.4 ms)
- 1 item の編集・削除は、従来どおり `items_fts` を 1 回走査する。プロジェクト削除は O(M·N) のまま残る (10,000 item 中 1,000 item を持つプロジェクトの削除で約 0.9 秒)。問題になった場合は §2.3 を再検討する
- `CURRENT_DB_SCHEMA_VERSION` は 3 になる。v2 以前の DB は起動時に pre-migration バックアップを取ってから移行する。旧 schema のバックアップをリストアした場合も同じ `MIGRATIONS` が適用される
- `data-model.md` §14.4 のマイグレーション一覧に v2 → v3 を追記する
