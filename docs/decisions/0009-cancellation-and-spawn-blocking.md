# ADR-0009: 重い処理の進捗通知 (Tauri Channel) / キャンセル機構 / `spawn_blocking` 使用規約

- **Status**: Accepted
- **Date**: 2026-04-30
- **Deciders**: zredjet
- **Related**: ADR-0001 (Tauri v2) / ADR-0006 (payload バージョニング) / ADR-0007 (ローカルバックアップ) / `requirements.md` §3.1 / `architecture.md` §3 / §11 / §14 (Q-15) / `module-contract.md` §5.2 / §6.1 / §6.2 / §12.4 / `data-model.md` §7.3 / §12.4 / §13.6 / §13.7

---

## 1. Context

M-Hash の大ファイルハッシュ計算 (MD5 / SHA-1 / SHA-256 / SHA-512 を数百 MB〜GB 級ファイルに対して実行) は数秒〜分のオーダで掛かりうる。`architecture.md` §11 はこれが **UI からキャンセル可能であること** を要求する。

加えて、Phase 1 内に同種の長時間処理が複数顕在化する:

| 処理 | 出典 | キャンセル要否 |
|------|------|----------------|
| M-Hash 大ファイルハッシュ | `architecture.md` §11 | 必須 (本 ADR の主目的) |
| エクスポート (大量 items の JSON 直列化) | `data-model.md` §12 / `architecture.md` §11 | 必須 (進捗 Event 規定済) |
| インポート (payload upgrade + validate + index_text の per-item 1tx ループ) | `data-model.md` §12.4 | 必須 (途中失敗時の続行と整合) |
| FTS5 全件再構築 (`core_rebuild_search_index`) | `data-model.md` §7.3 / ADR-0006 §13.4 | 必須 (起動後の任意操作) |
| バックアップからのリストア | `data-model.md` §13.6 | キャンセル要求は受付ける。ただし pre-op バックアップ取得後の writer トランザクション中は **実効キャンセル不可** (整合性のため完走待ち / §7.2) |
| Online Backup API でのバックアップ生成 | `data-model.md` §13.1 | 任意 (Online Backup は I/O 中もユーザー操作を妨げず UX 上のキャンセル要求が顕在化しないため Phase 1 では不要) |

これら全てに共通する **キャンセル機構の API 規約** と、`module-contract.md` §6.1 で「Q-15 で別途決定」とされた **`tauri::async_runtime::spawn_blocking` の使用規約** を本 ADR で確定する。

### 1.1 選定に効く制約

| 制約 | 出典 | 趣旨 |
|------|------|------|
| キャンセル可能 | `architecture.md` §11 | ファイルハッシュは UI からキャンセルできる |
| `spawn_blocking` で逃がす | `module-contract.md` §6.1 | 重い処理は各コマンド内で `tauri::async_runtime::spawn_blocking` 経由で実行 |
| 共有コンテキスト無し | `module-contract.md` §5.2 | `CoreContext` のような共有 trait を Phase 1 では持たない |
| 自前ランタイム禁止 | `module-contract.md` §6.2 | モジュールが独自スレッドプール / Tokio ランタイムを生成してはならない |
| トレイト dyn 互換 | `module-contract.md` §3.1 / §5.2 | generic method を持つ trait は `dyn` 化できないため、共有 API を generic にしない |
| writer mutex との整合 | `data-model.md` §13.7 | DB を伴うキャンセル可能操作 (export / import / restore) は writer mutex と矛盾しないこと |
| ステートレスモジュール (D-06) | `requirements.md` D-06 | M-Hash は items を持たないため StorageService を介さず固有 IPC のみで完結する |
| 軽量性 (3.1) | `requirements.md` §3.1 | 余計な依存追加は避けたい |
| オフライン動作 (3.4) | `requirements.md` §3.4 | キャンセル機構が外部サービス / ネットワークに依存しないこと |

### 1.2 選択肢の概観

| 候補 | キャンセルシグナル経路 | 進捗通知経路 |
|------|---------------------|------------|
| (A) Tauri Channel の drop 検出のみ | フロントが Channel を drop → Rust 側の次回 `send` がエラー → これをキャンセルとみなす | Tauri Channel |
| (B) **独自シグナル + Tauri Channel** | `tokio_util::sync::CancellationToken` + 専用 IPC コマンド `core_cancel_operation(operationId)` | Tauri Channel |
| (C) Tauri Event 双方向 | フロントが `cancel:<id>` を emit / Rust が listen | Tauri Event (`hash_file_progress` 等の文字列イベント名で broadcast) |
| (D) AbortSignal 互換ラッパ | フロントが `AbortController` を作り、専用ブリッジで Rust に伝搬 | 任意 |

進捗通知とキャンセル機構は構造的に異なる方向 (Rust→Frontend / Frontend→Rust) を持つため、**それぞれ最適な仕組みを別個に選ぶ**。

---

## 2. Decision

