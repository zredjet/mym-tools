# ADR-0003: SQLite アクセス層 (rusqlite + bundled SQLite + FTS5 trigram)

- **Status**: Accepted
- **Date**: 2026-04-29
- **Deciders**: zredjet
- **Related**: ADR-0001 (Tauri v2) / `requirements.md` D-10 / D-11 / D-12 / `data-model.md` §2 / §6 / §8 / §13

---

## 1. Context

データ永続化レイヤを構成する以下の要素を確定させる:

1. **DB エンジン**: SQLite を採用済 (`requirements.md` D-10 で確定済 — 個人ローカルツールに最適)
2. **Rust 側ライブラリ**: rusqlite を採用済 (D-10 で確定) — 本 ADR で正式に選定理由・依存バージョン・有効化機能を確定する
3. **SQLite 本体の供給方法**: バンドル (Rust が同梱) か、システム提供のものを使うか
4. **全文検索エンジン**: SQLite FTS5 を採用済 (D-12) — 本 ADR でトークナイザを正式確定する
5. **トークナイザ**: 日本語含む全文検索の実用化方針 (`data-model.md` §8.1 で trigram を仮選定)
6. **接続モデル**: 単一接続 / 単一ライタ + リーダープール / etc
7. **WAL モードと PRAGMA**: 既に `data-model.md` §2 で骨子は確定。本 ADR で値とともに整理

選定の制約:

| 制約 | 趣旨 |
|------|------|
| 軽量性 | バイナリサイズ・メモリ常駐の制約 (D-... / `architecture.md` §3) |
| 個人ローカルツール | 単一プロセス・単一ユーザー前提。同時接続多重化は不要 |
| Tauri 配布 | クロスプラットフォーム (Win/Mac) で同一バイナリが動くこと |
| 全文検索が日本語に効く | 形態素解析を導入せずに動くこと (依存最小化) |
| Online Backup API 利用 | rusqlite の `backup` サブモジュールが必要 (`data-model.md` §13.1) |
| FTS5 + trigram 利用 | SQLite ≥ 3.34 が必須 |

## 2. Decision

| 項目 | 採用 |
|-----|------|
| Rust 側ライブラリ | **`rusqlite`** `^0.39.0` |
| rusqlite Cargo features | `["bundled", "backup"]` |
| SQLite 本体 | **bundled** (rusqlite が同梱する最新版を使用、0.39 系で SQLite 3.50+ を同梱) |
| FTS5 | **有効** (rusqlite bundled に含まれる) |
| FTS5 トークナイザ | **`trigram`** (data-model.md §8.1 の仮選定を本 ADR で正式確定) |
| トランザクション制御 | StorageService が writer mutex で直列化 (data-model.md §13.7) |
| 接続モデル | **書込用 1 接続 + 読取用プール (size 2、initial)** |
| Journal mode | `WAL` |
| PRAGMA `foreign_keys` | `ON` (起動時 / 各接続作成時に必ず発行) |
| PRAGMA `synchronous` | `NORMAL` |
| PRAGMA `temp_store` | `MEMORY` |
| PRAGMA `mmap_size` | 環境依存だが既定で 64MB を試行 (Phase 1 で実測調整) |
| 非同期境界 | rusqlite は sync API。Tauri コマンド側で `tauri::async_runtime::spawn_blocking` を使って Tokio ランタイムから外す |

### 2.1 Cargo features の意図

```toml
# src-tauri/Cargo.toml (抜粋)
rusqlite = { version = "^0.39.0", features = ["bundled", "backup"] }
```

- **`bundled`**: SQLite C ソースを Rust ビルド時にコンパイルして同梱。OS のシステム SQLite に依存しないため、Win/Mac で同一動作を保証。FTS5 + trigram トークナイザ含む完全構成
- **`backup`**: SQLite Online Backup API を呼び出すサブモジュール (`rusqlite::backup`) を有効化。data-model.md §13 の DB バックアップ機構に必須

採用しない feature:
- `bundled-sqlcipher`: 暗号化は要件外 (個人ローカルツール、要件 §3.7)
- `serde_json`: payload は文字列 TEXT として渡し、アプリ側でシリアライズ済の JSON 文字列を扱う方針 (StorageService 層で `serde_json` を使うが、rusqlite の feature としては不要)
- `time` / `chrono`: 時刻は **JST ISO8601 文字列** (D-14) で TEXT カラムに保存するため、rusqlite の自動変換は不要

### 2.2 接続モデル詳細

