# ADR-0006: payload バージョニング (Eager-on-Read 方式)

- **Status**: Accepted
- **Date**: 2026-04-30
- **Deciders**: zredjet
- **Related**: `requirements.md` D-03 / D-11 / E-04 / `data-model.md` §7 / `module-contract.md` §3 / §7

---

## 1. Context

各モジュールは items テーブルの `payload` カラムにモジュール固有の JSON を格納する (ADR-0004)。
モジュールがアプリの版を重ねるごとに payload の構造を進化させたくなる:

- M-Prompt v1: `{ body }` のみ
- M-Prompt v2 (将来): `{ body, default_variables }` のように属性追加
- M-LinkMemo v1 → v2 で `target` の URL 正規化アルゴリズムを変える
- など

このような payload の構造変化を、**コア DB スキーマを変えずに / 起動時の一括マイグレーションを発生させずに / ユーザーデータを破壊せずに** 吸収する方式を確定する。

選定に効く制約:

| 制約 | 趣旨 |
|------|------|
| データ移行不要原則 (D-03) | アプリ版アップで起動時マイグレーションを発生させない |
| コア起因のマイグレーション禁止 (E-04) | モジュール都合の payload 変更でコア DB スキーマは触らない |
| `search_text` の整合性 (D-12 / data-model.md §6.4) | payload を変えると search_text の生成元も変わるため、両者が同期している必要がある |
| 排他制御 (data-model.md §13.7) | 読み取りも StorageService 経由で起こり、書き込みは writer mutex で直列化 (writer mutex 保持中はキャンセル不可、ADR-0009 §7.2) |
| バックアップ判定との独立 (data-model.md §13.2) | 自動アップグレードによる書き換えは `data_revision` を増やさない (ユーザー編集ではないため) |
| ユーザー体感 | 起動時の長い「マイグレーション中…」スピナーを発生させない |

## 2. Decision

| 項目 | 採用 |
|-----|------|
| バージョン管理単位 | items 行 1 件に `payload_schema_version: INTEGER` カラムを持たせ、行ごとに記録 |
| 起動時の一括マイグレーション | **行わない** |
| 移行発火タイミング | **行を読み込んだ瞬間に、必要ならその行を最新版へアップグレードして UPDATE する** (Eager-on-Read 方式) |
| アップグレード関数 | モジュールが `upgrade_payload(from_version, payload) -> Result<JsonValue>` を提供。**1 段階ずつ**のアップグレード関数を書き、StorageService が現行版まで順次チェイン |
| 失敗時の取扱い | アップグレード失敗 (バリデーション失敗 / アップグレード関数例外 / UPDATE 失敗 / 未来バージョン検出) は `AppError::PayloadUpgradeFailed` 系で呼び出し側に伝播。**勝手に書き換えない / 削除しない** |
| `data_revision` への影響 | 自動アップグレードでは**増やさない** (ユーザー編集ではないため) |
| 検索インデックス再構築 | 管理コマンド `core_rebuild_search_index(module_id?)` を提供。Eager-on-Read を全行に強制発火させる |

詳細仕様は data-model.md §7 / module-contract.md §7 を正とする。本 ADR は**選定の根拠と却下した代替案**、および以下 §2.1〜2.5 で**実装時に守るべき副次的決定**を記録する。

### 2.1 楽観的並行制御 (Optimistic Concurrency)

writer mutex は同時書き込みを直列化するが、**古い読み取り結果に基づく二重アップグレード**までは自動では防がない。

具体例:
```
Command A: items 行 X を v1 で読み込み
Command B: items 行 X を v1 で読み込み (まだアップグレード前)
Command A: writer mutex 取得 → v2 として UPDATE → 解放
Command B: writer mutex 取得 → v2 として UPDATE (古い v1 ベース) → 解放
```

このまま走らせると、Command B が「自分の知っている v1 から v2 への変換結果」で上書きするため、Command A の結果が破壊されるリスクがある。

**対応**: Eager-on-Read の UPDATE は **元バージョン番号を WHERE 条件**に含める楽観的並行制御を行う:

```sql
UPDATE items
SET payload = ?,
    search_text = ?,
    payload_schema_version = ?  -- 新版
WHERE id = ?
  AND payload_schema_version = ?  -- 元バージョン (読み込み時の値)
```

- `rows_affected == 0` の場合: 他の処理 (Command A) が先にアップグレード済み
- 対応: 最新行を**再読み込み**し、必要なら再度アップグレード経路に入る (既に最新版ならそのまま返す)
- 再読み込み時に再度衝突する可能性は無い (writer mutex 内で再 UPDATE するため)

### 2.2 二系統の内部更新 API

StorageService 内部で「ユーザー編集」と「Eager-on-Read 自動更新」を**実装レベルで明確に分離**する。これは「Eager-on-Read は updated_at を触らない / data_revision を増やさない」という意味論を**ヒューマンエラーで破らない**ための分離。

| 内部 API | 更新カラム | data_revision | 用途 |
|--------|---------|--------------|-----|
| 通常更新 (`update_item`) | `payload` / `search_text` / `updated_at` | **+1** | ユーザー編集経路 |
| Eager-on-Read 内部更新 (`upgrade_item_inplace`) | `payload` / `search_text` / `payload_schema_version` のみ | **+0** (増やさない) | 自動アップグレード専用 |

Eager-on-Read 内部更新 API は **StorageService 内部のみで呼び出せる** 可視性 (例: `pub(crate)`) にし、モジュールや Tauri コマンドからは触れないようにする。

### 2.3 検索インデックス再構築管理コマンドと pre-op backup

`core_rebuild_search_index(module_id?)` は指定モジュール (省略時は全モジュール) の全行に Eager-on-Read を強制発火させる管理コマンド。

通常の Eager-on-Read 単一行とは規模が違うため、**実行前に pre-op backup を必ず取得**する:

- 命名 prefix: `pre-rebuild-search-index-<module_id>`
- data-model.md §13.4 (破壊的操作直前バックアップ) のリストに追加
- `data_revision` 自体は増やさない (Eager-on-Read の意味論に揃える)
- 実行中は進捗表示。ユーザー操作で発火 (黙ってバックグラウンド実行しない)

### 2.4 payload version 上昇時の検索インデックス再構築通知 UX

Eager-on-Read の弱点として「読まれていない行は古い search_text のまま」がある。検索でヒットしないため詳細を開く動線も無く、結果として永久に古いままという循環が起こり得る。

**対応**: payload version が上がったタイミングを検出し、ユーザーに**再構築を推奨する通知**を出す。

- 各モジュールごとに「最後に観測された payload version」を `settings.json` の `modules.<id>.last_seen_payload_version` に保存 (data-model.md §11)
- アプリ起動時 / 該当モジュール画面初回表示時に、`module.current_payload_version()` と比較
- 不一致 (上昇) を検出したら、トーストや常時通知バナーで「このモジュールの payload version が上がりました。検索インデックスの再構築を推奨します」を表示
- 通知 UI から `core_rebuild_search_index(module_id)` を起動できる導線を置く
- ユーザーが実行 / 却下したら `last_seen_payload_version` を更新して通知を消す
- **自動実行はしない**

### 2.5 エクスポート時の挙動

エクスポート (アプリ全体 / プロジェクト単位、D-05) は StorageService の高レベル読み込み API を通すため、**古い payload を含む items は Eager-on-Read により自動的に最新版へ更新された上でエクスポート出力**される。

- 結果として、エクスポート JSON 内の `payload_schema_version` は該当モジュールの現行版に揃う (data-model.md §12)
- 大量件数の場合は **進捗表示**を UI に出す
- **pre-op backup は取らない** (個別 UPDATE が独立トランザクション + idempotent なので、export 中の中断は data の一貫性を損なわない)
- 古い payload で「アップグレード失敗」となる行はスキップ集計に加える (`module-contract.md` §7.3 と同じ振る舞い)

## 3. Alternatives Considered

### 3.1 Lazy Migration on Read (純粋遅延)

「読み込み時にメモリ上で payload をアップグレードして返すが、DB は書き換えない」方式。

