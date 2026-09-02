# モジュール契約 (Module Contract)

最終更新: 2026-09-02 / ステータス: Draft (Phase 1)

このドキュメントは「**モジュールがコアと交わす契約**」を定義する。
モジュールが提供するもの / コアが提供するもの / 両者がしてはいけないことを具体 API レベルで決めて、
新モジュール追加時に「コアを変更しない」(E-01) を実装可能にする。

要件 / アーキテクチャ / データモデルとの関係:
- `requirements.md`: D-01 (プロジェクト所属) / D-02 (ビルド時組み込み) / D-06 (ステートレス) / D-11 (Eager-on-Read)
- `architecture.md`: §4.4 / §5 (モジュールレジストリ)
- `data-model.md`: §6 (items) / §7 (payload バージョニング) / §13.7 (排他制御)

---

## 1. 目的とスコープ

- 各モジュールが**コードコントラクト** (Rust トレイト + TypeScript インターフェース) として何を実装すべきかを規定する
- コアがモジュールに**何を提供し / 何を提供しないか**を規定する
- モジュール開発時の典型的な意思決定 (payload バージョン上げる? 設定置く? 自前 IPC コマンド追加する?) のガイドラインを与える

---

## 2. 契約の二面性

各モジュールは**フロントエンド側**と**バックエンド側**の両方で 1 つずつ「契約定義オブジェクト」を持つ。

| サイド | 言語 | 契約の名前 | 主な責務 |
|--------|------|----------|----------|
| Frontend | TypeScript | `ModuleDefinition` | UI 登録 / ルーティング / 検索結果整形 |
| Backend | Rust | `ModuleBackend` (trait) | payload バリデーション / 検索インデックス生成 / payload アップグレード |

両者は**同じ `id` 文字列**を持つことで紐付けられる。各 registry は ID の形式と一意性を検査し、アプリ本体描画前に `core_module_ids` の全 backend ID と frontend ID の集合を照合する。不一致や重複があればアプリは起動を停止する (黙って動作しない)。

```
   Frontend (React)              Backend (Rust)
 ┌──────────────────────┐     ┌──────────────────────────┐
 │ ModuleDefinition {   │     │ impl ModuleBackend for   │
 │   id: "prompt",      │ ──> │ PromptModule {           │
 │   displayName: ...   │     │   fn id() -> "prompt"    │
 │   routes: [...],     │     │   ...                    │
 │   searchAdapter: ... │     │ }                        │
 │ }                    │     │                          │
 └──────────────────────┘     └──────────────────────────┘
        登録: registry.ts       登録: registry.rs
```

---

## 3. `ModuleBackend` トレイト (Rust)

### 3.1 トレイト定義

```rust
use serde_json::Value as JsonValue;

pub trait ModuleBackend: Send + Sync {
    /// モジュール識別子 (英数字とハイフンのみ、3〜32 文字)。
    /// items.module_id / Tauri コマンド prefix / settings 名前空間 / バックアップファイル名 等
    /// あらゆる場所で一意キーとして使われる。
    fn id(&self) -> &'static str;

    /// このモジュールが永続データを持たないか (D-06)。
    /// true の場合: items テーブルへの書き込みは行わない / エクスポート対象から除外される。
    fn is_stateless(&self) -> bool { false }

    /// モジュールが現在書き込む payload のスキーマバージョン。単調増加の整数。
    fn current_payload_version(&self) -> u32 { 1 }

    /// 古い payload を 1 段階アップグレードする。
    /// from_version は payload が書かれた時のバージョン。
    /// 戻り値は from_version + 1 の payload。
    /// from_version == current_payload_version() の場合は呼ばれない。
    fn upgrade_payload(
        &self,
        from_version: u32,
        payload: JsonValue,
    ) -> Result<JsonValue, ModuleError> {
        Err(ModuleError::UnknownPayloadVersion(from_version))
    }

    /// payload の構造的妥当性を検証する。
    /// アップグレード後 / API 受領時 / インポート時に呼ばれる。
    /// 副作用を持ってはならない (純粋関数)。
    fn validate_payload(&self, payload: &JsonValue) -> Result<(), ModuleError>;

    /// FTS5 検索インデックスに投入する文字列を生成する。
    /// 純粋関数であること。同じ payload からは常に同じ文字列が出る。
    /// title や tags はコア側が共通カラムから取り出して結合するため、ここでは payload 由来分のみ返す。
    fn index_text(&self, payload: &JsonValue) -> String;
}
```

### 3.2 各メソッドの契約 (詳細)

#### `id()`
- **戻り値の制約**: **英小文字 / 数字のみ**。3〜32 文字 (ハイフン・アンダースコアは禁止)
  - 理由: コマンド名が `<id>_<action>` 形式 (§5.3) であり、id 内にアンダースコアやハイフンが入ると Rust 関数名やコマンド名のパース・正規化規約が必要になる。現在のモジュール ID (`prompt` / `linkmemo` / `color` / `hash` / `palette`) はすべて条件を満たす
- **使われ方**: items.module_id / Tauri コマンド prefix `<id>_*` / settings.json の `modules.<id>.*` / バックアップファイル名 `pre-<op>` の `<op>`(該当時) / エクスポート JSON の `module_versions.<id>`
- **変更不可**: モジュール公開後に id を変えると既存データが孤児になる。変えてはいけない (どうしても必要なら DB schema migration §14 扱いになる)

#### `is_stateless()`
- 既定 `false`
- `true` のモジュール: コアは items テーブルへの書き込み API をこのモジュールに提供しない (呼び出すとパニックではなくエラー)
- D-06 の Hash モジュールが該当