```
┌─────────────────────────────────────────────────────────┐
│                  StorageService                          │
│                                                          │
│  ┌──────────────────────┐  ┌─────────────────────────┐  │
│  │ Writer Connection     │  │ Reader Pool             │  │
│  │ Arc<Mutex<Connection>>│  │ - Semaphore(N)          │  │
│  │                       │  │ - Vec<Arc<Mutex<Conn>>> │  │
│  │ writer mutex で       │  │   各 Connection は      │  │
│  │ 直列化 (§13.7)        │  │   個別 Mutex で独立      │  │
│  └──────────────────────┘  └─────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
        ↓ 全接続が同じ DB ファイルを参照
        ↓ WAL モードで読みは書きと並行可能
                  ↓
              data.sqlite (+ -wal, -shm)
```

- **Writer Connection**: INSERT / UPDATE / DELETE / DDL 用。`Arc<Mutex<Connection>>` で 1 個。Tauri コマンドはこれを通じて直列に書き込む
- **Reader Pool**: SELECT 専用。初期 size 2 (Phase 1)
- **Restore 時の挙動**: 全接続を閉じ、`-wal` / `-shm` ファイルを削除してから上書き。アプリ再起動 (data-model.md §13.6)

#### Reader Pool の構造 (重要)

接続プールを `Arc<Mutex<[Connection; N]>>` のように**配列ごと 1 つの Mutex** で守ると、せっかく N 本接続を持っても Mutex で読み取りが直列化されプールの意味が消える。
正しい設計は **「各 Connection に独立した Mutex」+「全体の貸出枠を Semaphore で管理」**:

```rust
use std::sync::Arc;
use tokio::sync::{Mutex, Semaphore, OwnedMutexGuard, OwnedSemaphorePermit};

pub struct ReaderPool {
    readers: Vec<Arc<Mutex<Connection>>>,  // 各 Connection は独立した Mutex
    permits: Arc<Semaphore>,                // 同時貸出数 = readers.len()
}

pub struct ReaderGuard {
    _permit: OwnedSemaphorePermit,           // drop で permit 返却
    pub conn: OwnedMutexGuard<Connection>,   // drop で Mutex 解放
}

impl ReaderPool {
    pub async fn acquire(&self) -> ReaderGuard {
        // 1. 貸出枠を確保 (枠が無ければ待機)
        let permit = self.permits.clone().acquire_owned().await.unwrap();
        // 2. 空いている Connection を見つけて占有 (permit が取れた以上、必ずどこかが空く)
        for reader in &self.readers {
            if let Ok(conn) = reader.clone().try_lock_owned() {
                return ReaderGuard { _permit: permit, conn };
            }
        }
        unreachable!("permit acquired but no reader is free; invariant broken");
    }
}
```

**この構造の意図**:
- `permits.len() == readers.len()` を不変条件として維持する。permit を取れた = どこかの reader が必ず空く
- 各 reader が**独立した Mutex** なので、SELECT 同士は並行に走る
- ガード型 (`ReaderGuard`) を返すことで、permit と Mutex ロックを drop ベースで安全に返却
- WAL モード下で writer transaction 中でも reader pool は影響を受けず読み込めるという rusqlite + SQLite の特性を活かせる

#### プール実装の最終選択

- `deadpool-sqlite` 等の汎用クレートでも上記と同等の構造になっている
- Phase 1 着手時に: ① 上記の手書き実装 (約 50 行) で済ませる / ② deadpool-sqlite を依存に追加する のどちらにするかを再評価する
- 実装規模・依存追加コスト・ヘルスチェック等の追加機能要否で判断 (Known Concerns §7.1)

### 2.3 PRAGMA 適用タイミング

```rust
// 概念コード: 各接続作成直後に発行する
fn configure_connection(conn: &Connection) -> Result<()> {
    conn.execute_batch(r#"
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;
        PRAGMA synchronous = NORMAL;
        PRAGMA temp_store = MEMORY;
        PRAGMA mmap_size = 67108864;  -- 64MB
    "#)?;
    Ok(())
}
```

- `journal_mode = WAL` は **DB 全体の永続設定** (一度設定すれば DB ファイルに記録される)
- `foreign_keys = ON` は **接続単位の設定** (各接続で再発行が必須)
- 上記は writer / reader どちらの接続にも適用する

## 3. Alternatives Considered

### 3.1 Rust SQLite クライアント