| 項目 | 採用 |
|------|------|
| 進捗通知 (Rust → Frontend) | **Tauri Channel** (`tauri::ipc::Channel<T>` を `#[command]` の引数として受け取る) |
| キャンセルシグナル (Frontend → Rust) | **`tokio_util::sync::CancellationToken` + 専用 IPC コマンド `core_cancel_operation(operationId)`** |
| `operationId` の生成 | **フロント側で UUID v4 (`crypto.randomUUID()`) を生成し、コマンド引数で Rust に渡す** |
| Rust 側の状態保持 | **`OperationRegistry`** (アプリ全体に 1 つ、`AppState` に保持) — 内部は `Mutex<HashMap<OperationId, CancellationToken>>` |
| 重い処理を逃がす API | **`tauri::async_runtime::spawn_blocking` のみ**。`std::thread::spawn` / `tokio::task::spawn_blocking` 直接 / 自前 `rayon` 等は禁止 |
| キャンセル確認の頻度 | **I/O はチャンク (1 MB を既定) ごと、CPU バウンドは最大 100 ms 以内のループ刻みで `token.is_cancelled()` を呼ぶ** |
| キャンセル成立時の戻り値 | **`Err(AppError::Cancelled { operation_id })`** (新設エラー種別、IPC では `code: "cancelled"`) |
| `core_cancel_operation` の冪等性 | **存在しない / 既に完了済みの `operationId` に対しても `Ok(())` を返す** (フロント側のリトライ・unmount 整理を簡素化) |
| 追加依存 | `tokio-util` クレートを追加 (`default-features = false` で `CancellationToken` のみ使用、追加 feature 無し) |

### 2.1 仕組みの全体像

```
[Frontend]                                       [Rust]
const operationId = crypto.randomUUID();
const onProgress = new Channel<HashFileProgress>();
onProgress.onmessage = (p) => updateUi(p);

invoke("hash_compute_file", {                    #[command]
  operationId,                          ─────►   pub async fn hash_compute_file(
  path,                                            state: State<'_, AppState>,
  algorithm,                                       operation_id: String,
  onProgress,                                      path: String,
})                                                 algorithm: HashAlgo,
                                                   on_progress: tauri::ipc::Channel<HashFileProgress>,
                                                 ) -> Result<HashResult, AppError> {
                                                     let token = state.operations
                                                         .register(operation_id.clone())?;     // (1)
                                                     let _guard = OperationGuard::new(         // (2)
                                                         &state.operations, &operation_id,
                                                     );
                                                     let result = tauri::async_runtime::spawn_blocking({
                                                         let token = token.clone();
                                                         let on_progress = on_progress.clone();
                                                         move || compute_file_hash(
                                                             path, algorithm, token, on_progress,
                                                         )                                      // (3)
                                                     }).await
                                                         .map_err(AppError::JoinError)??;
                                                     Ok(result)
                                                 }


[キャンセルボタン押下]
invoke("core_cancel_operation", {                #[command]
  operationId,                          ─────►   pub async fn core_cancel_operation(
})                                                 state: State<'_, AppState>,
                                                   operation_id: String,
                                                 ) -> Result<(), AppError> {
                                                     state.operations.cancel(&operation_id);   // (4)
                                                     Ok(())  // 該当なし / 完了済みでも Ok
                                                 }
```

凡例:
- (1) **register**: フロントが渡した `operation_id` をキーに `CancellationToken` を新規生成して保持。同 ID が既に存在すれば `AppError::OperationAlreadyExists` (実装ミスの早期検出)
- (2) **OperationGuard (RAII)**: 関数の Drop 時にレジストリから自動削除。早期 return / panic でも漏らさない
- (3) **spawn_blocking 内のループ**: 1 MB ごとに `token.is_cancelled()` を確認 → 真なら `Err(AppError::Cancelled)` を返して即時 return。同じループで `on_progress.send(...)` を呼ぶ
- (4) **cancel**: `token.cancel()` を呼ぶだけ。spawn_blocking 内の次回確認で検知される

### 2.2 `OperationRegistry`

```rust
use std::collections::HashMap;
use std::sync::Mutex;
use tokio_util::sync::CancellationToken;

pub struct OperationRegistry {
    inner: Mutex<HashMap<String, CancellationToken>>,
}

impl OperationRegistry {
    pub fn new() -> Self {
        Self { inner: Mutex::new(HashMap::new()) }
    }

    /// 新規登録。同 ID が既存の場合はエラー (実装ミスの早期検出)。
    pub fn register(&self, id: String) -> Result<CancellationToken, AppError> {
        let mut map = self.inner.lock().expect("operation registry poisoned");
        if map.contains_key(&id) {
            return Err(AppError::OperationAlreadyExists { operation_id: id });
        }
        let token = CancellationToken::new();
        map.insert(id, token.clone());
        Ok(token)
    }

    /// キャンセル。該当 ID なしでも Ok(())。完了済みも Ok(()) (冪等)。
    pub fn cancel(&self, id: &str) {
        if let Some(token) = self.inner.lock().expect("operation registry poisoned").get(id) {
            token.cancel();
        }
    }

    /// 削除。OperationGuard の Drop から呼ばれる。
    pub fn deregister(&self, id: &str) {
        self.inner.lock().expect("operation registry poisoned").remove(id);
    }
}

pub struct OperationGuard<'a> {
    registry: &'a OperationRegistry,
    operation_id: &'a str,
}

impl<'a> OperationGuard<'a> {
    pub fn new(registry: &'a OperationRegistry, operation_id: &'a str) -> Self {
        Self { registry, operation_id }
    }
}

impl<'a> Drop for OperationGuard<'a> {
    fn drop(&mut self) {
        // Drop 中の panic はプロセス abort になるため、Mutex の poison を expect しない。
        // 最善努力で deregister する。poisoning が起きるケース自体が異常状態であり、
        // ID 残留は次回 register 時の OperationAlreadyExists で検出される。
        match self.registry.inner.lock() {
            Ok(mut map) => {
                map.remove(self.operation_id);
            }
            Err(_) => {
                tracing::error!(
                    operation_id = %self.operation_id,
                    "operation registry poisoned during guard drop; leaking id"
                );
            }
        }
    }
}
```