#### `current_payload_version()` / `upgrade_payload()`
- 詳細は §7
- payload の構造を変えたら `current_payload_version()` を上げ、対応する `upgrade_payload()` の match アームを追加する
- アップグレード関数は**冪等**であること (同じ from_version + payload の組から常に同じ結果)

#### `validate_payload()`
- 必須プロパティ / 型 / 値範囲 / 列挙値 などの検証を行う
- **副作用禁止** (DB に触らない / ファイル開かない / システム時刻に依存しない)
- **ログ出力は原則しない**。失敗理由は `ModuleError::ValidationFailed { reason }` の reason に詳細を含める。詳細ログは呼び出し側 (StorageService / インポート処理) が ModuleError を受け取って一括で出す
- インポート経路で何百件と連続で呼ばれるため、軽量に保つ

#### `index_text()`
- 純粋関数
- 戻り値は FTS5 トークナイザに渡される文字列
- title と tags は呼び出し側 (StorageService) が共通カラムから取り出して結合するため、本メソッドでは**payload に固有のフィールドだけ**を返す
  - 例: M-Prompt では `body` を返す。`title` を返す必要はない
- 空文字を返してもよい (= payload に検索対象テキストが無い場合)

### 3.3 `ModuleError`

モジュール側のエラー型。コア側の `AppError` に変換される。

```rust
#[derive(Debug, thiserror::Error)]
pub enum ModuleError {
    #[error("validation failed: {reason}")]
    ValidationFailed { reason: String },

    #[error("unknown payload version: {0}")]
    UnknownPayloadVersion(u32),

    #[error("payload upgrade failed: {reason}")]
    UpgradeFailed { reason: String },

    #[error("internal error: {0}")]
    Internal(#[source] Box<dyn std::error::Error + Send + Sync>),
}
```

### 3.4 トレイトに**含めない**もの

- ストレージへの直接アクセス (StorageService 経由のみ §5)
- ファイルシステム / ネットワーク / OS API への直接アクセス (Tauri 許可リスト経由)
- ログハンドル — 各モジュールは `tracing::info!` / `tracing::error!` のマクロを直接使う。モジュール識別が必要な場面では呼び出し側で `tracing::info_span!("module_command", module_id = "...")` のスパンを張る
- 共有コンテキストオブジェクト (`CoreContext` 等) — §5.2 参照
- 起動 / 終了フック (ビルド時組み込みのため不要 / 必要が出たら ADR で追加)

---

## 4. `ModuleDefinition` インターフェース (TypeScript)

### 4.1 インターフェース定義

```typescript
import type { ComponentType } from "react";

export interface ModuleDefinition {
  /** ModuleBackend と同じ id。一致しないと起動時にエラー */
  readonly id: string;

  /** UI に表示する名前 (例: "プロンプト管理") */
  readonly displayName: string;

  /** サイドバー等のアイコン */
  readonly icon: ComponentType<{ className?: string }>;

  /** 表示カテゴリ。省略時は other (ADR-0014) */
  readonly category?: ModuleCategoryId;

  /** settings.json に明示値が無いときの UI 有効状態 (ADR-0012) */
  readonly enabledByDefault: boolean;

  /** Backend の is_stateless と一致させる */
  readonly isStateless: boolean;

  /** モジュール内画面のルート定義 (モジュールルート相対) */
  readonly routes: readonly ModuleRoute[];

  /** モジュールに入った直後に開くデフォルトルート (例: "/", "/list") */
  readonly defaultRoute: string;

  /**
   * 横断検索結果 1 件の整形。
   * isStateless = true のモジュールでは省略可能。
   * isStateless = false のモジュールでは必須 (登録時にコアが検査し、欠落時は起動停止)。
   */
  readonly searchAdapter?: SearchAdapter;
}

export interface ModuleRoute {
  /** モジュールルート相対のパス (例: "/", "/edit/:itemId") */
  readonly path: string;
  /** 描画するコンポーネント */
  readonly component: ComponentType;
}

export interface SearchAdapter {
  /**
   * 検索結果 1 件 (ItemRow) を一覧表示用に整形する。
   * payload にアクセスして固有情報を出してよい。
   */
  formatResult(item: ItemRow): SearchResultView;
}

export interface SearchResultView {
  /** リストの主タイトル */
  title: string;
  /** リストのサブタイトル (例: URL の場合は target を見せる) */
  subtitle?: string;
  /** クリック時の遷移先 (モジュールルート相対) */
  targetPath: string;
}

/**
 * StorageService から返される共通形。
 * payload はモジュール側で適切な型にナローイングして使う。
 */
export interface ItemRow {
  readonly id: string;
  readonly projectId: string;
  readonly moduleId: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly payloadSchemaVersion: number;
  readonly payload: unknown;     // モジュールが知っている JSON 型にキャストして使う
  readonly createdAt: string;    // JST ISO8601
  readonly updatedAt: string;
}
```

### 4.2 各フィールドの契約 (詳細)

#### `id`
- ModuleBackend.id() と完全一致しなければならない
- 一致していないとアプリは起動を停止する

#### `displayName`
- 表示用文字列。日本語で書く (D-... i18n は日本語のみ)
- サイドバー / 検索結果 / 設定画面に出る

#### `icon`
- React コンポーネント。`className` 受け取り対応
- shadcn/ui と整合する Lucide React のアイコンを推奨

#### `category`
- Frontend registry が定義する表示専用 metadata。省略時は `other`
- カテゴリはサイドバーと設定画面のグルーピングにだけ使い、module ID、route、IPC、保存、検索、権限の境界にはしない
- カテゴリ定義と順序の正典は `src/modules/registry.ts` とする (ADR-0014)

#### `enabledByDefault`
- `settings.json` の `core.module_enabled.<id>` が無いときの既定値
- 無効モジュールは sidebar / search / startup restore / routing の通常 UI 経路から除外する
- backend / IPC は静的登録のまま維持し、export / import / backup では既存データを除外しない (ADR-0012)