| 候補 | 評価 |
|-----|------|
| **rusqlite (採用)** | C SQLite 直接バインディング。FTS5・custom tokenizer・Online Backup API 等の機能に直接アクセス可。同期 API。Bundled feature でクロス環境統一 |
| sqlx | 非同期ファースト、コンパイル時クエリ検証 (`sqlx::query!`) が魅力。ただし: ① コンパイル時検証は **DB 接続** または **offline mode** が要り、CI 設計が複雑化 / ② FTS5 や trigram の柔軟な利用は rusqlite ほど自然でない / ③ 個人ツール規模でコンパイル時検証の利得が小さい |
| diesel | 型安全 ORM だが、JSON ペイロードのような半構造化データに対するメリットが薄い。個人ツール規模で ORM レイヤを 1 段増やすコストに見合わない |
| sea-orm | 同上。モダンな ORM だが本プロジェクトの「items + JSON ペイロード」設計に対しオーバーキル |

→ **rusqlite 採用**。SQLite の機能を直接的に・軽量に・予測可能に扱えることを最優先。

### 3.2 SQLite 本体の供給方法

| 候補 | 評価 |
|-----|------|
| **bundled (採用)** | rusqlite ビルド時に SQLite C ソースを同梱コンパイル。Win/Mac/Linux で同じバージョンが走る。FTS5・trigram・JSON1 等の機能組み合わせを担保できる |
| システム提供 (link to system) | macOS の system SQLite は古い場合がある (FTS5 trigram tokenizer は SQLite 3.34+ 必須)。Windows ではそもそもシステム SQLite が無い |
| 別途同梱バイナリ + 動的ロード | Tauri のサンドボックスとアプリ配布の整合性が複雑化 |

→ **bundled 採用**。クロスプラットフォーム動作保証のため。バイナリサイズ増 (~1MB 前後) は許容範囲。

### 3.3 FTS5 トークナイザ

| 候補 | 評価 |
|-----|------|
| **`trigram` (採用)** | 文字 3-gram でインデックス。日本語・英語・任意言語を等しく扱える。形態素解析依存ゼロ。インデックスサイズが大きめ (約 3〜5 倍) になる難点はあるが個人規模では許容 |
| `unicode61` | Unicode 単語境界トークナイザ。英語等は良好だが、日本語のように単語境界が空白で示されない言語に対しては部分一致検索が機能しない |
| 形態素解析 (MeCab + lindera 等) 統合 | 日本語精度は最高だが、辞書サイズ (10〜50MB) と外部依存の追加が要件 (軽量性 / 依存最小化) と合わない |
| `porter` (英語ステミング) | 日本語非対応。本ツールは日本語前提のため不可 |

→ **trigram 採用** (data-model.md §8.1 で仮選定 → 本 ADR で正式確定)。インデックス肥大が顕在化した場合の逃げ道 (external content / unicode61 へのフォールバック) は data-model.md §8.1 で既に文書化済み。

### 3.4 接続モデル

| 候補 | 評価 |
|-----|------|
| **Writer 1 + Reader Pool (採用)** | WAL モードのメリット (読みと書きの並行) を活かせる。個人ツール規模で必要十分 |
| 単一接続 (Mutex で全直列化) | 最小実装だが、UI で長めの読み込みクエリが走っているときに書き込みが詰まる |
| 接続毎にトランザクション (`r2d2-sqlite` 同等の透過プール) | Phase 1 で必要なし。書き込みの直列化保証 (D-12 / §13.7) と相性悪い (writer mutex を別管理する必要が出る) |

→ **Writer 1 + Reader Pool 採用**。

## 4. Consequences

### 4.1 Positive
- rusqlite + bundled SQLite で **Win/Mac で SQLite 3.45+ が同一バージョンで動作**。FTS5 trigram tokenizer も保証
- `backup` feature により Online Backup API が直接使え、data-model.md §13 のバックアップ設計が機能する
- ORM レイヤを噛まさないため、SQL の最適化やインデックスの利用状況がコードから直接見え、性能トラブルシューティングが容易
- 同期 API なので「rusqlite の関数を spawn_blocking で囲む」というシンプルなパターンで非同期境界が成立する
- writer mutex + reader pool でデータ整合性 (D-12) と読み取り並行性の両立