**Mutex の選択**: `std::sync::Mutex` を使う (`tokio::sync::Mutex` ではない)。理由は:
- ロック区間は HashMap の操作のみ (μs オーダ)
- await をまたいで保持しない
- spawn_blocking 内からも安全に取得できる

**poisoning の扱い**: `register` / `cancel` の通常パスでは `expect("poisoned")` で**プロセス致命**として落とす (回復不能の異常状態のため)。一方、**`Drop::drop` 内では `expect` を使わない** (Drop 中の panic は二重 panic でプロセス即時 abort になるため、状況をログに残して続行する)。`OperationRegistry` を保持する `AppState` は Tauri ランタイム生存中ずっと生きるため、通常運用での poisoning は理論上ほぼ起きない。`parking_lot::Mutex` (毒性なし) への切替は将来の検討事項とし、Phase 1 では std を採用する。

### 2.3 `spawn_blocking` 使用規約

以下を Phase 1 開始時から **コーディング規約** として固定する。CI/レビューで違反を弾く。

| # | 規約 |
|---|------|
| R-1 | I/O / CPU バウンドの長時間処理 (≥ 100ms 想定) は **`tauri::async_runtime::spawn_blocking` 経由のみ** で実行する |
| R-2 | `std::thread::spawn` / `std::thread::Builder::spawn` / `tokio::task::spawn_blocking` 直接 / 自前 `rayon` / 自前スレッドプール生成は **禁止**。Tokio ワーカースレッドのブロッキング (await 中の同期 I/O) も禁止 |
| R-3 | `spawn_blocking` のクロージャ内で `block_on` / `tokio::runtime::Handle::block_on` を呼ばない (Tauri ランタイムをブロックしうる) |
| R-4 | `spawn_blocking` をネストしない (二段スレッド消費を避ける) |
| R-5 | キャンセル可能な処理は `CancellationToken` を引数で受け取り、**チャンク (I/O 既定 1 MB / CPU 既定 ≤ 100 ms) ごと**に `token.is_cancelled()` を確認する。真なら `Err(AppError::Cancelled { operation_id })` で早期 return |
| R-6 | 進捗通知は `tauri::ipc::Channel<T>` を引数で受け取り、`on_progress.send(...)` で送る。Tauri Event (`app.emit`) を進捗用途で新設しない |
| R-7 | `spawn_blocking` の戻り値型は `Result<T, AppError>`。`JoinError` は `?` で `AppError::JoinError` に集約する |
| R-8 | `spawn_blocking` 内から `ScopedStorage` (DB 操作) を呼んでよい (`module-contract.md` §5.1 が `Arc<dyn ModuleBackend>` ベースで spawn_blocking 互換になっている)。ただし writer mutex を保持したまま長時間 await しないこと (`data-model.md` §13.7)。**トランザクション中のキャンセル確認は禁止**: トランザクション境界の **間** でのみ確認する (per-item 1tx の import 等で「一塊 1 トランザクション」を中断しない) |
| R-9 | 進捗 Channel は **完了直前 / キャンセル成立直前にも 1 件送る** (`Done` / `Cancelled` バリアント)。フロントが「最終状態」を確実に受け取れるようにする。`send` の失敗 (フロントが Channel を既に drop した等) は **panic させず `tracing::warn!` でログのみ残して続行する** (キャンセル確定済みなら戻り値で正しく扱われる) |
| R-10 | `spawn_blocking` 内で `Ok(...)` を返す **直前にも `token.is_cancelled()` を最終確認** し、真なら `Err(AppError::Cancelled)` に変換する。チャンク完了直後にキャンセル要求が到達した瞬間で `Ok` と `cancel()` が交叉するレースを潰す |

### 2.4 進捗 Channel の型 (M-Hash の例)

`module-contract.md` §12.4 で言及されている `hash_file_progress` イベントは **本 ADR で Channel に置き換える** (Tauri Event は使わない)。

```rust
#[derive(Clone, serde::Serialize)]
#[serde(tag = "type")]
pub enum HashFileProgress {
    /// 計算中。bytes_processed / total_bytes はバイト数。
    Progress { bytes_processed: u64, total_bytes: u64 },
    /// 完了直前。これ以降 send されない。
    Done { duration_ms: u64 },
    /// キャンセル成立。これ以降 send されない。
    Cancelled,
}
```

各モジュールは自モジュールの進捗型を `<id>::progress` モジュールに置き、コマンド引数で Channel として受け取る。

> 補足: `tauri::ipc::Channel<T>` は内部的に参照カウントを持ち `Clone` 実装済み (`tauri 2.x`)。`spawn_blocking` のクロージャに `move` しても、コマンド本体側で別クローンを保持して最終 `Done` / `Cancelled` を送ることができる。`T` は `Serialize + Send + 'static` を要求する。

### 2.5 既存ドキュメントへの影響と更新箇所

本 ADR 受理に伴い以下を更新する:

| ドキュメント | 箇所 | 変更内容 |
|------------|------|----------|
| `architecture.md` §11 | 「ファイルハッシュ」行 | キャンセル機構を ADR-0009 参照に更新 |
| `architecture.md` §14 (オープン論点) | Q-15 | 削除 (本 ADR で決着) |
| `module-contract.md` §5.2 | 「キャンセル機構 — Q-15 で別途検討」 | ADR-0009 参照に更新。`OperationRegistry` は `AppState` 経由でアクセス可能と明記 |
| `module-contract.md` §6.1 | spawn_blocking 言及 / 「キャンセル方式は Q-15 で別途決定」の文 | 後者を削除し、ADR-0009 §2.3 の規約参照を追加 |
| `module-contract.md` §12.4 | M-Hash の固有 IPC コマンド欄 | `hash_file_progress` イベント記述を「進捗 Channel `HashFileProgress`」に書き換え |
| `module-contract.md` §14 | Q-15 | 削除 |
| `data-model.md` §17 | Q-15 | 削除 |
| `data-model.md` §12.2 / §12.4 | export / import の進捗通知 | Channel ベースに揃える (今後の export / import コマンド ADR で具体化) |
| `decisions/0006-payload-versioning.md` | writer mutex 関連箇所 | 「writer mutex 中は ADR-0009 §7.2 によりキャンセル不可」の参照を 1 行追記 |
| `decisions/0007-local-backup.md` §2 / §13.7 | バックアップ取得・リストアの writer mutex 説明 | リストア中のキャンセル可否について ADR-0009 §1 表 / §7.2 への参照を 1 行追記 |

更新は本 ADR 受理 (Status: Accepted) と同じコミットで行う。**受理判定 checklist**:

1. 本表のすべての対象ファイル更新が同コミットに含まれること
2. 本 ADR 冒頭の Status を `Proposed` → `Accepted` に書き換えること
3. 改訂履歴に「Accepted 化」行を追加すること

3 つすべてが揃って初めて Accepted となる。途中状態でマージしてはならない。

### 2.6 `AppError` への追加

```rust
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    // ... 既存
    #[error("operation cancelled: {operation_id}")]
    Cancelled { operation_id: String },

    #[error("operation already exists: {operation_id}")]
    OperationAlreadyExists { operation_id: String },

    #[error("blocking task join failed: {0}")]
    JoinError(#[from] tauri::Error),
}
```

> 補注: `tauri::async_runtime::JoinHandle::await` の戻り値は `Result<T, tauri::Error>` (Tauri 2.10 系で確認)。`tokio::task::JoinError` ではなく Tauri 独自のグローバルエラー型 `tauri::Error` で包まれる。Phase 1 着手時点の Tauri バージョンで型シグネチャを再確認し、変わっていた場合は本箇所を修正する。

IPC 越しのコード:

| Rust エラー | IPC `code` | フロント側の典型扱い |
|-----------|-----------|------------------|
| `Cancelled` | `"cancelled"` | エラートースト出さず、UI 側で「キャンセルされました」表示 |
| `OperationAlreadyExists` | `"operation_already_exists"` | 実装ミスとして開発者通知 (`tracing::error!`)。共通フックがレース回避を担う場合はそこで吸収するため、UI には通常出ない |
| `JoinError` | `"internal"` | 通常エラー扱い。tracing でスタックを残す |

### 2.7 `tokio-util` 依存の追加

`Cargo.toml`:

```toml
[dependencies]
tokio-util = { version = "0.7", default-features = false }
```

`tokio-util` 0.7 系では `tokio_util::sync` モジュール (`CancellationToken` を含む) は **feature gate されておらず**、`default-features = false` のままで使える (docs.rs の crate features 表 / `tokio_util::sync::CancellationToken` ページに "Available on crate feature" 注釈がないことを確認済)。`rt` feature は `tokio/rt` 等を追加で引き込むため、`CancellationToken` 単体使用には不要。`mpsc` 拡張・`io-util`・`codec` 等も不要。バイナリ増は十数 KB 程度で軽量性目標 (§3.1) に影響しない。

`tokio-util` を入れる代わりに `Arc<AtomicBool>` で自前実装することも可能だが、以下の理由でデファクトを採用:
- `is_cancelled` / `cancel` / `cancelled().await` の API が標準化されている
- `child_token()` で階層的キャンセル (親をキャンセルすると子も伝播) が無料で得られる — export / import の per-item サブタスクで有用
- メモリオーダリング・spurious wakeup の取扱いを正しく実装する手間を省く

---

## 3. Alternatives Considered

### 3.1 進捗通知

| 候補 | 評価 |
|------|-----|
| **Tauri Channel (採用)** | ✅ 型付き (`Channel<T>`)。✅ オペレーション単位スコープ。✅ broadcast にならず他 UI に漏れない。✅ Tauri 2 公式機構。❌ Tauri 2 限定 (Tauri 1 へのフォールバック不要)。❌ `tokio-util` とは独立に追加学習コストあり |
| Tauri Event (`app.emit("hash_file_progress", ...)`) | ❌ 文字列イベント名で型安全性が低い。❌ ブロードキャストなので複数同時実行時に listener 側で operation_id フィルタが必要。❌ 進捗イベント乱用が起きやすい (デバッグ用や副次通知が同居して見通しが悪化) |
| 自前 `tokio::sync::mpsc` + `app.emit` | ❌ Tauri Channel と機能重複。チャンネルラッパを自作する意味がない |
| `tracing` + フロント収集 | ❌ ログとビジネス通知の責務混在 |

→ **Tauri Channel 採用**。

### 3.2 キャンセル機構