#### `routes` / `defaultRoute`
- パスはモジュールルート相対 (`/` がモジュールトップ)
- フロントのルーティングは React Router を使い、コアが `/projects/:projectId/m/:moduleId/*` 配下へ registry から展開する
- パスパラメータは `:itemId` 形式

#### `searchAdapter.formatResult()`
- 引数 `item.payload` は `unknown` 型なので、モジュール固有の型ガード or キャストでナローイングする
- **panic / throw してはならない**。payload が想定外または古い形式の場合でも安全にフォールバックする
- フォールバックの最低基準: 共通カラムの `title` を出し、subtitle に「詳細表示時にデータが更新されます」程度のメッセージを返す
  ```typescript
  return {
    title: item.title,
    subtitle: "詳細表示時にデータが更新されます",
    targetPath: `/edit/${item.id}`,
  };
  ```
- 古い payload version の**完全な表示互換は必須ではない**。詳細画面遷移時に StorageService の `get_item` が Eager-on-Read を発火して最新化されるため、古い形式での見た目を作り込まなくてよい

### 4.3 ModuleDefinition に**含めない**もの

- 直接 invoke ラッパ (各モジュールは `invoke("<id>_<action>", ...)` を自由に呼べる)
- 状態 (Zustand ストアはアプリ全体状態のみ。モジュールローカル状態は素の React state)
- グローバル CSS (Tailwind ユーティリティと shadcn/ui の token に従う)

---

## 5. コアがモジュールに提供する API

### 5.1 StorageService (Rust)

モジュールは SQLite に直接触らず、`StorageService` のスコープ付きハンドルを介してのみアクセスする。

```rust
use std::sync::Arc;

pub trait StorageService: Send + Sync {
    /// モジュールにスコープされたストレージハンドルを返す。
    /// 以降の操作は自動的に当該モジュールの module_id で絞り込まれる。
    fn scoped_for(&self, module: Arc<dyn ModuleBackend>) -> ScopedStorage;
}

/// モジュールにスコープされたストレージハンドル。
/// 内部に Arc<dyn ModuleBackend> を保持し、index_text() / current_payload_version() を呼び出す。
/// Arc を保持するためライフタイムパラメータは持たず、async / spawn_blocking をまたいで扱える。
pub struct ScopedStorage {
    module: Arc<dyn ModuleBackend>,
    // ... StorageService 本体への Arc など
}

impl ScopedStorage {
    /// 新規 item を作成する。
    /// search_text は自動で module.index_text(payload) 経由で生成される。
    /// payload_schema_version は自動で module.current_payload_version() が入る。
    /// created_at / updated_at は StorageService が JST 時刻で生成して書き込む。
    pub async fn create_item(
        &self,
        project_id: &ProjectId,
        title: &str,
        tags: &[String],
        payload: JsonValue,
    ) -> Result<ItemId, AppError>;

    pub async fn update_item(
        &self,
        id: &ItemId,
        title: &str,
        tags: &[String],
        payload: JsonValue,
    ) -> Result<(), AppError>;

    pub async fn delete_item(&self, id: &ItemId) -> Result<(), AppError>;

    pub async fn get_item(&self, id: &ItemId) -> Result<Item, AppError>;

    /// モジュール内の項目を**指定プロジェクト内**で一覧取得する。
    /// 横断 (全プロジェクト) 取得は意図的にサポートしない。
    /// 横断検索や横断表示はコアの SearchService が担当する責務である。
    pub async fn list_items(
        &self,
        project_id: &ProjectId,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<Item>, AppError>;

    /// モジュール固有設定の読み書き (settings.json の modules.<id>.* を操作)
    pub async fn get_setting(&self, key: &str) -> Result<Option<JsonValue>, AppError>;
    pub async fn set_setting(&self, key: &str, value: JsonValue) -> Result<(), AppError>;
}
```

**設計上の重要事項**:
- `ScopedStorage` はモジュールに**自分自身の module_id**しか触らせない。他モジュールの items / 設定にアクセスする方法を提供しない
- **`list_items` は project_id 必須**。「全プロジェクト横断」のニーズはコアの SearchService 経由で扱う。モジュールが横断一覧を作れる API を持つと、UI 状態と無関係な無作為横断クエリが生まれて事故になる
- ステートレスモジュール (`is_stateless = true`) で `create_item` / `update_item` / `delete_item` / `list_items` を呼ぶと `AppError::StatelessModule` を返す (パニックさせない)。`list_items` は呼ばれた場合、空配列ではなくエラーを返す (使うべきでない API を黙認しない)
- すべてのメソッドは StorageService の writer mutex 経由で直列化される (data-model.md §13.7)
- エクスポート/インポートはコアが直接 items テーブルを処理するため、ScopedStorage には全プロジェクト系 API は不要

**保持戦略**:
- `ScopedStorage` は**コマンド関数の中で都度生成**する (Arc clone のコストは無視できる)
- registry が `Arc<dyn ModuleBackend>` を一元保持し、コマンドはそこから clone を取って `scoped_for` に渡す
- Arc 保持により async / `spawn_blocking` / Tokio タスクをまたいでも安全に扱える
- 推奨パターン:
  ```rust
  pub struct AppState {
      pub storage: Arc<dyn StorageService>,
      pub modules: HashMap<&'static str, Arc<dyn ModuleBackend>>,
  }

  #[tauri::command]
  pub async fn prompt_create(
      state: tauri::State<'_, AppState>,
      project_id: String,
      title: String,
      payload: JsonValue,
  ) -> Result<ItemId, AppError> {
      let module = state.modules
          .get("prompt")
          .ok_or(AppError::ModuleNotFound)?
          .clone();
      let storage = state.storage.scoped_for(module);
      storage.create_item(&ProjectId(project_id), &title, &[], payload).await
  }
  ```

