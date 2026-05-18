# ADR-0011: コアスキーマの additive 限定マイグレーション

- **Status**: Accepted
- **Date**: 2026-05-16
- **Deciders**: zredjet
- **Related**: ADR-0006 (payload バージョニング) / ADR-0007 §3.4-§3.5 (pre-op バックアップ命名 + ローテーション) / `requirements.md` D-03 (永劫互換) / E-04 (コア起因マイグレーション禁止) / `data-model.md` §3 / §4 / §13.4 / §14 / `CLAUDE.md` (不変条件「コアスキーマのマイグレーションをしない」)

---

## 1. Context

ADR-0006 と CLAUDE.md は次の不変条件を持つ:

> **コアスキーマのマイグレーションをしない**。モジュールデータ変更は payload バージョニング + Eager-on-Read (ADR-0006) で吸収する。本当に必要なら新 ADR + `db_schema_version` 上昇 + C-12 起動停止画面の追加が前提

加えて `requirements.md` D-03 (永劫互換) は「やむを得ない場合のみ移行を許可し、その例外は ADR に必ず記録する」と例外運用そのものを規定しており、E-04 (コア起因マイグレーション禁止) は「モジュールが将来増減してもデータベースのマイグレーションがコア起因では発生しないこと」を要求している。**本 ADR は D-03 の「例外を ADR に記録する」運用そのものとして切る。E-04 の趣旨 (= モジュール都合の payload 変更でコア DB に波及させない) は維持しつつ、コア機能由来の additive 変更を限定的に許可する補正である**。

これは「**起動時にユーザーデータを破壊する複雑なマイグレーションを書かない**」という意図で、Phase 1 のソロ開発体制 / 個人ツールという性質に整合する。一方で、機能を増やす過程で以下のような **追加的** スキーマ変更の必要が現実に出てきた:

- **PR-Y (Item D&D 並び替え)**: `items` テーブルに `position INTEGER` カラムが必要 (`docs/ui-design.md` §6 / P-1 / L-1 / K-1 の D&D)
- **将来予想**: 検索性能改善のため新規 INDEX を足す / 新しい補助テーブルを追加する / モジュール集計用のキャッシュ列を足す

これらは「カラム / テーブル / インデックスを **追加するだけ**」の変更で:

- **データを書き換えない**
- **既存スキーマ要素を破壊しない** (DROP / RENAME / 型変更を伴わない)
- **既存クエリの意味論を変えない** (新カラムは `NOT NULL DEFAULT <const>` で旧データも有効化する、新テーブルは LEFT JOIN / 別パスでアクセスする)

この種の安全な変更まで「ADR + 起動停止画面 + ユーザー手動 export/import」という重い経路を強制すると、Phase 1 の小回りが効かなくなる。ADR-0006 の **趣旨** (脆弱なマイグレーションでデータを壊さない) を守ったまま、**運用負荷を実態に合わせる** ことが本 ADR の目的。

### 1.1 何が「マイグレーション」のリスクか

ADR-0006 の不変条件が回避したい失敗モードを言語化する:

| リスク | 例 | additive で起こるか |
|---|---|---|
| データ消失 | DROP COLUMN / DROP TABLE | × (additive にはない) |
| 意味論変化 | カラム名変更で旧クエリが silently 別物を返す | × (RENAME しない) |
| 制約違反による起動失敗 | NOT NULL を追加して既存 NULL 行が違反 | × (NOT NULL DEFAULT で既存行も有効) |
| 半端な状態 | 複数 ALTER の途中で SQLite が落ち、整合性が壊れる | △ 1 トランザクションで包めば回避可 |
| バックアップとの非互換 | 旧 DB を新版で開いた瞬間に書き換えてバックアップに戻れなくなる | △ pre-migration バックアップで回避可 |
| 性能劣化 | 既存大量行への ALTER TABLE が長時間ロック | × Phase 1 規模なら数秒以内 |