| 候補 | 評価 |
|------|-----|
| **CancellationToken + 専用コマンド (採用)** | ✅ 標準 API (`tokio_util::sync::CancellationToken`)。✅ 階層キャンセル (`child_token`) を export / import の per-item で再利用可能。✅ テスト容易 (token を直接 cancel して動作検証)。✅ 操作レジストリが M-Hash 以外 (export / import / FTS rebuild / restore) でも再利用可能。❌ `operationId` 管理がフロントに発生 |
| Tauri Channel の drop 検出のみ | ✅ 追加 API なし。❌ drop 検出は GC タイミング依存で非決定的 (React unmount → Channel ガーベジ → drop 検出 までラグ)。❌ ユーザーがアクティブにキャンセルしたい瞬間と drop タイミングが一致しない (例: モーダル維持したまま「キャンセル」ボタンを押したい)。❌ M-Hash 以外で再利用しにくい (各処理ごとに drop 検出ロジックを書く) |
| Tauri Event 双方向 (`cancel:<id>` を emit) | ❌ Event 名規約が乱雑になる。❌ Rust 側で listener 解除のライフタイム管理が手間。❌ 型安全性が低い |
| AbortSignal 互換ラッパ | ❌ Web 標準だが Tauri に組み込み無し。自作するコストが CancellationToken 採用に対して引き合わない |
| Tokio `JoinHandle::abort()` のみ | ❌ `spawn_blocking` の `JoinHandle::abort()` は **協調的キャンセルではなく強制中断 (実際には実行中スレッドを止められない)** ため、I/O ループの早期 return が必要。協調シグナルが結局必要 |

→ **CancellationToken + 専用コマンド採用**。

### 3.3 `operationId` の生成元

| 候補 | 評価 |
|------|-----|
| **フロント生成 UUID v4 (採用)** | ✅ 長時間コマンドの開始前にキャンセル ID が確定する。✅ `crypto.randomUUID()` がブラウザ標準で追加依存ゼロ。✅ React Strict Mode 等の二重実行でも同 ID で `OperationAlreadyExists` を確実に検出 |
| Rust 生成 → 長時間コマンドの戻り値で返す | ❌ コマンドが完了するまで ID が返らないため、その間にキャンセル不能 |
| Rust 生成 → 別 Event で先に通知 | ❌ Event とコマンド完了の競合管理が必要。❌ React 側の listener 順序でレースが起きやすい |
| Tauri 内蔵 ID (`window.label` 等) | ❌ 同ウィンドウで複数操作同時実行をハンドルできない |

→ **フロント生成 UUID v4 採用**。

### 3.4 `spawn_blocking` の使い分け

| 候補 | 評価 |
|------|-----|
| **`tauri::async_runtime::spawn_blocking` 一本化 (採用)** | ✅ Tauri が同梱する Tokio ランタイム上で動き、`tokio::task::spawn_blocking` 直接呼びと違って Tauri 設定 (max_blocking_threads 等) が効く。✅ 規約が単純で違反検出しやすい |
| `tokio::task::spawn_blocking` 直接 | ❌ Tauri の設定経路を外すリスク。両方混在すると追跡しにくい |
| `std::thread::spawn` | ❌ Tokio に統合されておらず JoinHandle が `await` できない |
| `rayon` 等のワークスティール | ❌ 自前ランタイム追加禁止 (`module-contract.md` §6.2)。Phase 1 ではマルチコア並列のニーズ無し (M-Hash は I/O 律速) |
| `tokio::task::spawn` (async タスク) | △ async I/O / 軽量タスク用。重いブロッキング処理に使うと Tokio ワーカーをブロックしてアプリ全体が止まる。**async コンテキスト維持目的でのみ可、ブロッキングは含めない** |

→ **`tauri::async_runtime::spawn_blocking` 一本化採用**。`tokio::task::spawn` は async-only で残す (混同しないよう規約 R-2 に明記)。

---

## 4. Consequences

### 4.1 Positive

- **キャンセル API が一箇所**: M-Hash・export・import・FTS rebuild・restore で同じ `core_cancel_operation` が使え、フロント側のキャンセル UI も `useCancellableOperation(operationId)` 等のフックで共通化できる
- **テスト容易**: `OperationRegistry` を直接呼べるため、IPC を介さずに `register → cancel → token.is_cancelled() == true` のユニットテストが書ける
- **進捗通知が型安全**: `Channel<HashFileProgress>` で型ナローイングが効き、フロントの switch case で網羅性チェックできる
- **多重実行に強い**: operation_id 単位でスコープされるため、同じ M-Hash を 2 ファイル並列実行しても進捗・キャンセルが混線しない
- **Tauri Event の濫用を防げる**: 進捗用に Tauri Event を新設しない規約により、Event はアプリレベルの非同期通知 (例: 設定変更の波及) に責務を絞れる
- **ステートレスモジュール (D-06) と整合**: M-Hash は items に書き込まないが、操作レジストリは `AppState` 経由で参照するので StorageService に依存しない
- **階層キャンセルが安価**: import の per-item サブタスクで `child_token()` を作れば「全体キャンセルで全 child を一括停止」が無料で得られる

### 4.2 Negative / Risks

- **`tokio-util` の依存追加**: `default-features = false` 構成でも約十数 KB のバイナリ増。軽量性目標 (§3.1) に微小なコストが乗る
  - 対策: feature を最小化し定期的に `cargo bloat` で監視
- **`operationId` 管理のフロント負担**: フロントが UUID 生成・cancel 呼び出し・unmount 時クリーンアップを書く必要がある
  - 対策: `useCancellableOperation` 共通フックを Day 1 に用意し、各モジュールの UI からはフック経由のみで使う規約にする