### 5.2 共有コンテキストオブジェクトは持たない

Phase 1 では、モジュールに渡す共有コンテキスト (`CoreContext` のようなトレイト) を**意図的に持たない**。
モジュールが必要とするのは以下の 2 つだけで、それぞれ独立した経路から得られる:

- **永続化**: `ScopedStorage` (§5.1)
- **現在プロジェクト ID**: Tauri コマンドのリクエスト引数として UI から受け取る

意図的に持たないもの:
- 「現在プロジェクト ID」の直接取得 API — UI 状態を勝手に解決すると UI とずれる事故が起きる。すべて引数経由で渡す
- `spawn_blocking` のような汎用 API — generic method を持つトレイトは `dyn` として扱えなくなる。重い処理は各 Tauri コマンド内で `tauri::async_runtime::spawn_blocking` を直接呼ぶ
- ロガーハンドル — `tracing::info!` / `tracing::error!` マクロを直接使う。モジュール識別が必要な場面は呼び出し側で `tracing::info_span!("module_command", module_id = "prompt")` のスパンを張る
- キャンセル機構 — ADR-0009 で **`OperationRegistry` (`AppState` 経由) + `tokio_util::sync::CancellationToken` + `core_cancel_operation`** として確定。各モジュールはコマンド引数で `operationId` を受け取り、`spawn_blocking` 内で `token.is_cancelled()` を確認する (詳細は ADR-0009 §2 / §2.3 規約 R-1〜R-10)

**今後 CoreContext のような共有オブジェクトが必要になった場合**:
- 必要が顕在化した時点で ADR を切って導入する
- 「あれば便利だが、必要が読めない」段階では入れない (YAGNI)

### 5.3 モジュール固有 IPC コマンドの登録

モジュールは標準 CRUD 以外の独自コマンドを定義できる (例: 変数差し込み / OS ファイラー起動 / ハッシュ計算)。
ただし**実装上の制約**として、Tauri の `generate_handler!` マクロは全コマンドを 1 か所に列挙するのが安全。
モジュールごとに `invoke_handler` を継ぎ足す API は macro 展開と相性が悪い。

#### 採用する登録方式 (architecture.md §5.1 と整合)

各モジュールは「**自モジュールの Tauri コマンド関数群を `pub` で公開する**」だけ。
登録はコアの `registry.rs` で 1 か所にまとめて行う。

```rust
// src-tauri/src/modules/prompt/commands.rs (モジュール側)
#[tauri::command]
pub async fn prompt_render_template(...) -> Result<String, AppError> { /* ... */ }

// src-tauri/src/modules/registry.rs (登録側)
pub fn register_all(builder: tauri::Builder<impl tauri::Runtime>) -> tauri::Builder<impl tauri::Runtime> {
    builder.invoke_handler(tauri::generate_handler![
        // core
        core::commands::list_projects,
        core::commands::search,
        // prompt
        modules::prompt::commands::prompt_render_template,
        // linkmemo
        modules::linkmemo::commands::linkmemo_open,
        modules::linkmemo::commands::linkmemo_normalize_target,
        // hash
        modules::hash::commands::hash_compute_text,
        modules::hash::commands::hash_compute_file,
    ])
}
```

新モジュール追加時は **registry.rs に対象モジュールのコマンド分の行を追加する**。
これは architecture.md §5.1 の「2ファイル追加 + registry 1行追記 × 2」方針と整合する (コアロジックは編集しない)。

#### コマンド命名規則

Rust 関数名に `:` は使えないため、**実装名と論理名を分けず、両方とも `<module_id>_<action>` (snake_case)** を使う。

| 論理名 (本書) | 実装名 (Rust 関数) | フロント `invoke` 引数 |
|------------|----------------|-------------------|
| `prompt_render_template` | `prompt_render_template` | `"prompt_render_template"` |
| `linkmemo_open` | `linkmemo_open` | `"linkmemo_open"` |
| `hash_compute_file` | `hash_compute_file` | `"hash_compute_file"` |

- アクション名はモジュール内で一意。`<id>_` プレフィックスを付けることで全アプリで一意化される
- 名前空間衝突はコンパイル時 (関数名重複) または起動時の `generate_handler!` で検出される
- フロントの invoke 呼び出しと Rust 関数名が完全一致するので二重メンテが発生しない

#### PoC 必須事項

`generate_handler!` のマクロ展開と上記の集中登録方式が期待通り動くかは、Phase 1 の最初期に**最小モジュール (M-Hash の `hash_compute_text` 1 つ) で PoC** を行う。
動かない場合の代替案は ADR で記録する。

---

## 6. モジュールが守る制約

### 6.1 してよいこと
- `ScopedStorage` 経由で自モジュールの items を CRUD する
- 自モジュールの設定 (`modules.<id>.*`) を読み書きする
- 自モジュール固有の Tauri コマンドを `<id>_*` 命名規則で追加する (§5.3)
- React 側でモジュール内ルーティング・状態を自由に組む
- 重い処理は各 Tauri コマンド内で `tauri::async_runtime::spawn_blocking` を使って逃がす (ADR-0009 §2.3 の規約 R-1〜R-10 に従う。キャンセル可能な操作は同 §2 の `CancellationToken` + `core_cancel_operation` 経由)