最後の 2 つは **手順で吸収可能** な性質のもの。ここを丁寧に書ければ、additive 変更は安全に運用できる。

## 2. Decision

### 2.1 許可される変更 (additive only)

以下の DDL は ADR を新規に切らずに `schema.rs` の `SCHEMA_DDL` および `MIGRATIONS` 配列に追加してよい (ただし `db_schema_version` の bump と PR レビューは必須):

| 種別 | 例 | 条件 |
|---|---|---|
| **新カラム追加** | `ALTER TABLE items ADD COLUMN position INTEGER NOT NULL DEFAULT 0` | DEFAULT が指定されており、既存全行に対して即時有効値が決まる |
| **新テーブル追加** | `CREATE TABLE IF NOT EXISTS item_positions (...)` | 旧データには **何も参照されない**。新機能だけが使う |
| **新インデックス追加** | `CREATE INDEX idx_items_position ON items (project_id, module_id, position)` | クエリプランの変化は許容範囲、データ意味は不変 |
| **新トリガ追加** | `CREATE TRIGGER ...` | 既存行への遡及書き換えを **行わない** ことを ADR/コメントで明示 |
| **`CREATE VIEW`** | 集計用 read-only ビュー | 既存テーブルへの書き戻し無し |

#### 境界事例のガイド (誤読防止)

- **`DEFAULT` は定数リテラルのみ**: `0` / `''` / `'[]'` 等は可。`unixepoch()` / `random()` / sub-query / 関数呼び出しは不可 (動的計算は migration 中に複数回評価され idempotency が崩れる)
- **同一 PR 内で additive と non-additive を混ぜない**: 「新 INDEX 追加と古い INDEX DROP」「新カラム追加と既存カラム RENAME」のような複合変更は本枠から外れ、別 ADR 経路 (§2.2) に乗せる
- **迷ったら §2.2 寄りで判断する**: 境界事例の押し込み (「DROP 同然だが厳密には RENAME」「ALTER TABLE のうち REINDEX に近い」等) を本枠に入れない。判断が割れたら新 ADR を 1 本切るコストを払う方が安全

### 2.2 禁止される変更 (引き続き ADR + 起動停止画面が必須)

以下は **本 ADR では許可しない**。引き続き ADR-0006 の重い経路に乗せる:

- `DROP TABLE` / `DROP COLUMN`
- `ALTER TABLE ... RENAME` (テーブル / カラム名)
- カラム型の変更 (TEXT → INTEGER 等)
- 既存カラムへの NOT NULL 追加 (旧データが NULL 持ちの場合)
- 既存データの **値書き換え** を伴うマイグレーション (例: 旧 URL を新形式に正規化)
- FK 制約の追加 / 削除 / 変更
- インデックスの **削除** (新規追加は OK)

これらが必要になった場合:

1. 新 ADR を切る
2. `db_schema_version` を 2 段階以上上げる (例: 2 → 4)
3. C-12 起動停止画面を整備し、旧 DB に対してはアプリを起動させない
4. ユーザーに export → 新版インストール → import の経路を案内する

### 2.3 `db_schema_version` の運用

- **`CURRENT_DB_SCHEMA_VERSION` を 1 つ上げる毎に、`SCHEMA_DDL` を「新規 DB の DDL」として更新** し、同じ変化を `MIGRATIONS: &[Migration]` 配列にも追加する
  - **新規 DB**: `SCHEMA_DDL` だけで最新版が立ち上がる (migration は走らない)
  - **既存 DB**: 起動時に `db_schema_version < CURRENT_DB_SCHEMA_VERSION` を検知し、`MIGRATIONS` を順次適用 (`MAX(from_version)+1 … CURRENT_DB_SCHEMA_VERSION` の範囲)
  - **未来の DB** (アプリより新しい schema): 引き続き `UnsupportedDbSchemaVersion` で起動停止 (旧版アプリで新版 DB を開く事故防止)