- **キャンセル粒度の遅延**: チャンク区切り (I/O 1 MB) で確認するため、最大 1 MB 読み込みぶんの遅延 (高速 SSD で μs 単位、ネットワークドライブで秒単位の可能性)
  - 対策: 規約 R-5 でチャンクサイズの既定を定め、ネットワークドライブ等の遅延が大きい状況ではチャンクを小さくする (実装ガイドラインで明記)
- **キャンセル成立後に進捗 Channel が閉じられない見落とし**: `Cancelled` バリアントを送り忘れるとフロントが「進捗が止まった」と誤認する
  - 対策: 規約 R-9 で「完了 / キャンセル直前に最終状態を 1 件 send」を必須化。レビューで弾く
- **OperationRegistry のロックポイズニング**: `expect` で落とすため、稀にプロセス全体が死ぬ
  - 対策: ロック区間を最小化 (HashMap 操作のみ)。発生したらバグ修正する。ユーザーにはアプリのリスタートを案内
- **`spawn_blocking` プールの逼迫**: Tauri / Tokio の既定 max_blocking_threads は 512 だが、ファイルハッシュを 100 件並列起動するような UI を作ると逼迫する
  - 対策: フロント UI で M-Hash の並列実行数を制限 (P-N の決定は別途 UI 設計時)。本 ADR は API 規約のみを縛る
- **キャンセル成立と完了のレース**: ユーザーがキャンセルを押した瞬間に処理が完了し `Ok(...)` が返る場合がある (チャンク完了直後)
  - 対策: フロント側は **コマンド戻り値 (Promise resolve / reject) を最終結果のソース・オブ・トゥルース** とする。`Channel` の `Done` / `Cancelled` バリアントは UI 演出 (進捗バー満了表示 / キャンセル表示) のためのヒントに過ぎず、戻り値と矛盾した場合は戻り値を採用する。R-10 により Rust 側で `Ok` と `Cancelled` の二重発火は起きない。`core_cancel_operation` は冪等なので連打耐性あり
- **既存ドキュメント `module-contract.md` §12.4 の `hash_file_progress` Event 言及との不整合**: 本 ADR 受理時に書き換えが必要 (§2.5 で明記)
  - 対策: 本 ADR と同じコミットでドキュメント更新

### 4.3 Neutral

- フロント側の AbortController への将来移行: `useCancellableOperation` フックの内部実装を AbortController 互換に差し替えれば、UI コードを変えずに移行可能
- 階層キャンセル (`child_token`) は Phase 1 では import / export 内部の使用に留め、フロント側 API には公開しない

---

## 5. Mitigations

| リスク | 対策 |
|-------|------|
| `operationId` の生成漏れ・unmount 時 cleanup 漏れ | `useCancellableOperation(invokeFn)` 共通フックを Day 1 に作り、`unmount` で自動 `core_cancel_operation` を呼ぶ。各モジュールのコンポーネントは直接 `invoke` を呼ばずフック経由のみ |
| `OperationAlreadyExists` の誤発生 (React Strict Mode の二重実行) | **共通フック側の責務**: 同一 ID での連続 invoke が発生したら、共通フックが先に `core_cancel_operation(prev_id) → 新 ID 生成 → 新 invoke` に正規化する (= UI コードからは `OperationAlreadyExists` が見えない)。Rust 側は `tracing::warn!` でフック実装ミス検出用に残す。エラーは UI に上げない |
| 進捗 Channel の最終状態 (Done / Cancelled) 送信漏れ | 規約 R-9 でレビュー必須項目化。Phase 1 の M-Hash PoC (Q-22 と兼ねる) で送信動作をテストケース化 |
| キャンセル粒度の遅延 (大チャンク・ネットワークドライブ) | 規約 R-5 のチャンクサイズはモジュール側で調整可能 (既定 1 MB)。M-Hash はネットワークドライブ検出時に 256 KB に下げる実装ガイドラインを実装時に追加検討 |
| `spawn_blocking` プール逼迫 | UI 側で並列数を制限 (M-Hash は同時 4 件などの上限を設定)。本 ADR スコープ外だが Known Concern §7.4 に記録 |
| writer mutex 中のキャンセル | キャンセル後も writer mutex 解放まではトランザクションを完走させる方針 (`data-model.md` §13.7 に整合)。キャンセルはトランザクション境界の**間**で確認する。詳細は export / import の個別 ADR で扱う |
| Cancelled / Ok のレース | フロント側は **コマンド戻り値 (Promise resolve / reject) を最終結果の source-of-truth** とし、Channel の `Done` / `Cancelled` は UI ヒントとして扱う (§4.2 と整合)。R-10 で Rust 側の `Ok` と `Cancelled` 二重発火を防止。`core_cancel_operation` の冪等性で連打耐性 |
| ドキュメント不整合 | 本 ADR 受理コミットで §2.5 のリストに従って一括更新。改訂履歴に明記 |

---

## 6. Validation Criteria

### 6.1 PoC で確認すべきこと (Phase 1 最初期、Q-22 PoC とまとめて実施)

`module-contract.md` §5.3 の `generate_handler!` 集中登録 PoC (Q-22) と同じ最小モジュール (M-Hash の `hash_compute_text` + 本 ADR の `hash_compute_file`) で以下を確認する:

- [ ] `tauri::ipc::Channel<HashFileProgress>` がコマンド引数として受け取れる (Tauri 2 の API が想定通り動く)
- [ ] フロントが `crypto.randomUUID()` で生成した `operationId` を Rust 側で `OperationRegistry::register` して `CancellationToken` を取り出せる
- [ ] `spawn_blocking` の中から `token.is_cancelled()` がチャンク間で確認できる
- [ ] 別コマンド `core_cancel_operation` で `token.cancel()` を呼ぶと、進行中の `spawn_blocking` がチャンク境界で早期 return する
- [ ] 早期 return が `Err(AppError::Cancelled)` として IPC を超えてフロントに `code: "cancelled"` で届く
- [ ] `OperationGuard` の Drop が早期 return / panic / 正常終了のすべてでレジストリから ID を削除する
- [ ] 完了直前 / キャンセル成立直前に `Done` / `Cancelled` 進捗が確実に Channel から届く
- [ ] 同時並行 2 操作 (異なる operation_id) で進捗・キャンセルが混線しない

### 6.2 受入条件 (M-Hash 実装完了時)

- [ ] 1 GB のファイルをハッシュ計算中にキャンセルすると 1 秒以内に UI が「キャンセルされました」状態になる (チャンクサイズ 1 MB / **NVMe SSD 連続読み 1 GB/s 級を想定**。HDD / ネットワークドライブはこの基準を適用しない。CI 上で測定する場合は ramdisk 等の高速ストレージを利用)
- [ ] `OperationGuard` の Drop が **panic 発生時にも** レジストリから ID を削除する (`std::panic::catch_unwind` を使い `spawn_blocking` 内で `panic!()` を発生させ、`tauri::Error` 経由で戻ってきた後にレジストリが空であることを確認するテストを書く)
- [ ] キャンセル後にレジストリから operation_id が削除されており、同 ID で再 register が `OperationAlreadyExists` を返さない
- [ ] React UI コンポーネントを unmount すると `core_cancel_operation` が自動的に呼ばれ、レジストリが片付く
- [ ] `cargo test` で `OperationRegistry` の register / cancel / deregister / 冪等性 / 同 ID 重複検出のユニットテストが通る
- [ ] `clippy.toml` の **`disallowed-methods`** (kebab-case の設定キー、lint 名は `disallowed_methods` のアンダースコア) に `tokio::task::spawn_blocking` / `std::thread::spawn` / `std::thread::Builder::spawn` / `tokio::runtime::Handle::block_on` を登録し、`cargo clippy -- -D warnings` で違反を検出する仕組みが整っている (`disallowed_methods` lint は free function も捕捉対象)。grep fallback の役割は **モジュールエイリアス経由の path 短縮 + マクロ展開取りこぼし** の二重防御。`rayon::*` のワイルドカード禁止は clippy の `path =` で表現できないため grep のみで担保。詳細実装は **ADR-0010 §2.4.1 / §2.5 / §6.2** を参照

---

## 7. Known Concerns / 将来見直しが要りうる判断

### 7.1 階層キャンセルのフロント API 公開

- import / export で `child_token()` による階層キャンセルを使うが、フロント側には公開しない (操作の単位は親の operation_id のみ)
- 将来「サブ操作だけキャンセル」のニーズが出たら別 ADR で API 拡張

### 7.2 キャンセル不能区間 (リストア中の writer mutex 保持等)

- バックアップリストア中は writer mutex を握ったままなので、キャンセルしても DB の整合性のためトランザクション完走を待つ
- フロント UI には「キャンセル要求受付済み・整合性確保のため停止待ち」状態を出す。**IPC 表現**: リストア用進捗 Channel に `CancelRequested { reason: "writer_locked" }` バリアントを 1 件 send し、フロントはこれを受けて UI を「停止待ち」表示に切り替える。最終的な戻り値 (`Ok(())` / `Err(Cancelled)` / `Err(...)`) は writer トランザクション完走後に返す
- 詳細仕様は `data-model.md` §13.6 / §13.7 のリストア UI 仕様 (Q-19) で扱う (進捗 Channel の他バリアント設計含む)

### 7.3 タイムアウトの扱い

- 本 ADR はキャンセルのみで、タイムアウト (一定時間経過で自動キャンセル) は扱わない
- 必要が顕在化したらフロント側で `setTimeout` → `core_cancel_operation` の組合せで実装可能 (Rust 側の API 拡張は不要)

### 7.4 並列度制限 / 操作キュー

- 同時実行数の上限管理は本 ADR スコープ外
- M-Hash で多数ファイル並列実行のニーズが顕在化したら、UI レイヤで 4 並列等の制限。`spawn_blocking` のプール逼迫が観測されたら本 ADR を見直す

### 7.5 Web Worker との統合 (将来)

- フロント側で Markdown レンダリング等を Web Worker に逃がす場合、Worker 内からの `invoke` / Channel が動くかは Tauri 2 の挙動依存
- 該当が顕在化したら別途検証

### 7.6 進捗 Channel のバックプレッシャ

- `tauri::ipc::Channel::send` はノンブロッキング (内部キュー)。フロントの listener が遅いと内部キューが膨らむ可能性
- M-Hash の進捗は **チャンク (1 MB) ごと**で十分粗いので Phase 1 では問題化しない見込み
- 将来的に細かい進捗が必要になったらレートリミット (例: 100ms ごとに最新値のみ送る) を検討

### 7.7 `tokio-util` のメジャー更新追従