| 評価 |
|-----|
| アプリは常に「読み込み時に最新版オブジェクトを得る」点では Eager-on-Read と同じ |
| ❌ **`search_text` が古いまま残る** — search_text は payload 由来 (`index_text(payload)` で生成) であり、payload を変えると search_text も変わる必要がある。DB を書き換えない方式では「データは新版で扱われるが検索インデックスは旧版のまま」という不整合が常時発生する |
| ❌ 検索結果の一貫性が崩れる: 一度も読まれていない行は古い search_text のまま残り、新版でヒットすべきキーワードがヒットしない |
| ❌ payload version の表示一貫性も部分的: ある行は読まれて新版で扱われ、別の行は古いまま、という状態が UI に出る |

**却下**。data-model.md レビューで指摘され、Eager-on-Read への切替が確定した経緯あり。

### 3.2 起動時一括マイグレーション (Eager Bulk Migration on Startup)

アプリ起動時に「現行 payload バージョンより古いすべての行」を一斉に変換して書き戻す方式。

| 評価 |
|-----|
| ✅ 起動後はすべての行が最新版に揃っているので、整合性問題が起きない |
| ❌ **D-03 (データ移行不要原則) を破る**: 「アプリ更新時にマイグレーション中…のスピナーが回る」体験になる |
| ❌ items 件数 N に対して起動時間が線形に増える。10 万件規模で起動が分単位に伸びる懸念 |
| ❌ アップグレード途中でクラッシュした場合の中途半端な状態のリカバリ設計が複雑 (どの行まで進んだか / 部分的にロールバックするか) |
| ❌ ユーザーが触ってもいない古い行まで強制的に書き換えるため、`data_revision` も全行ぶん増やす必要があり、バックアップ戦略 (§13.2) と相性が悪い |

**却下**。要件 D-03 と本質的に相容れない。

### 3.3 バージョンを持たない (Schemaless / Best Effort)

payload に version を持たせず、各モジュールが「想定外フィールドは無視」「不足フィールドはデフォルト埋め」で吸収する方式。

| 評価 |
|-----|
| ✅ 実装シンプル |
| ❌ **payload の進化履歴が追えない**: 「v1 のフィールド名から v2 でリネームした」のような変更が事実上不可能 (どの行が v1 でどの行が v2 か区別できないため) |
| ❌ デバッグ時に「この行は古いフォーマットで保存された」と判定できない |
| ❌ `index_text()` の出力意味が版間で変わるとき、search_text の整合性を取る術がない |
| ❌ 進化していくモジュール開発において、版違いのバグが発生したときに調査が極端に困難 |

**却下**。短期的な簡易性のために将来の保守性を捨てる選択。

### 3.4 Eager-on-Write (書き込み時アップグレード) のみ

「読み込み時はそのまま、書き込み時 (UPDATE) のときだけアップグレード」方式。

| 評価 |
|-----|
| ✅ 自動的な書き戻しは UPDATE フローに統合される |
| ❌ 「ユーザーが触らない行は永久に古い版のまま」になる。3.1 (Lazy) と同じ search_text 整合性問題が残る |
| ❌ Eager-on-Read のサブセットでしかなく、独自の利点が無い |

**却下**。

### 3.5 Eager-on-Read (本 ADR の採用案)

| 評価 |
|-----|
| ✅ 起動時マイグレーション無し (D-03 / E-04 を満たす) |
| ✅ 読み込まれた行は payload と search_text を**常に最新版に揃える** (整合性が取れる) |
| ✅ 書き換え負荷は読み込み発生のたびに分散。N 行のモジュールで最大 N 回の単一行 UPDATE で収束 |
| ✅ クラッシュ耐性: 個々の UPDATE が独立トランザクション。中途半端な状態が永続化されない |
| ❌ 「読み込みが書き込みを引き起こす」副作用 (詳細は data-model.md §7.2 / §7.6 で文書化) |
| ❌ 一度も読まれていない行は古いまま残る → 全行強制最新化のための管理コマンドが必要 (§2 で対応済) |

**採用**。

### 3.6 比較表