### 6.2 してはいけないこと
- SQLite に直接アクセスする (`rusqlite::Connection` を持つ)
- `items_fts` を直接触る (D-12: トリガ経由でのみ更新)
- 他モジュールの module_id を指定して items にアクセスする
- 他モジュールの設定キー (`modules.<other_id>.*`) を読む
- `settings.json` を直接読み書きする
- ファイルシステムにアクセスする (Tauri 許可リストに載っていれば例外)
- 自前のスレッドプール / Tokio ランタイムを生成する (architecture.md §2.2)
- グローバル static で状態を持つ (HashMap などのキャッシュ含む)
- **モジュール配下の UI コンポーネント**から `core_*` Tauri コマンドを直接呼ぶ (プロジェクト切替・横断検索・設定保存などの core 操作は Shell / 共通 hook 経由で行う。Shell や共通 hook 自体は当然 core コマンドを呼ぶ)

これらは**慣行ではなく契約**であり、レビューで弾く。Phase 1 中に違反が見つかったら ADR 化して整理する。

---

## 7. payload バージョン進化フロー

D-11 (Eager-on-Read) を実装する具体手順。

### 7.1 payload を変更する場合の手順

1. `current_payload_version()` の戻り値を `+1` する
2. `upgrade_payload()` の match に**新しい from_version**のアームを追加し、旧→新変換ロジックを書く
3. `validate_payload()` を新スキーマに対応させる
4. `index_text()` の出力が変わるなら、その変更も反映する
5. TS 側の payload 型定義 (`PromptPayloadV2` 等) を追加し、SearchAdapter の `formatResult` を**新バージョンに対応**させる。古い payload version については §4.2 のフォールバック表示 (title のみ + 詳細遷移時に Eager-on-Read で最新化) で十分。完全互換表示は不要
6. テストを追加: 「v1 payload → v2 にアップグレードできる」「v2 payload を validate できる」「SearchAdapter が古い payload に対して panic / throw せずフォールバック表示を出す」

### 7.2 アップグレード関数のテンプレ

```rust
fn upgrade_payload(
    &self,
    from_version: u32,
    payload: JsonValue,
) -> Result<JsonValue, ModuleError> {
    match from_version {
        1 => {
            // v1 -> v2
            let mut obj = payload.as_object().cloned().unwrap_or_default();
            obj.insert("new_field".to_string(), JsonValue::String("default".to_string()));
            Ok(JsonValue::Object(obj))
        }
        // 2 -> 3 が増えたらここに追加
        unknown => Err(ModuleError::UnknownPayloadVersion(unknown)),
    }
}
```

StorageService は from_version + 1 にしてもう一度 `upgrade_payload()` を呼ぶ、という形で **1 段階ずつチェイン**させる。
モジュールは「v1 → 現行版」のショートカットを書く必要がない。

### 7.3 失敗時の取扱い

data-model.md §7.6 に準拠する。`AppError::PayloadUpgradeFailed` は `ModuleError` から変換される。

#### 未来バージョンの検出

`item.payload_schema_version > module.current_payload_version()` の場合 (新版アプリで作ったデータを旧版アプリで開いた場合):

- StorageService は **`upgrade_payload()` を呼び出さず**、直接 `AppError::UnsupportedFuturePayloadVersion { module_id, item_version, current_version }` を返す
- ダウングレードは行わない (旧版アプリが新版データの構造を理解できる保証がないため)
- 呼び出し側はコンテキストに応じて以下の振る舞いを取る:
  - **個別 read (詳細表示)**: エラーを UI に表示し、当該 item の表示を停止する。他の item には影響しない
  - **一覧 read**: §7.6 の「破損項目」マーカーと同等の表示。一覧自体は止めない
  - **インポート時**: その item をスキップ集計に加え、ユーザーに「アプリを最新版に更新してください」を案内する
  - **大規模検出時 (例: 起動時の整合性チェックで多数の future version が検出される)**: アプリ起動を停止しエラー画面を出す (data-model.md §7.6 の「黙って動作させない」方針)

---

## 8. 検索統合

### 8.1 インデックス側 (Backend)
- `index_text(payload)` が FTS5 に入る文字列を返す
- StorageService がコール時に `title + " " + tags.join(" ") + " " + index_text(payload)` を search_text として書き込む
- title / tags は共通カラムから自動投入される (モジュールが index_text に含める必要はない)

### 8.2 表示側 (Frontend)
- 横断検索結果は `ItemRow` の配列としてフロントに届く
- 無効モジュールは検索フィルタから除外し、その module_id の結果も表示しない (ADR-0012)
- 各行は `ModuleDefinition.searchAdapter.formatResult(item)` で整形される (searchAdapter が省略されているステートレスモジュールは結果に含まれない)
- クリック → `targetPath` に遷移 (モジュールルート相対)
- 古い payload バージョンの行は formatResult で「最低限の表示」(§4.2) にフォールバックされ、詳細画面遷移時に Eager-on-Read で最新化される

### 8.3 ハイライト
- Phase 1 では検索キーワードハイライトを**実装しない**(YAGNI)
- 将来必要になれば SearchAdapter に `formatResultWithHighlight(item, query)` を追加する非破壊拡張で対応

---

## 9. ステートレスモジュール (D-06)

### 9.1 宣言
```rust
fn is_stateless(&self) -> bool { true }
```
```typescript
isStateless: true
```

### 9.2 コア側の挙動
- ScopedStorage の create/update/delete/list_items はすべて `AppError::StatelessModule` を返す
  - list_items を空配列で黙認しないのは、「ステートレスなのに使うべきでない API を呼んでいる」という実装の誤りを早期に検出するため
- エクスポート/インポート対象から除外される
- 横断検索の対象から除外される
- ModuleDefinition の `searchAdapter` を省略してよい (省略すると検索結果に出ない)
- バックアップ判定 (`data_revision`) には影響しない

### 9.3 期待されるモジュール構造
- 自前で IPC コマンドを実装し、計算結果は呼び出し元 (フロント) のメモリ上に保持
- DB を介さずに動く独立した計算ユーティリティとして振る舞う
- 該当モジュール: M-Hash