### 4.2 Negative / Risks
- **rusqlite は同期 API**: Tokio ランタイム上で直接呼ぶとスレッドをブロックする。`spawn_blocking` を忘れずに使う規律が必要
- **bundled SQLite はビルド時に C コンパイラが必須**: Tauri の CI 環境で MSVC (Windows) / Clang (Mac) が要る。クロスコンパイルの追加設定がある場合がある
- **trigram インデックスサイズ**: コンテンツ量に対してインデックスが約 3〜5 倍に膨らむ。数十万件規模で顕在化する可能性 (data-model.md §6.6)
- **trigram は 3 文字未満の検索語をヒットさせられない**: SQLite 公式ドキュメントの通り、trigram tokenizer は 3-gram でインデックスを作るため、`MATCH` クエリで検索語が 3 文字未満のときは結果を返さない。「PR」「色」「@a」のような短い検索が一般的に想定される
- **接続プール導入で複雑度増**: 単一接続より状態管理が複雑になる。プール枯渇時のタイムアウト設計を持つ必要がある (Phase 1 では「待たせる方が安全」§13.7)
- **rusqlite のバージョンアップに伴う bundled SQLite バージョン変動**: マイナー版アップデートで SQLite 本体のバージョンが変わる可能性。リリース時には bundled SQLite バージョンを記録するべき

### 4.3 Neutral
- バックアップファイルが SQLite 標準形式なので、別の SQLite クライアント (sqlite3 CLI / DB Browser for SQLite 等) で開いて中身確認できる (data-model.md §13.8 README にも記載済)
- WAL モード採用により付随ファイル (`-wal`, `-shm`) が生まれる。バックアップとリストアのフローはこれを考慮済 (§13.6)

## 5. Mitigations

| リスク | 対策 |
|-------|------|
| `spawn_blocking` 忘れ | StorageService の高レベル API を必ず async fn にし、内部で spawn_blocking を使う設計を強制。モジュール側はそれを呼ぶだけ。直接 rusqlite を触らない (`module-contract.md` §6.2) |
| C コンパイラ要件 | CI 設定 (ADR-0008 配布で確定する) に Win: MSVC build tools / Mac: Xcode CLT のセットアップを明記 |
| trigram インデックス肥大 | Phase 1 で 1000 件程度のテストデータで実測。肥大が顕在化したら data-model.md §8.1 のフォールバック (external content / unicode61 切替) を起動 |
| **trigram で 3 文字未満の検索語が外れる** | Phase 1 では、検索語が 3 文字未満の場合のみ `title` / `tags` / `search_text` に対する **LIKE フォールバック**を検討する (FTS5 MATCH と LIKE を検索語長で切り替え)。LIKE は B-tree インデックスを使えないため遅いが、短い語の検索頻度・件数は限定的と想定。実装時に検索仕様 §8.x として data-model.md に追記 |
| プール枯渇のデッドロック | プールサイズを実装時に env var で調整可能にする。タイムアウトは設けず「待たせる」(§13.7) 方針で当面行く |
| bundled SQLite バージョン暗黙変動 | リリース時に rusqlite + bundled SQLite のバージョンを CHANGELOG / リリースノートに記載する運用ルールを作る |

## 6. Validation Criteria

Phase 1 終了時点で以下を確認する:

- DB ファイルサイズが、items 1000 件 (1 件あたり数 KB) 規模で 50MB 以下に収まること (trigram インデックス含む)
- プロジェクト内検索 / 横断検索のレスポンスが 100ms 以内 (UI 操作の体感範囲) であること
- writer mutex + reader pool の構成で、書き込み中に検索クエリが正常に走ること (data-model.md T-21)
- FK CASCADE による project 削除時の items 連鎖削除が確認できること (data-model.md T-01)
- Online Backup API による auto / pre-op / manual バックアップが機能すること (data-model.md T-13)

達成できない場合の対応:
- 性能未達 → インデックス追加 / クエリ書き換えで改善試行 (DB スキーマ変更は §14 例外運用)
- インデックス肥大 → トークナイザ切替 (本 ADR を 2.0 で改訂)
- 接続モデルがボトルネック → プールサイズ調整 / 構成変更 (本 ADR の 1.x 改訂)

## 7. Known Concerns / 将来見直しが要りうる判断

#### 7.1 deadpool-sqlite vs 手書きプール

- 本 ADR では Reader Pool に `deadpool-sqlite` を見込んでいるが、Phase 1 着手時に依存追加の必要性を再評価する
- **懸念**: 個人ツールで read pool size 2 程度なら、`Arc<Mutex<[Connection; 2]>>` 的な手書き実装でも十分かもしれない
- **判断軸**: deadpool 導入による依存追加 (数 100KB) と、その代わりに得られる「枯渇時の貸出待ち / ヘルスチェック / リサイクル」が個人ツール規模で本当に要るか
- **再評価のタイミング**: 接続管理を実装する最初のスプリント
- **代替**: 結果として手書きにする場合、本 ADR §2 の表を 1.x で更新

#### 7.2 trigram の代わりに ICU トークナイザを使う将来