| 軸 | Lazy | 起動時一括 | バージョンなし | Eager-on-Read | Eager-on-Write |
|----|------|---------|---------|---------------|----------------|
| 起動時間への影響 | ◎ | × | ◎ | ◎ | ◎ |
| search_text 整合性 | × | ◎ | × | ◎ | × |
| データ移行不要 (D-03) | ◎ | × | ◎ | ◎ | ◎ |
| 読み書きの単純性 | ◎ | ◎ | ◎ | △ (読み中に書き発生) | ○ |
| クラッシュ耐性 | ◎ | × (中途半端な状態) | ◎ | ◎ | ◎ |
| 進化履歴の追跡可能性 | ◎ | ◎ | × | ◎ | ◎ |

→ Eager-on-Read が最もバランスが良い。

## 4. Consequences

### 4.1 Positive
- **起動時にマイグレーションが走らない** ため、ユーザーは「アプリを更新したら開けない / 待たされる」体験をしない
- **search_text の整合性が常に取れる** — 読まれた行は payload + search_text が同じバージョンに揃う
- **モジュール開発者の負担が小さい** — 1 段階ずつのアップグレード関数を書くだけで、過去版すべてからのチェインは StorageService が処理
- **クラッシュに強い** — 個別 UPDATE が独立トランザクションなので、中断しても DB は一貫した状態を保つ
- **`data_revision` を増やさない**ため、バックアップ判定 (§13.2) と独立。Eager-on-Read だけが大量発火しても auto バックアップ判定が狂わない

### 4.2 Negative / Risks
- **「読み込みが書き込みを引き起こす」**副作用がある。読み取り専用想定のコードパスでも UPDATE が走る可能性
  - 対策: アップグレードが起こるのは StorageService の高レベル「読んでアプリへ返す」API のみ。集計 / 検索のような low-level 経路は payload を解凍せず走らせアップグレードを発火させない (data-model.md §7.2)
- **読まれていない行は古いまま** — 検索でヒットしない場合がある (新版 `index_text` で生まれる新キーワードが旧 search_text に入っていない)
  - 対策: 管理コマンド `core_rebuild_search_index(module_id?)` で全行に Eager-on-Read を強制発火可能 (UI から実行)
- **未来バージョンの検出** — 新版アプリで作ったデータを旧版アプリで開いた場合、`payload_schema_version > current_payload_version()` となる
  - 対策: `AppError::UnsupportedFuturePayloadVersion` を返す (`module-contract.md` §7.3)。ダウングレードはしない
- **アップグレード関数の品質依存** — モジュール開発者がアップグレード関数を書き間違えると、データが破壊される可能性
  - 対策: 結合テスト + アップグレード関数は冪等であること (テスト規約) + 失敗時は元のデータに戻す `AppError::PayloadUpgradeFailed`

### 4.3 Neutral
- payload version を行ごとに持つため、**異なる版が同居**する状態が常時発生する。これは設計の前提として受け入れる
- 検索インデックスが部分的に古くなる可能性は、アクセスされる行から自然に解消される

## 5. Mitigations

| リスク | 対策 |
|-------|------|
| 読み込みが書き込みを誘発 | StorageService の高レベル API でのみ Eager-on-Read を発火。低レベル / 集計クエリは payload に触らない設計 (data-model.md §7.2) |
| 古い行が search 結果から漏れる | 管理コマンド `core_rebuild_search_index` で強制最新化を提供。設定画面から起動可能 |
| 未来バージョン検出 | `AppError::UnsupportedFuturePayloadVersion` で旧版アプリは安全に止まる。ユーザーには「アプリを最新版に更新してください」を案内 (`module-contract.md` §7.3) |
| アップグレード関数のバグ | (1) 結合テスト必須 (2) 冪等性をテストで担保 (3) アップグレード後 `validate_payload()` を必ず通す (4) 失敗時は元データを保持し AppError 返却 |
| Phase 1 で payload バージョンを上げる経験が無い | M-Prompt v1 → v2 のシナリオで結合テストを 1 件以上書き、アップグレードチェインが動く実証を Phase 1 期間中に行う |

## 6. Validation Criteria

Phase 1 で以下を検証する:

- 古い payload (v1) を含む items を新版 (v2) アプリで読み込むと、payload + search_text が v2 に変換され `items` 行が UPDATE されること (data-model.md T-05)
- 同じ行を再度読み込むと追加の UPDATE が発生しないこと (T-06)
- アップグレード関数が失敗 / `validate_payload` が失敗した行は、items 行が元のまま保持され AppError が返ること (T-19 / §7.6)
- 起動時に「マイグレーション中…」のような UI 待ち時間が発生しないこと
- Eager-on-Read による UPDATE は `data_revision` を増やさないこと (T-24)
- 管理コマンド `core_rebuild_search_index` が指定モジュールの全行を最新化すること
- 未来バージョン (現行 + 1) を持つ行を読むと `AppError::UnsupportedFuturePayloadVersion` が返ること

## 7. Known Concerns / 将来見直しが要りうる判断

#### 7.1 アップグレードチェインの長期化

- payload version が v1 → v10 のように長くなった場合、最古行を読んだときに 9 段階のアップグレードがチェインで走る
- **懸念**: 読み込み 1 回あたりの遅延が大きくなる (10 段階 × 関数呼び出しオーバーヘッド)
- **対応**: 個人ツールで 10 段以上の進化が起きるのは年単位の話。顕在化したら「最古版から最新版への直接アップグレード関数」を追加する選択肢を取る (アップグレード関数を `from_version: u32` 引数で分岐させる契約は維持)
- 監視: payload version が 5 を超えたモジュールが出たら本 ADR を 1.x で改訂

#### 7.2 並行アップグレードの排他 (§2.1 で対応済)

writer mutex は「**古い読み取り結果に基づく二重アップグレード**」までは防がない。

- 例: Command A / B が同じ行を v1 で読み、A が v2 に書いた後、B が手元の v1 ベースで v2 に書こうとする
- 対応 (§2.1): UPDATE に `WHERE payload_schema_version = ?` の楽観的並行制御を含める。`rows_affected == 0` で再読み込みする
- 残懸念: 再読み込み再試行が無限ループする可能性は writer mutex により無い (再 UPDATE 中は他の書き込みが入らない)

#### 7.3 「Eager-on-Read 中の表示順揺れ」

- 一覧表示中に Eager-on-Read が走ると、`updated_at` は変わらない (D-11 規約) ので順序は安定するはず
- **対応**: 規約として「Eager-on-Read による UPDATE は `updated_at` を触らない」(data-model.md §7.2) を遵守。テストで担保

#### 7.4 アップグレード失敗のユーザー通知 UX

- 一覧画面で破損項目をマーカー表示する仕様 (`module-contract.md` §7.3 / data-model.md §7.6) はあるが、Phase 1 では設計のみで具体 UI は未定
- **対応**: 実装時に最小実装 (アイコン + 「破損」バッジ) を入れる。設定画面に「破損項目一覧」管理画面を持つ規定 (§7.6) もある

## 8. References

- 要件: `docs/requirements.md` D-03 / D-11 / E-04
- データモデル: `docs/data-model.md` §6.1 (`payload_schema_version` カラム) / §7 (Eager-on-Read 詳細) / §15 (整合性テスト T-05 / T-06 / T-19 / T-20 / T-24)
- モジュール契約: `docs/module-contract.md` §3 (ModuleBackend trait) / §7 (バージョン進化フロー)

## 9. 改訂履歴

| 日付 | 版 | 内容 |
|------|----|------|
| 2026-04-30 | 1.0 | 初版ドラフト |
| 2026-04-30 | 1.1 | レビュー反映: §2.1 に楽観的並行制御 (UPDATE WHERE 句にバージョン条件 + rows_affected==0 で再読み込み) を追加 / §2.2 に通常更新 API と Eager-on-Read 内部更新 API の二系統分離を明記 / §2.3 で `core_rebuild_search_index` に pre-op backup 取得を必須化 / §2.4 に payload version 上昇時の検索インデックス再構築推奨 UX (`modules.<id>.last_seen_payload_version` 比較) を追加 / §2.5 にエクスポート時の Eager-on-Read 自動発火 + 進捗表示を明記 / §7.2 の並行排他 KC を §2.1 への参照ベースに書き換え (Accepted) |
| 2026-04-30 | 1.2 | ADR-0009 受理反映: §1 の writer mutex 制約行に「writer mutex 保持中はキャンセル不可、ADR-0009 §7.2」の参照を 1 行追記 |