---

## 10. エクスポート/インポートにおける契約

### 10.1 エクスポート
- コアが items を引き、`payload` と `payload_schema_version` をそのまま JSON に書き出す
- モジュール側のフックは**不要** (純粋にコア側の処理)

### 10.2 インポート
- コアが JSON を読み、各 item に対して以下をモジュールに依頼する:
  1. `upgrade_payload()` を必要回数呼んで現行版に揃える
  2. `validate_payload()` で検証
  3. `index_text()` で search_text を生成
- モジュール側に「インポート開始/終了」フックは無い (ステートを持たないため)

### 10.3 ステートレスモジュールの扱い
- エクスポート対象から自動除外
- インポート時、JSON にステートレスモジュールの items が含まれていたら**警告して全件スキップ** (実装ミスの可能性も含めて検出)

### 10.4 UI 無効状態の扱い
- `core.module_enabled` は UI 利用可否であり、export / import のデータフィルタではない
- stateful module が無効でも、その items と `module_versions` は通常どおり出力・検証する
- 詳細は ADR-0012 に従う

---

## 11. モジュール追加ワークフロー (E-01 の保証)

新モジュールを追加するときの手順を再掲。**コアロジックは編集しない**(registry への列挙追加は「ロジック編集」ではなく「リスト要素追加」と扱う)。

```
src-tauri/src/modules/<id>/
├── mod.rs              ModuleBackend impl
├── payload.rs          payload 構造体 (v1, v2, ...)
├── upgrade.rs          upgrade_payload の実装
└── commands.rs         モジュール固有 Tauri コマンド (任意)

src/modules/<id>/
├── index.ts            ModuleDefinition export
├── routes/             モジュール内画面コンポーネント
├── searchAdapter.ts    SearchAdapter 実装 (isStateless = true なら不要)
└── types.ts            payload 型・API 型定義
```

そして:

1. `src-tauri/src/modules/registry.rs` の `ModuleBackend` 配列 (Arc 化済み) に **1 行追加**し、必要な Tauri コマンド関数を `generate_handler!` リストに列挙する (固有コマンド数に応じて複数行になり得る)
2. `src/modules/registry.ts` の `ModuleDefinition` 配列に `<id>Module` を **1 行追加**

これだけで完了する設計を死守する。**コアのロジック (条件分岐や型分岐) を書きそうになったら設計アラート**。
例: `if module_id == "<new>" { ... }` のような分岐をコアに書く必要が出たら、それは ModuleBackend / ModuleDefinition の契約に不足があるサイン → 契約側を拡張して解消する。

---

## 12. Phase 1 モジュールの契約サマリ

各モジュールが ModuleBackend / ModuleDefinition で何を実装するかの一覧。
詳細仕様は `requirements.md` §2.2 と `data-model.md` §10 を正とする。

コマンド名・イベント名はすべて underscore 形式 (§5.3) で統一する。

### 12.1 M-Prompt
| 項目 | 値 |
|------|----|
| `id` | `prompt` |
| `is_stateless` | false |
| `current_payload_version` | 1 |
| 固有 IPC コマンド | `prompt_render_template` (変数差し込み後の本文生成) |
| `index_text` の対象 | `body` |
| 変数名の許容文字 | **Unicode letter / number + `_`** (PR-AD / `data-model.md` §10.1)。ASCII (`topic` / `lang_1`) + CJK (`言語` / `トピック`) を許容、空白 / 記号は silently 無視 |

### 12.2 M-Link
| 項目 | 値 |
|------|----|
| `id` | `linkmemo` |
| `is_stateless` | false |
| `current_payload_version` | 1 |
| 固有 IPC コマンド | `linkmemo_open` (URL or path を OS の既定アプリで開く) / `linkmemo_normalize_target` (`file://` の path 化) |
| `index_text` の対象 | `target` (URL or path) + `body` |
| payload v1 | `{ type: "url" \| "path", target: string, body: string }`。`body`はリンク固有の任意メモ |

### 12.3 M-Memo
| 項目 | 値 |
|------|----|
| `id` | `memo` |
| `is_stateless` | false |
| `current_payload_version` | 1 |
| 固有 IPC コマンド | なし。共通items APIだけを使用 |
| `index_text` の対象 | `body` |
| payload v1 | `{ body: string }` |
| Frontend routes | `/`、`/new`、`/:itemId`、`/edit/:itemId` |

旧exportの`linkmemo/type=memo`正規化と起動時所属移行はコアの互換境界であり、Memo固有IPCや公開`StorageService`契約には追加しない (ADR-0016)。

### 12.4 M-Color
| 項目 | 値 |
|------|----|
| `id` | `color` |
| `is_stateless` | false |
| `current_payload_version` | 1 |
| 固有 IPC コマンド | (なし。変換は全てフロント JS 上で実行) |
| `index_text` の対象 | `hex` |

### 12.5 M-Hash
| 項目 | 値 |
|------|----|
| `id` | `hash` |
| `is_stateless` | **true** |
| `current_payload_version` | 1 (default 実装。items を持たないため呼ばれない) |
| 固有 IPC コマンド | `hash_compute_text` / `hash_compute_file` (進捗は **Tauri Channel `HashFileProgress`** 経由 / キャンセルは `core_cancel_operation`、ADR-0009 §2.4) |
| `index_text` | 呼ばれない (items を持たないため) |

### 12.6 M-Palette

| 項目 | 値 |
|------|----|
| `id` | `palette` |
| `is_stateless` | false |
| `current_payload_version` | 1 |
| 固有 IPC コマンド | なし。配色生成と色変換はフロント JS 上で実行 |
| `index_text` の対象 | 5 色の `hex` + `harmony` |