- SQLite には `icu` トークナイザがあり、日本語含む CJK の単語分割を ICU ライブラリで行える
- **懸念**: trigram が肥大しすぎた / 検索精度が低すぎたとき、形態素解析を入れるよりは ICU が次の一手
- **対応**: 必要顕在化時に新 ADR を起こす。Phase 1 では選択肢として記録するに留める

#### 7.3 rusqlite のメジャーアップデート (0.x → 1.0)

- rusqlite はまだ 0.x 系列。1.0 リリース時には API 破壊的変更の可能性
- **懸念**: 1.0 がリリースされたら bundled SQLite バージョンと API 両方の影響が出る
- **対応**: メジャー版アップデートは ADR 改訂を要する (ADR-0002 と同じ運用ルール)。リリースノートを監視

#### 7.4 rusqlite を維持しつつ品質を担保するための規律

「コンパイル時クエリ検証で防げたバグが多発するから sqlx へ移行」を**第一選択にしない**。
代わりに、rusqlite を維持したまま品質を担保する以下の規律を初期から固定する。

**コアとなる規律 (3 つ、本 ADR の補足として確定)**:

1. **SQL は StorageService 内部に閉じ込める** — モジュールやその他コア層から SQL 文字列を書かない
2. **モジュールは StorageService の高レベル API だけを使う** — rusqlite を直接 import / 利用しない (`module-contract.md` §6.2 と整合)
3. **SQL を過剰に抽象化しない** — `StatementBuilder` 風のラッパや独自 query DSL は作らない。SQL 文字列は素朴に書き、可読性 > 抽象化を優先

**強化策 (品質担保のための運用)**:

- **DB 操作の結合テストを増やす**: items の CRUD / カスケード削除 / FTS5 同期 / payload upgrade を結合テスト (実 DB を temp file に作る) でカバー。data-model.md §15 の整合性テスト T-01〜T-25 をそのままテストコードに翻訳していく
- **代表クエリに `EXPLAIN QUERY PLAN` を使った確認を追加**: 検索クエリ・一覧クエリなど性能影響の大きいものは、ユニットテストに `EXPLAIN QUERY PLAN` の結果スナップショットを取り、実行計画の予期せぬ退化 (例: インデックス不使用への退化) を検出する
- **SQL レビュー時に「インデックス利用」「N+1」「N+M JOIN」をチェックリスト化** — 個人開発でもセルフレビュー時に意識する観点として明文化

**`sqlx` への乗り換えは最終手段**:

- 上記の規律と強化策で「コンパイル時検証が無くて困る」ケースが**年単位で蓄積**したときに、初めて sqlx 移行 ADR を起こす
- 移行コストは大きい (API が違うため StorageService 内部の SQL 呼び出し全て書き換え) が、規律により StorageService の境界が明確なら、外部 (モジュール / Tauri コマンド) には波及しない
- 結論: 「rusqlite で書きづらい」ことが移行理由にはならない。「rusqlite で書いた結果バグが頻発した」ことが移行理由になり得る

## 8. References

- ADR-0001 (Tauri v2)
- 要件: `docs/requirements.md` D-10 / D-11 / D-12
- データモデル: `docs/data-model.md` §2 (PRAGMA / WAL) / §6 (items) / §8 (FTS5 / trigram) / §13 (バックアップ) / §13.7 (排他制御)
- モジュール契約: `docs/module-contract.md` §5.1 / §6.2 (rusqlite 直接アクセス禁止)
- rusqlite: https://github.com/rusqlite/rusqlite
- SQLite FTS5 trigram: https://sqlite.org/fts5.html#the_trigram_tokenizer

## 9. 改訂履歴

| 日付 | 版 | 内容 |
|------|----|------|
| 2026-04-29 | 1.0 | 初版ドラフト |
| 2026-04-30 | 1.1 | レビュー反映: rusqlite バージョンを `^0.39.0` に更新 (bundled SQLite 3.50+) §2 / Reader Pool 設計を「全体 1 Mutex」から「Connection 個別 Mutex + Semaphore」方式に修正し並列性を確保 §2.2 / trigram tokenizer の 3 文字未満非ヒット制限を §4.2 / §5 に明記し、Phase 1 では LIKE フォールバックを検討する旨を Mitigations に追加 / §7.4 を「sqlx 移行検討」から「rusqlite を維持しつつ品質を担保する規律 (SQL を StorageService に閉じ込める / 高レベル API のみ / 過剰抽象化しない) と強化策 (結合テスト / EXPLAIN QUERY PLAN / SQL レビュー観点)」に書き換え。sqlx 移行は最終手段と位置付け (Accepted) |