- **`MIGRATIONS` の各エントリは additive のみ** (本 ADR §2.1 の条件)。non-additive を入れるには別 ADR が要る (本 ADR §2.2)
- **1 マイグレーション = 1 トランザクション**。途中失敗時はロールバックして元 schema に戻り、エラー画面を出す
- **Phase 1 の `Migration` 構造体**: `struct Migration { from_version: i64, to_version: i64, sql: &'static str }` の 3 フィールド固定。`fn(&Transaction)` 形式は **Phase 1 では採用しない** (additive only のレビュー機械判定を保つため、任意 SQL を許容する fn 形式は将来別 ADR で導入する)
- **段階制約**: Phase 1 は `to_version = from_version + 1` の **1 段ずつ** だけを許容する不変条件にする。複数段ジャンプ (例: 1→3) は不可。連続適用のループは migrate ロジック側で行う
- **各エントリは末尾で必ず `UPDATE meta SET value = ? WHERE key = 'db_schema_version'` を含める**: DDL とバージョン bump を 1 トランザクションに同居させることで、途中失敗時に「DDL だけ部分適用された壊れた DB」が残らない (§2.5 「最後に成功した version で止まる」の根拠)
- **`sqlite::verify_schema_version` (既存) の改修**: 現状は不一致なら両方向で fail-fast。本 ADR 受理後は「より古い → migrate 経路」「より新しい → 起動停止 (従来通り)」に分岐させる。migrate 経路は `sqlite::open` の **外側** (§2.4) で実行するため、`verify_schema_version` 自体は migration 完了後に呼ぶ位置に移す

### 2.4 pre-migration バックアップ + bootstrap 経路

起動時に migration が走る前に **pre-op バックアップ (`pre-migration-v<N>` プレフィックス、`data-model.md` §13.4 既存規約)** を自動取得する (ADR-0007 §3.5 のローテーション規則に乗る)。`<N>` は **適用後の `CURRENT_DB_SCHEMA_VERSION`** とする (複数段適用の場合も 1 ファイルのみ取得し、最終 to 値を入れる)。

理由:

- migration 自体は 1 トランザクションで安全だが、**ファイル破損 / プロセス強制終了** で WAL が中途半端に残るリスクは 0 にできない
- ユーザーが「アップグレード前に戻したい」と思った時に、別ファイルとして手元に存在することが重要 (新版アプリで旧版 DB に書き戻すことは想定しないが、旧版バイナリで開けばよい)

#### Bootstrap 順 (鶏卵問題の回避)

`LocalBackupService::take` は完成済 `Arc<dyn StorageService>` を要求するため、`SqliteStorage::open` の **内側** で migration を走らせると「未完成 storage で backup を呼ぶ」鶏卵問題が起きる。これを回避するため、**migration は `SqliteStorage::open` の外で実行する**:

```
1. schema::inspect_db_schema_version(&Path) → i64           ; 軽量、Connection を開いて値を読むだけ
2. v < CURRENT なら schema::take_pre_migration_backup(
     db_path, backups_root, to_version=CURRENT
   )                                                         ; rusqlite::backup::Backup API を直接叩く独立ヘルパ
                                                              ; pre-migration prefix のファイルだけ書き出し、meta は touchしない
3. v < CURRENT なら schema::migrate_if_needed(&Path)         ; MIGRATIONS を順次適用、各 tx 末で meta UPDATE
4. SqliteStorage::open(&Path) → Arc<dyn StorageService>      ; ここで verify_schema_version (== 完全一致) が成立
5. LocalBackupService::new(backups_root, Arc::clone(&storage))
```