### 12.7 M-Mermaid

| 項目 | 値 |
|------|----|
| `id` | `mermaid` |
| `category` / 既定 | `design` / enabled |
| `is_stateless` | false |
| frontend route | `/`（直近item解決）、`/new`、`/edit/:itemId` |
| payload v1 | `{ source: string }`。UTF-8で1MiB以下 |
| 固有 IPC コマンド | `mermaid_write_file`。user-selected `.svg` / `.png`へ、20MiB以下のサニタイズ済みpreviewだけを原子的に書き込む |
| `index_text` の対象 | `source` |

SVGは現在sourceを`securityLevel: strict`で正常にrenderし、active contentと外部参照を除去した結果だけを扱う。PNGは同じSVGを白背景・2倍でlocal Canvasへ描画し、16,384px / 16,777,216画素を上限とする。構文error・再描画中・上限超過中は書出しを許可せず、書出し自体はpayloadや未保存判定を変更しない。

### 12.8 M-Diagram

| 項目 | 値 |
|------|----|
| `id` | `diagram` |
| `category` / 既定 | `design` / enabled |
| `is_stateless` | false |
| frontend route | `/`（直近item解決）、`/new`、`/edit/:itemId` |
| payload v1 | `{ xml: string, text: string }`。各UTF-8で1MiB以下 |
| 固有 IPC コマンド | `diagram_read_file` / `diagram_write_file`。user-selected `.drawio` / `.xml` / `.svg` / `.png`だけを扱う |
| `index_text` の対象 | editorから取得した`text` |

draw.io iframeはmodule UIの実装詳細だが、親との境界は`postMessage`に限定する。親はsource / origin / event順序 / request ID / sizeを検証し、editor originへTauri IPC permissionを追加しない。ファイル書込みはtemp fileのflush / sync後にatomic replaceする。
editor URLは`lang=ja`を固定し、同梱済み日本語resourceだけをsame-originから読む。PNG export requestは`currentPage: true`を必須とし、現在表示中のpageだけを画像化する。`.drawio`は全page、SVGは現在の編集pageを対象とする。

### 12.9 M-PDF Merge

| 項目 | 値 |
|------|----|
| `id` | `pdfmerge` |
| `category` / 既定 | `other` / enabled |
| `is_stateless` | true |
| frontend route | `/` |
| 固有 IPC コマンド | `pdfmerge_inspect_files` / `pdfmerge_merge_files`。進捗はTauri Channelの`PdfMergeProgress`、キャンセルは`core_cancel_operation` |
| 入力上限 | 2〜50ファイル、合計200 MiB。展開済みstreamは1個64 MiB。同一pathの重複は許可 |
| 出力契約 | user-selected `.pdf`へ同一directoryの一時ファイル経由でatomic replace。入力自身への上書きは禁止 |
| `index_text` の対象 | なし |

入力一覧と順序はfrontend stateだけに保持し、items、検索、export / importの対象外とする。各実行はUUIDのoperation IDを持ち、遅延した別operationの進捗をUIへ反映しない。結合開始時に全入力を再検証し、暗号化、署名、AcroForm / Widget、Outlines、embedded files、portfolioを検出したPDFは拒否する。

### 12.10 Stateless 開発ツール

| ID | 固有 IPC | 実行境界 |
|---|---|---|
| `codec` / `urlquery` / `datetime` | なし | Frontend同期処理 |
| `idgen` / `secretgen` | なし | Web Cryptoを乱数源とするFrontend処理 |
| `regex` / `textdiff` | なし | Web Worker + timeout |
| `jwt` / `cron` / `a11y` | なし | Frontend同期処理 |
| `http` | `http_send_request` | Rust `reqwest` + `OperationRegistry` cancel (ADR-0015) |

全11モジュールは `is_stateless = true`、`searchAdapter` なし、payloadなしとする。ローカル完結の10モジュールは `enabledByDefault = true`、ネットワーク通信する `http` のみ `false` とする。

---

## 13. 契約自体のバージョニング

`ModuleBackend` トレイトや `ModuleDefinition` インターフェースを変更することは**重い変更**である。
全モジュールに修正が必要になり、Lazy / Eager のような自動マイグレーションが効かない。

### 13.1 変更時のルール
- 新メソッド/フィールドを**既定実装/オプショナル**で追加する変更 → minor (既存モジュールに修正不要)
- 既存メソッドのシグネチャ変更 / 必須フィールド追加 → major (全モジュールの修正必須)
- minor 変更でも本書 (module-contract.md) のバージョンを上げ、改訂履歴に記録する
- major 変更は必ず ADR を切る

### 13.2 互換性の保証範囲
- Phase 1 のリリース後、ModuleBackend / ModuleDefinition の major 変更は**極力避ける**
- 必要が出た場合の検討材料: 全モジュールを移行するコスト vs 拡張で得られる便益。ADR で明示

---

## 14. オープン論点

| ID | 論点 | 決着先 |
|----|------|--------|
| Q-20 | `validate_payload()` 失敗時のエラーメッセージを多言語化する仕組み (Phase 1 は日本語固定だが将来用に検討) | 必要顕在化時 |

> Q-15 (重い処理のキャンセル機構) は ADR-0009 で **Tauri Channel + `CancellationToken` + `core_cancel_operation`** として解決済み。
> Q-16 (Shiki vs rehype-highlight) は ADR-0002 で **rehype-highlight 採用** として解決済み。
> Q-22 (`generate_handler!` 集中登録方式の PoC) は **PR #22 (Q-22 PoC: M-Hash 最小モジュール)** で本書 §5.3 通り動作することを確認済として解決。`hash_compute_text` 1 つを `modules/registry.rs` に集約登録 → CI 6 ジョブ (lint-rust / test-rust / lint-frontend / test-frontend / build-tauri ×2) green / unit test 3 件 PASS で検証完了。
> Q-23 (モジュール無効化中の挙動) は ADR-0012 で解決済み。