- `tokio-util` 0.7 → 1.0 移行時は `CancellationToken` API が変わる可能性
- 対応: 影響箇所は `OperationRegistry` 内部のみで、`AppError::Cancelled` などの公開 API は不変。アップグレード作業は局所的

---

## 8. References

- ADR-0001 (Tauri v2)
- ADR-0006 (payload バージョニング — 楽観的並行制御 / writer mutex)
- ADR-0007 (ローカルバックアップ — pre-op バックアップ中のロック)
- 要件: `docs/requirements.md` §3.1 (軽量性) / §3.4 (オフライン動作) / D-06 (M-Hash ステートレス)
- アーキテクチャ: `docs/architecture.md` §3 (プロセス・スレッドモデル) / §11 (重い処理) / §14 Q-15
- モジュール契約: `docs/module-contract.md` §5.2 (共有コンテキスト不採用) / §6.1 (spawn_blocking) / §6.2 (自前ランタイム禁止) / §12.4 (M-Hash 進捗イベント)
- データモデル: `docs/data-model.md` §7.3 (FTS 再構築) / §12.4 (import per-item 1tx) / §13.6 (restore) / §13.7 (writer mutex)
- Tauri Channel: https://v2.tauri.app/develop/calling-frontend/#channels
- `tokio_util::sync::CancellationToken`: https://docs.rs/tokio-util/latest/tokio_util/sync/struct.CancellationToken.html

---

## 9. 改訂履歴

| 日付 | 版 | 内容 |
|------|----|------|
| 2026-04-30 | 1.0 | 初版ドラフト (Q-15 を決着) |
| 2026-04-30 | 1.1 | レビュー round 1 反映: `tokio-util` の feature flag を `rt` から `default-features = false` に修正 (Critical / docs.rs で `tokio_util::sync` が feature gate されていないことを確認) §2 / §2.7 / R-10 を追加し `Ok` 返却直前のキャンセル最終確認を必須化 §2.3 / `clippy.toml` の `disallowed_methods` 利用を §6.2 に明記 / `tauri::ipc::Channel<T>` の Clone と型境界補注を §2.4 に追加 |
| 2026-04-30 | 1.2 | レビュー round 2 反映: §1 表の「リストア」行を「キャンセル要求は受付ける / writer トランザクション中は実効キャンセル不可」と §7.2 に揃えて矛盾解消 / §4.2 のキャンセル成立 vs 完了レースの対策を「コマンド戻り値を source-of-truth、Channel はヒント」に強化 / §5 Mitigations の同行を §4.2 と整合させた / §4.2 の `tokio-util` バイナリ増コメントを 1.1 の feature 修正に合わせて更新 |
| 2026-04-30 | 1.3 | レビュー round 3 反映: タイトルに「進捗通知 (Tauri Channel)」を追加 (M-4) / §2.2 の `OperationGuard::drop` から `expect` を排除し最善努力 deregister + tracing::error! ログに変更 (Critical C-1: Drop 内 panic はプロセス abort) / `parking_lot::Mutex` を将来検討事項として明示 / §2.6 の `AppError::JoinError` の `#[from]` を `tauri::async_runtime::JoinError` から **`tauri::Error`** に修正 (Critical C-2: docs.rs で `JoinHandle::await` の戻りが `Result<T, tauri::Error>` であることを確認) / §2.5 表に ADR-0006 / ADR-0007 への逆参照追記行を追加 (M-6) / §2.5 末尾に **受理判定 checklist** を追加 (M-5) / §7.2 にリストア中の `CancelRequested { reason: "writer_locked" }` バリアント送信を IPC 表現として明記 (M-3) / §1 表の Online Backup 根拠を「Online Backup は I/O 中もユーザー操作を妨げない」に強化 (M-1) / §5 Mitigations の Strict Mode 行を「共通フックが prev_id cancel → 新 ID 生成に正規化、UI には `OperationAlreadyExists` を見せない」に確定 (M-2) / §6.2 の 1 GB / 1 秒受入条件に **NVMe SSD 1 GB/s 級** の想定を明記 + panic 時 Drop テストの具体方法を追加 (Minor) / §2.5 の `module-contract.md` §6.1 行に「『キャンセル方式は Q-15』の文を削除する」を明示 (Minor) |
| 2026-04-30 | 1.4 | **Accepted 化**: §2.5 受理判定 checklist の 3 項目すべてを満たすコミットで Status を Proposed → Accepted に昇格。同コミットで `architecture.md` §11 / §14 / `module-contract.md` §5.2 / §6.1 / §12.4 / §14 / `data-model.md` §17 / ADR-0006 §1 / ADR-0007 §2 をすべて更新済み |
| 2026-04-30 | 1.5 | ADR-0010 受理反映: §6.2 受入条件 checklist 最終項目を差し替え。`clippy.toml` のキー名 (kebab-case `disallowed-methods` / lint 名アンダースコア) を明確化、`std::thread::Builder::spawn` を grep / clippy 両方の対象に追加、`disallowed_methods` lint が free function も捕捉する事実を明記、grep fallback の真の役割を **モジュールエイリアス経由 path 短縮 + マクロ展開取りこぼしの二重防御** と訂正 (rename import は use 文で grep ヒットするため別経路)、`rayon::*` ワイルドカード禁止が clippy では表現不能で grep のみで担保される非対称を明示。詳細実装の参照先を「CI/CD ADR」から「ADR-0010 §2.4.1 / §2.5 / §6.2」に更新 |