- ステップ 2 の `take_pre_migration_backup` は `BackupService` には属さない **schema モジュール内の独立関数**。理由: BackupService は storage への参照を必要とするが、bootstrap 時点では storage が未生成
- 取得したファイルは bootstrap 後の `LocalBackupService::list()` で通常通り認識される (パスとプレフィックスの命名規則に乗っているため)
- ステップ 1-3 で発生する DB 接続は migration 完了とともに **必ず close** する (writer mutex を握る storage 接続と競合しないように)

バックアップ取得失敗時は **migration を中止し、起動を停止する** (エラー画面で path / 容量を表示)。

### 2.5 マイグレーション失敗時の挙動

| ケース | 挙動 |
|---|---|
| pre-migration バックアップ取得失敗 | 起動停止 + エラー画面 (バックアップ先 path / 容量を表示) |
| 1 マイグレーション SQL が失敗 | 該当トランザクションをロールバック → 起動停止 + エラー画面 (失敗した SQL + 原因) |
| 連続適用の途中で失敗 | 失敗したマイグレーションのみロールバック (以前の成功分は確定済み)。`db_schema_version` は **最後に成功した version** で止まる → 次回起動で残りを再試行できる |
| 全 migration 成功 | `db_schema_version` を `CURRENT_DB_SCHEMA_VERSION` に書き換えて通常起動 |

エラー画面はネットワーク通信を伴わない C-12 起動停止画面 (ADR-0008 の方針) と同じシステムを流用する。

### 2.6 CLAUDE.md 不変条件の改訂

本 ADR の受理に合わせて、CLAUDE.md の該当行を以下に置き換える:

> - **コアスキーマの破壊的マイグレーションをしない**。`DROP` / `RENAME` / 型変更 / 既存値書き換えは ADR-0006 の不変条件のまま (新 ADR + C-12 が必要)。
> - **additive な DDL マイグレーション** (新カラム + DEFAULT / 新テーブル / 新インデックス / 新トリガ / VIEW) は ADR-0011 の枠組みで許可されている。`db_schema_version` を bump し `schema.rs::MIGRATIONS` にエントリを追加する。pre-migration バックアップが自動取得される。

## 3. Consequences

### Pros

- alpha 段階で **ユーザーデータを保ったまま** スキーマを段階的に拡張できる
- 各 ALTER の安全性が「additive 限定」で機械的に判定できる (PR レビューが楽)
- 旧 DB を新版で開いた時の挙動が予測可能 (migration → 通常起動 or 起動停止画面)
- pre-migration バックアップで「アップグレード後に問題があった」場合の戻り経路が確保される

### Cons

- マイグレーション機構を 1 つ実装する責務が増える (schema.rs::MIGRATIONS + 適用ロジック + テスト)
- PR レビュー時に「これは additive か?」の判断が常に要る (本 ADR §2.1/§2.2 のチェックリストで吸収)
- `MIGRATIONS` 配列が将来肥大化する可能性 → 100 件超えたら別 ADR で「古い migration の畳み込み」を検討

### 副作用 (運用ルール)

- PR で `MIGRATIONS` を追加する際は、PR テンプレート / 説明に **「additive か / pre-migration バックアップ取得を確認したか」** を必ず書く
- バックエンドテスト: 古い `db_schema_version` の DB ファイルを `:memory:` で作って migration を流す回帰テストを毎 ADR で追加する
- リリースノートに「DB schema version: X → Y、起動時に自動移行されます」と明記する (ADR-0008 §6 の dmg/exe 配布フローに乗せる)

## 4. 代替案 (検討して却下)

| 案 | 却下理由 |
|---|---|
| **A. 厳格運用継続 (ADR-0006 のまま)** | alpha 段階で `items.position` 追加のような小変更でも旧 DB をブリック化する。export/import 強要は個人ツールとしての敷居が高い |
| **C. 別テーブル `item_positions(item_id PK, position INT)`** | ORDER BY が `LEFT JOIN ... COALESCE(position, ...)` で複雑化し、検索 SQL の組み立てにも影響する。`items` 単体でのソート定義が壊れる |
| **D. PR-Y 自体を Phase 2 送り** | UI 設計 (ui-design.md §6) で D&D は明記済み。Phase 1 で実装する価値がある |