---

## 15. 改訂履歴

| 日付 | 版 | 内容 |
|------|----|------|
| 2026-04-26 | 0.1 | 初版ドラフト (要件 0.4 / アーキテクチャ 0.2 / データモデル 0.3 を前提) |
| 2026-04-26 | 0.2 | レビュー反映: `CoreContext` から `spawn_blocking` / `logger` を削除しトレイトオブジェクト互換に / Tauri コマンド登録方式を `registry.rs` での集中 `generate_handler!` 列挙に変更し PoC 必須事項として明記 §5.3 / コマンド命名を `<id>_<action>` (snake_case) に統一し論理名と実装名を一致させた / `ScopedStorage` の保持戦略 (コマンド毎に都度生成、長期保持しない) を明記 §5.1 / `list_items` の `project_id` を必須化 (横断はコア SearchService の責務) §5.1 / ステートレスモジュールでの `list_items` をエラー返却に変更 §9.2 / `validate_payload` のログ規定を「reason に詳細を含めて呼び出し側でログ集約」に修正 §3.2 / `searchAdapter` を optional 化し古い payload のフォールバックを最低基準 (title のみ) に弱めた §4.1 / §4.2 / `enabledByDefault` を Phase 1 では将来用メタとして扱う旨を明記 §4.1 / フロント `core:*` 禁止文言を「モジュール配下 UI からの直接呼び出し」に限定 §6.2 / 「コアコードは編集しない」を「コアロジックは編集しない」に修正 §11 / Q-15 をキャンセル機構特化に整理し Q-22 / Q-23 を新規起票 (Q-21 はオープン論点に残さず §4.2 で fallback 規約を確定したため取り下げ) / data-model.md §13.7 の参照を最新ナンバリングで確認済み |
| 2026-04-26 | 0.3 | レビュー反映: §6.1 の `CoreContext::spawn_blocking` 残存を `tauri::async_runtime::spawn_blocking` 直接呼び出しに修正 / §6.1 の `<id>:*` 残存を `<id>_*` に修正 / §3.4 の logger 記述を「tracing マクロ直接利用」に修正 / §12 の Phase 1 モジュールサマリのコマンド名・イベント名を全て underscore 形式に統一 / `ScopedStorage` を `&dyn ModuleBackend` から `Arc<dyn ModuleBackend>` ベースに変更しライフタイムパラメータを廃止 §5.1 / `CoreContext` トレイト自体を Phase 1 では持たない方針に変更し §5.2 を「共有コンテキストオブジェクトは持たない」に書き換え / `id()` の制約からハイフンを除外し英小文字 + 数字のみに §3.2 / 未来バージョン検出時の `AppError::UnsupportedFuturePayloadVersion` を §7.3 に明文化 / SearchAdapter「両バージョン対応」表現を §4.2 のフォールバック方針に揃えた §7.1 / §11 の registry 1 行追加表現を「ModuleBackend 1 行 + コマンド関数複数行を generate_handler! に列挙」と正確化 / M-Hash の current_payload_version 表記を「1 (呼ばれない)」に修正 §12.4 |
| 2026-04-30 | 0.4 | ADR-0009 受理反映: §5.2 のキャンセル機構行を Q-15 から ADR-0009 ベースに更新 / §6.1 の spawn_blocking 行から「Q-15 で別途決定」を削除し ADR-0009 §2.3 規約参照に置換 / §12.4 の M-Hash 進捗を Tauri Channel `HashFileProgress` ベースに更新 (`hash_file_progress` Event 表記を撤去) / §14 から Q-15 を削除 (ADR-0009 で決着) |
| 2026-05-07 | 0.5 | PR #22 (Q-22 PoC: M-Hash 最小モジュール) 完了反映: §14 から Q-22 を削除し脚注に「PR #22 で動作確認済」を追記。`generate_handler!` 集中登録方式が本書 §5.3 通り機能することを CI 6 ジョブ green / unit test 3 件 PASS で検証完了 |
| 2026-08-22 | 0.6 | ADR-0012 を反映。`enabledByDefault` を `settings.json` の既定値として有効化し、無効時の search / routing / export / import 契約と全モジュール共通の project route を明記。残っていた colon 形式の invoke 例を underscore 形式へ修正し、Q-23 を解決済みに移動 |
| 2026-08-22 | 0.7 | §12.5 に stateful な M-Palette 契約を追加。共通 items CRUD を使い、固有 IPC とコア DB スキーマ変更を持たないことを確定 |
| 2026-08-23 | 0.8 | ADR-0014 / ADR-0015を反映。`ModuleDefinition.category`をoptional metadataとして追加し、stateless開発ツール11種とHTTP IPC境界を§12.6へ追加 |
| 2026-08-25 | 0.9 | ADR-0016を反映。M-Link payloadから単独Memoを除外し、共通items APIのみを使うM-Memoと4つのFrontend routeを追加。公開Storage / ModuleDefinition契約は不変 |
| 2026-09-01 | 1.1 | MermaidのSVG / 白背景2倍PNG書出しIPC、draw.io日本語固定、現在page PNG契約を追加 |
| 2026-08-31 | 1.0 | ADR-0017を反映。M-Mermaid / M-Diagramのstateful payload、route、検索、local file IPC、postMessage隔離契約を追加 |
| 2026-09-02 | 1.2 | ADR-0018を反映。M-PDF Mergeのstateless契約、固有IPC、進捗・cancel、入力上限、通常PDF限定、atomic outputを追加 |