C は「マイグレーション無し」が魅力だが、本 ADR で枠組みを整えれば B (本 ADR の決定) の方がコア構造が素直になる。

## 5. 適用予定の最初の変更 (PR-Y、歴史記録)

> **位置づけ**: 本節は **ADR 受理時点での最初の運用例** の歴史記録であり、PR-Y マージ後の `MIGRATIONS` 一覧の **一次ソースは `data-model.md` §14.4** に置く (ADR の追記専用ポリシーと、表メンテの容易性を両立するため)。今後の v2 → v3 等の追加は §14.4 のみを更新し、本節は書き換えない。

> **bump 注記**: 本 ADR 受理時点では `src-tauri/src/storage/schema.rs::CURRENT_DB_SCHEMA_VERSION` は **`1` のまま未反映**。実装 PR-Y で 1 → 2 に bump する。

本 ADR の最初の運用例として PR-Y で以下を投入する:

```sql
-- MIGRATIONS[0]: from_version=1, to_version=2 (items D&D 並び替え対応、PR-Y)
ALTER TABLE items ADD COLUMN position INTEGER NOT NULL DEFAULT 0;

-- 新規 INDEX (project / module 内の position ソート用)
CREATE INDEX idx_items_project_module_position
  ON items (project_id, module_id, position, updated_at DESC, id DESC);

-- §2.3 規約: 各 Migration tx の末尾で必ず db_schema_version を bump する
UPDATE meta SET value = '2' WHERE key = 'db_schema_version';
```

注記:

- `ALTER TABLE items ADD COLUMN position INTEGER NOT NULL DEFAULT 0` は SQLite ≥ 3.35 で **物理書込みを伴わず** 実行できる (sqlite_master 上の記述変更で対応、行数に依らず O(1))。bundled SQLite (rusqlite 0.39) は 3.46+ を含むため安全
- 既存 `idx_items_project_module_updated` は ADR-0011 §2.2 により **DROP できないので残す**。query planner は新 index を優先するため実害は無いが、index 維持コストがわずかに増える
- 新規 DB は `SCHEMA_DDL` のみで立ち上がり、本 migration は走らない (`SCHEMA_DDL` 側を同時に更新する)

詳細は `data-model.md` §6.1 (DDL 更新) / §6.5 (新規節「position カラム」) / §14.4 (マイグレーション一覧の一次ソース) / PR-Y を参照。

## 6. Open questions (将来 ADR で扱う)

- マイグレーションが **大量データ** (10 万件超) で長時間化した場合のキャンセル / 進捗表示
  - Phase 1 規模 (個人ツール = 数千件想定) では問題化しないため、本 ADR では扱わない
- `MIGRATIONS` 配列が肥大化した時の「畳み込み」(初期 DB DDL に古い migration の結果を取り込んで、古いエントリを消す手順)
  - **20 件超** または **旧 schema をローカルで再現するのが面倒になった PR が出てきた** タイミングで別 ADR を切る。年 1-3 件想定のペースで 7-10 年分が目安
- `Migration` の `fn(&Transaction)` 形式の必要性
  - Phase 1 は `sql: &'static str` のみ。複雑な ALTER シーケンス (例: PRAGMA 変更を絡める) が必要になったら別 ADR

## 7. 本 ADR の改訂パス

`§2.1` (許可枠) / `§2.2` (禁止枠) を **広げる / 縮める** 必要が出た場合は、**新 ADR で本 ADR を supersede する** (CLAUDE.md §作業時のルール「ADR は追記専用、覆すなら supersede」に従う)。本 ADR §2 本文は書き換えない。受理済 §5 は歴史記録として残し、`data-model.md` §14.4 の一覧を一次ソースとして更新を続ける。
