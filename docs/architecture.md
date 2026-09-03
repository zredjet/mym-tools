# アーキテクチャ (Architecture)

最終更新: 2026-09-03 / ステータス: Draft (Phase 1)

このドキュメントは「**どのような構造で**作るか」を定義する。
「何を作るか」は `requirements.md`、「データはどう持つか」は `data-model.md`、
「モジュールはコアと何を契約するか」は `module-contract.md` に分離する。

---

## 1. 目的とスコープ

`requirements.md` の決定事項 (D-01〜D-05) を満たす構造を定義する。
特に以下の制約に対する技術的回答を与える。

- **軽量性** (起動 1.5s / 起動直後メモリ 100MB / portable ZIP各80,000,000 bytes上限)
- **モジュール独立性** (E-01〜E-04: コア改修なしでモジュール追加可能)
- **データ永劫互換** (D-03: 原則マイグレーション不要)
- **手動差し替え更新** (D-04: アプリとユーザーデータの物理分離)

---

## 2. 全体構成

```
+---------------------------------------------------------------+
|                    Tauri アプリ (1プロセス)                     |
|                                                                |
|  +-------------------------+    +--------------------------+   |
|  |  WebView (OS標準)        |    |   Rust ネイティブ層        |   |
|  |                         |    |                          |   |
|  |  React + TypeScript     |    |  Core                    |   |
|  |  ├─ Core UI             |IPC ├─ ProjectService         |   |
|  |  │  ├─ Shell / Sidebar  |◀──▶├─ SettingsService         |   |
|  |  │  ├─ ProjectSwitcher  |    ├─ StorageService (SQLite) |   |
|  |  │  └─ SearchBar        |    ├─ SearchService           |   |
|  |  │                      |    ├─ ExportImportService     |   |
|  |  └─ ModuleRegistry      |    ├─ ModuleRegistry          |   |
|  |     ├─ M-Prompt UI      |    │                          |   |
|  |     ├─ M-Link UI        |    Module Backends            |   |
|  |     ├─ M-Memo UI        |    ├─ M-Memo backend          |   |
|  |     ├─ M-Color UI       |    ├─ M-Prompt commands       |   |
|  |     ├─ M-Hash UI        |    ├─ M-Link commands         |   |
|  |     └─ M-Palette UI     |    ├─ M-Color backend         |   |
|  |                         |    ├─ M-Hash commands         |   |
|  |                         |    └─ M-Palette backend       |   |
|  +-------------------------+    +-------------┬------------+   |
|                                               │                |
+-----------------------------------------------┼----------------+
                                                │
                                +---------------▼----------------+
                                |  ユーザーデータディレクトリ        |
                                |  (OS 標準: %APPDATA% / ~/Library) |
                                |  ├─ data.sqlite               |
                                |  ├─ settings.json             |
                                |  └─ logs/                     |
                                +-------------------------------+
```

### 2.1 採用する4つの分離軸

1. **プロセス**: Tauri は単一プロセス内に WebView と Rust を同居させる(Electron 比で軽い)
2. **責務**: フロントエンドは UI / 状態提示、Rust はデータ永続化 / 重い計算 / OS統合
3. **モジュール**: コアと各モジュールを横方向に独立 (機能追加でコアを書き換えない)
4. **物理ファイル**: アプリ実行ファイルとユーザーデータを別ディレクトリに置く (D-04)

### 2.2 「やらない」構造的選択

- **マイクロサービス分割しない** — ローカル個人ツール。プロセス境界はオーバーキル
- **自前のスレッドプールを別途持たない** — Tokio が Tauri に同梱されている。これを唯一の非同期ランタイムとし、`rayon` 等の追加プールは持ち込まない (Tokio 自体は「導入する/しない」の選択肢ではなく、最初から存在する前提)
- **モジュール独自の SQLite テーブルを Phase 1 では原則作らない** — items テーブル + JSON ペイロードに統一。例外要件が出た場合のみ data-model.md で許可

### 2.3 「最初から入れる」基盤選択

後から入れると既存コードの広範な書き換えが必要になるため、Day 1 から導入する。

- **Zustand (状態管理ライブラリ)** — アプリ全体状態 (現在プロジェクト ID / 現在モジュール / テーマ / 設定) のみを管理する単一ストアを Day 1 から用意する。モジュール内ローカル状態は素の React state を使う。「全体に染み出す状態は Zustand、画面内で閉じる状態は useState」 という規律を最初から固定することで、後から「Context が散らばった useState を巻き取る」という苦しい移植を回避する

---

## 3. プロセス・スレッドモデル

| 区分 | ランタイム | 役割 |
|------|----------|------|
| メインスレッド (Rust) | Tauri ランタイム | コマンド受付、ライフサイクル、ウィンドウ管理 |
| Tokio ワーカー (Rust) | async タスク | DB I/O、ファイルハッシュ等の重い処理 |
| WebView スレッド (JS) | V8/JavaScriptCore | UI 描画と React レンダリング |

- フロントエンド → Rust の呼び出しは **すべて非同期** (`invoke` ベース)
- 長時間処理 (ファイルハッシュ計算等) は Rust 側で Tokio タスクに逃がし、
  進捗は Tauri Event でフロントへ通知する

---

## 4. レイヤ別責務

### 4.1 フロントエンド (React + TypeScript)

**持つ責務**
- 画面描画、ユーザー入力の受付
- 一時的な UI 状態の保持 (フォーム入力中の値、開閉状態 等)
- フォーム検証 (UI レイヤの体感検証のみ。最終検証は Rust 側)
- モジュール UI のロード

**持たない責務**
- ビジネスロジックの永続化 (常に Rust にコマンドを送る)
- ファイルシステム / OS API への直接アクセス (Tauri の許可リスト経由のみ)

### 4.2 IPC 境界 (Tauri Commands / Events)

- フロント→Rust: `invoke("module_action", payload)` 形式の **名前空間化されたコマンド**
- Rust→フロント: `emit` で発火する **イベント** (進捗・通知)
- すべてのコマンド名は `<module_id>_<action>` (snake_case) で一意化する。コア機能は `core_*`

例:
| コマンド | 意味 |
|---------|------|
| `core_list_projects` | プロジェクト一覧取得 |
| `core_search` | プロジェクト内 / 横断検索 |
| `core_export_json` | エクスポート (全体 or プロジェクト単位) |
| `prompt_list` | プロンプト一覧取得 |
| `prompt_render_template` | 変数差し込み後の完成プロンプト生成 |
| `linkmemo_open` | OS 既定アプリで URL / path を開く |
| `hash_compute_text` | テキストハッシュ計算 |
| `hash_compute_file` | ファイルハッシュ計算 (Tokio に逃がす) |

**コマンドの粒度ルール**: 1コマンド = 1ユースケース (1画面の1操作)。
小さな CRUD を細切れに作らない (フロント・バック往復が増えると軽量性が損なわれる)。

### 4.3 Rust コア

**Core が提供するサービス**

| サービス | 責務 |
|---------|------|
| `ProjectService` | プロジェクトの CRUD、現在プロジェクトの解決 |
| `SettingsService` | 設定の読み書き (JSON ファイル) |
| `StorageService` | SQLite 接続、トランザクション、items テーブルへの統一 CRUD |
| `SearchService` | items テーブルに対する全文検索 (プロジェクト内 / 横断) |
| `ExportImportService` | アプリ全体 / プロジェクト単位のエクスポート / インポート |
| `ModuleRegistry` | 起動時にモジュールバックエンドを束ねて Tauri に登録 |

**コアが知らないこと**
- 各モジュールが扱うデータの**意味**(プロンプトとリンクの違いを知らない)
- モジュール固有のフィールド構造 (JSON ペイロードとして不透明に扱う)

### 4.4 モジュールバックエンド

各モジュールは Rust 内で独立した crate (またはモジュール) として実装される。

**モジュールが提供するもの**
- 自身の Tauri コマンド (`<id>_*`)
- コアの `StorageService` を使った永続化 (直接 SQLite を触らない)
- 検索対応のための「インデックス対象テキスト」生成関数 (詳細は `module-contract.md`)
- エクスポート時の payload シリアライズ / インポート時の検証

**モジュールが守る制約**
- 他モジュールに直接依存しない (E-03)
- SQLite に独自テーブルを切らない (Phase 1 では items テーブル + JSON で統一。例外は data-model.md で明記)
- グローバル状態を持たない (StorageService 経由)

---

## 5. モジュールレジストリ

### 5.1 ビルド時静的登録 (D-02)

モジュールはビルド時に**コードとして**列挙される。動的読み込みは行わない。

```rust
// 概念コード: src-tauri/src/modules/registry.rs
pub fn register_all(builder: tauri::Builder) -> tauri::Builder {
    builder
        .invoke_handler(tauri::generate_handler![
            modules::prompt::commands::list,
            modules::prompt::commands::create,
            // ...
            modules::linkmemo::commands::list,
            modules::hash::commands::compute_text,
        ])
}
```

```typescript
// 概念コード: src/modules/registry.ts
export const modules: ModuleDefinition[] = [
  promptModule,
  linkMemoModule,
  colorModule,
  hashModule,
  paletteModule,
];
```

**新モジュール追加の手順 (E-01)**
1. `src-tauri/src/modules/<id>/` に Rust 実装を追加
2. `src/modules/<id>/` に React 実装を追加
3. `src-tauri/src/modules/registry.rs` を編集 (ModuleBackend 追加 + 固有コマンドを `generate_handler!` に列挙、コマンド数で複数行)
4. `src/modules/registry.ts` の ModuleDefinition 配列に追加 (通常 1 行)
5. **コアサービス・既存モジュールのコードは編集しない**

モジュール追加で編集されるコア側ファイルは **`registry.rs` / `registry.ts` の 2 つに限定**される。registry 内の編集行数は問わない (固有コマンド数で変動)。コアサービスや既存モジュールに新モジュール固有の分岐が入るなら設計のアラートとして扱う (詳細は ADR-0004)。

フロントエンドでは `registry.ts` を Shell / router / search / settings / 起動復元の唯一の列挙元とする。ユーザーが無効化したモジュールはこれらの通常 UI 経路から除外するが、静的登録済み backend と既存データは維持する (ADR-0012)。全モジュールの route は stateless を含め `/projects/:projectId/m/:moduleId/*` 配下に置く (D-01)。

### 5.2 モジュールの形 (フロントエンド側)

```typescript
// 概念定義: 詳細は module-contract.md
type ModuleDefinition = {
  id: string;                     // registry 内で一意な module ID
  displayName: string;            // "プロンプト管理"
  icon: React.ComponentType;
  category?: ModuleCategoryId;    // 表示専用。省略時は other
  enabledByDefault: boolean;
  routes: ModuleRoute[];          // モジュール内画面
  searchAdapter?: SearchAdapter;  // 横断検索の表示形整形
};
```

### 5.3 モジュールの形 (Rust 側)

```rust
// 概念定義: 詳細は module-contract.md
pub trait ModuleBackend {
    fn id(&self) -> &'static str;
    fn index_text(&self, payload: &serde_json::Value) -> String;  // 検索インデックス用
    fn validate_payload(&self, payload: &serde_json::Value) -> Result<()>;
}
```

---

## 6. データアクセスモデル (概略)

詳細は `data-model.md` で定義する。ここでは構造方針のみ記す。

### 6.1 ハイブリッド戦略

```
items テーブル (共通カラム + JSON ペイロード)
├── id                       共通
├── project_id               共通 (D-01: 全モジュールがプロジェクト所属)
├── module_id                共通 (どのモジュールの項目か)
├── title                    共通
├── tags                     共通 (TEXT, JSON 配列)
├── created_at               共通
├── updated_at               共通
├── search_text              共通 (モジュールが index_text() で生成)
├── payload_schema_version   共通 (この行の payload が書かれた時のモジュール内バージョン)
└── payload                  JSON: モジュール固有フィールド (構造はモジュールの自由)
```

- **共通カラム**: コアが意味を理解し、UI とエクスポートで共通に扱える
- **payload (JSON)**: モジュール固有。コアからは不透明
- スキーマ進化はほぼ常に payload 内で吸収される → コア起因のマイグレーションが発生しない (E-04 / D-03)

### 6.2 payload のバージョニング

各モジュールは自身の payload 構造のバージョン (整数、単調増加) を管理する。

- **書き込み時**: モジュールは現行バージョンの payload を書き、その値を `payload_schema_version` カラムに記録する
- **読み込み時 (Lazy Migration)**:
  - 行の `payload_schema_version` がモジュールの現行バージョンより古ければ、モジュール側のアップグレード関数を順次適用してアプリ内オブジェクトに変換する
  - **DB 上の行を即座に書き換えない**。次回その行が更新されるタイミングで自然に最新版に上書きされる
  - これにより「アプリ起動時に DB を一括書き換え」という重い処理が発生せず、D-03 (データ移行不要原則) を侵さない
- **対象範囲**: payload 内部の構造変更のみ。共通カラムの変更は別管理 (コア DB schema)
- **運用ルール**: payload を変更するときは必ずバージョンを上げ、対応するアップグレード関数を実装する。詳細フォーマットは `module-contract.md` で定義

### 6.3 トランザクションと FTS5 の整合性

**ルール**: items テーブルへの INSERT / UPDATE / DELETE と、FTS5 仮想テーブルへの対応する更新は **必ず同一トランザクション内で完結する**。アプリケーションコードで個別に書き分けない。

実装方針:
- SQLite の **AFTER INSERT / AFTER UPDATE / AFTER DELETE トリガ** を items テーブルに張り、FTS5 への反映を自動化する
- トリガはトランザクションの一部として実行されるため、items 側のロールバックは FTS5 側もロールバックされる
- アプリケーションコードが FTS5 を直接触ることを禁止する (StorageService の内部実装の詳細にする)

詳細トリガ定義は `data-model.md`。

### 6.4 検索

- 共通カラム + `search_text` に対して SQLite FTS5 を貼る
- プロジェクト内: `WHERE project_id = ?` を付ける
- 横断: 付けない
- モジュールフィルタ: `WHERE module_id IN (...)`

### 6.5 ステートレスモジュールの扱い (D-06)

D-01 により Hash もプロジェクト配下に置かれる。Phase 1 では Hash モジュールは items テーブルに**何も保存しない** (D-06 で確定)。プロジェクトは UI 上の所属(サイドバーの位置)としてのみ扱う。

ステートレスモジュール用の取り扱いとして、ModuleBackend に `is_stateless: bool` のような印を入れて、エクスポート/インポート対象から除外できるようにする。

### 6.6 性能スケーリングの見通し

「共有 items + JSON ペイロード」構成が苦しくならない範囲を明示しておく。

| 観点 | 余裕がある範囲 | 備考 |
|------|------------|------|
| 全項目数 | 数十万件 | SQLite + FTS5 はミリ秒級。共通カラムインデックスで O(log n) |
| プロジェクト数 | 数千〜数万 | `project_id` インデックス前提 |
| 1プロジェクト内項目数 | 1万〜10万 | DB 側ではなく **UI のリスト描画が先に頭打ち**。仮想スクロール導入で延命 |
| 1項目の本文長 | 〜1MB | TEXT 上限は実質無制限。FTS5 トークナイズが体感の限界要因 |

**設計が苦しくなる境界 (将来的な逃げ道を持っておく事項)**:
1. モジュール固有フィールドへの**式インデックスを大量に必要とする**ようになった場合
2. **巨大バイナリ (画像 / PDF / 音声等) を抱えたい**場合 — payload 直格納は不可、別テーブル or ファイルシステム参照に逃がす
3. モジュール間で**複雑な JOIN** を要求するワークフローが具体化した場合

該当が出てきたモジュールに限り、items 例外として**モジュール専用テーブルを許可する**逃げ道を data-model.md で残す。コア構造は変えない。

---

## 7. クロスカット機能

### 7.1 プロジェクト

- アプリ起動時に最後に開いていたプロジェクトを復元 (C-05)
- プロジェクト切替は単なる「現在 project_id」の更新で、UIは再フェッチ
- プロジェクトを削除すると、配下の items を**論理削除でなく物理削除**する (個人ツールのため)

### 7.2 検索 (C-02)

- 検索バーはコアが提供 (Shell に常駐)
- 既定はプロジェクト内検索、トグルで横断
- モジュールフィルタは UI チップで切替
- 結果クリックで対象モジュールのルートに遷移 (`searchAdapter` がパスを返す)

### 7.3 設定 (C-03)

- アプリ全体設定は **JSON ファイル** (`settings.json`) として保存
  - 理由: SQLite に置く必然性が低く、ユーザーが手動編集できる利点を取る
- Rust の SettingsService が起動時読込みと原子的なファイル置換を担い、フロントは Zustand に同期する
- Zustand `persist` / `localStorage` は使わず、変更は 500 ms debounce で `settings.json` へ保存する
- モジュール有効状態は `core.module_enabled`、モジュール固有設定は `modules.<id>` namespace に置く (data-model.md §11 / ADR-0012)

### 7.4 エクスポート / インポート (C-06 / D-05)

#### 形式 (Q-07 への推奨)

> **推奨**: 単一 JSON ファイル。ZIP 化はしない。

```jsonc
// 概念スキーマ (詳細は data-model.md)
{
  "schema_version": 1,
  "exported_at": "2026-04-25T12:00:00Z",
  "scope": "app" | "project",
  "projects": [
    {
      "id": "...",
      "name": "...",
      "items": [
        { "module_id": "prompt", "title": "...", "payload": { ... }, ... }
      ]
    }
  ]
}
```

**理由**:
- 現時点でバイナリ添付なし (ファイル添付機能は要件外)
- 単一テキストファイルは diff が取れる / Git で版管理できる利点が大きい
- ZIP 化は将来バイナリが入る段階で導入を再検討

**バージョン管理**:
- ルートに `schema_version` を持つ
- インポート時は schema_version を見て、必要ならコンバータを走らせる (移行は import パス内で完結し、本体 DB のマイグレーションは引き起こさない → D-03)

---

## 8. ファイル配置 (D-04 を満たすため)

### 8.1 アプリ本体 (差し替え対象)

```
macOS: MyMyTools.app/              # Tauri app。nrbf-decoderを内部へ同梱
Windows: MyMyTools.exe             # Tauri app
         nrbf-decoder.exe          # 同じフォルダに置くNativeAOT sidecar
```

### 8.2 ユーザーデータ (差し替えで失わない)

OS 標準のユーザーデータディレクトリを使用 (Tauri 標準の `app_data_dir()` 解決):

| OS | パス例 |
|----|-------|
| Windows | `%APPDATA%\mym-tools\` |
| macOS | `~/Library/Application Support/mym-tools/` |

中身:

```
<userdata>/
├── data.sqlite        # メインの永続データ (items / projects 等)
├── settings.json      # アプリ全体設定
├── logs/              # 直近Nファイルのみ保持 (起動毎にローテート)
└── exports/           # ユーザーが明示エクスポートした JSON の既定保存先
```

**重要な設計上の制約**:
- アプリ実行ファイルと同じディレクトリにユーザーデータを書かない
- DB ファイルパスはハードコードせず Tauri 標準 API 経由で解決

---

## 9. 更新機構 (D-04)

- インストーラを必須としない
  - macOS: Apple Silicon向け`.app`をportable ZIPに格納し、Applicationsへの移動 / 上書きで更新完了
  - Windows: x64 `MyMyTools.exe`と`nrbf-decoder.exe`をportable ZIPに格納し、同じ任意フォルダへの展開 / 上書きで更新完了
- GitHub Releaseは`workflow_dispatch`からversionを入力して手動実行し、tag commitの3設定と一致する場合だけ作成する (ADR-0013)
- macOS / Windowsの両portable ZIPが揃ってからdraft Releaseを作成し、アップロード成功後に公開する
- アプリ起動時に DB の `schema_version` を読み、想定外なら**起動を停止しエラー画面**を出す (黙って壊さない)
- 「新しいバージョンの取得」は OS のブラウザでリリースページを開くだけ。アプリ内ダウンローダは持たない

---

## 10. エラーハンドリング・ロギング

### 10.1 エラー方針
- Rust 側は `Result<T, AppError>` で統一。`AppError` は意味あるカテゴリで分類 (`Storage`, `Validation`, `Module(<id>)`, `Io`, `NotFound`)
- IPC 越しは `{ ok: false, code: "...", message: "..." }` の形にシリアライズしてフロントへ返す
- フロントは `code` でハンドリングを分岐し、ユーザーに見せるメッセージは表示層で整形

### 10.2 ロギング
- `tracing` クレートで構造化ログ
- ログレベルは設定で変えられる。既定は `info`
- ログは `<userdata>/logs/` に書き、サイズベースでローテート (個人ツールなので3〜5ファイルで十分)
- HTTP実験モジュールはAuthorization等を扱うため、request / responseのURL、header、bodyをログへ出さない (ADR-0015)

### 10.3 HTTP通信境界

- 任意URLへの通信は `http` モジュールのRust commandに閉じ、WebView `fetch`を使わない
- `http` / `https`だけを許可し、TLS検証無効化、cookie jar、multipart、file upload、proxy設定を提供しない
- timeout、redirect、request / response sizeを制限し、`OperationRegistry`でキャンセル可能にする (ADR-0015)

### 10.4 完全オフライン図編集境界

- Mermaid 11.17.2は画面を開いたときだけdynamic importし、300ms debounce後に`securityLevel: strict` / HTML label無効で描画する。render tokenが古い非同期結果を破棄する
- draw.io 31.4.1は固定submoduleから`.generated/public/drawio`へ決定的にprepareし、Vite `publicDir`経由でTauri assetへ埋め込む。build時にnetwork取得しない
- draw.io iframeはmoduleを開いた時だけ`127.0.0.1`のrandom portへbindするasset serverを起動し、親と異なるloopback originでlazy初期化する。serverはGET / HEAD、厳密なHost、asset pathだけを受理し、図dataは扱わない
- editor originは同梱資産読込みだけを許可するCSP `connect-src 'self'`、sandbox `allow-scripts allow-same-origin`で動かす。Tauri ACLはapp commandをlocal app originだけへ許可し、remote扱いのloopback editorにはcore / plugin IPC権限を付与しない。親との唯一のdata pathは`postMessage`
- 親は`event.source`、origin、init後のevent順序、request ID、1MiB XML/text、export受信sizeを検証する。不正messageはstateへ反映しない
- local file I/Oは`diagram_read_file` / `diagram_write_file`だけが担当し、拡張子、XML root、DTD/entity、PNG signatureを検証して同一directory内temp fileからatomic replaceする
- project export/importは共通items経路を使い、diagram binary添付やDB schemaを追加しない

### 10.5 PDF結合境界

- `pdfmerge` は既定有効のstatelessモジュールとし、入力一覧、順序、結果、履歴をitemsや設定へ保存しない
- PDF本体はWebViewへ渡さず、Rustの `pdfmerge_inspect_files` / `pdfmerge_merge_files` がuser-selected pathを読み書きする
- `lopdf 0.44`で入力順のpage treeを再構築し、page固有resource、回転、用紙サイズを維持する。出力は最小Catalogとし、文書level metadataや高度構造を引き継がない
- 暗号化、電子署名、AcroForm / Widget、Outlines、embedded files、portfolioを事前検出してファイル単位で拒否する
- 2〜50ファイル、入力合計200 MiB、展開済みstream 1個64 MiBを上限とし、結合開始時に全入力を再検証する
- `spawn_blocking`とTauri Channelを使い、`OperationRegistry`で読み込み・統合・書込み境界をキャンセル可能にする。出力は同一directoryの一時ファイルをflush / sync後、最終cancel確認を通過した場合だけatomic replaceする

### 10.6 NRBF解析境界

- `nrbf`は既定有効・`text` categoryのstatelessモジュールとし、入力path、解析結果、検索条件、履歴をitems、設定、横断検索、export / importへ保存しない
- Rustの`nrbf_inspect_file(operationId, path, expandByteArrays, onProgress)`だけを公開し、開始、500件単位のノード、完了、キャンセルをTauri Channelで通知する。`OperationRegistry`でcancelし、60秒timeout・遅延operation event破棄を保証する
- Rust wrapperは入力64 MiB、sidecar stdout 256 MiB、stderr 64 KiBを検証し、sidecar終了・破損header・上限・非対応形式を日本語`AppError::Validation { module_id: "nrbf", ... }`または`AppError::Internal`へ変換する
- .NET 10 NativeAOT sidecarは`System.Formats.Nrbf 10.0.11`の`NrbfDecoder`だけを使い、assembly / 型をロードしない。`BinaryFormatter`、`Deserialize`、任意型生成はソース検査で禁止する
- record graphは反復走査する。最初のrecordを正規ノードとし、共有参照・循環参照は参照ノードにして再展開しない。byte配列は既定で長さだけを返し、`expandByteArrays`がtrueの場合だけ最大50,000要素を展開する。多次元配列は安全に展開できない場合shapeだけを返す
- sidecar内の上限は500,000ノード、1配列50,000展開要素、1スカラー1 MiB、検索対象文字列32 MiB、protocol出力256 MiB、55秒とする。500,000個の最小ノードだけでも見積り上約128 MiBとなるため、protocol上限は256 MiBとする。部分超過では可能な解析結果を維持し、省略ノードとwarningを返す。Rust側60秒をhard timeoutとする
- 対象は先頭にNRBF headerを持つ既定`FormatterTypeStyle.TypesAlways` payloadであり、圧縮、暗号化、独自header、非ゼロ下限配列を扱わない。読み取り専用とし、編集・再シリアライズ・JSON出力を提供しない

---

## 11. 重い処理の扱い

| 処理 | 方針 |
|------|------|
| ファイルハッシュ (大ファイル) | Rust の `tauri::async_runtime::spawn_blocking` で非同期実行、進捗は **Tauri Channel** で通知、キャンセルは `tokio_util::sync::CancellationToken` + `core_cancel_operation`。詳細は ADR-0009 |
| PDF結合 | Rustの`spawn_blocking`で再検証・page tree統合・原子的書込みを実行し、Tauri Channelで`reading / merging / writing / done / cancelled`を通知する。`OperationRegistry`でキャンセルし、WebViewへPDF本体を渡さない (ADR-0018) |
| NRBF解析 | RustがNativeAOT sidecarを起動し、60秒timeout・出力量上限・cancelを管理する。sidecarは型非生成で反復走査し、RustからTauri Channelでノードbatchを通知する (ADR-0020) |
| 全文検索 | SQLite FTS5 (インメモリインデックス不要) |
| Markdown レンダリング | フロント側で同期実行。長文時の体感劣化が出たら Web Worker 化を検討 |
| エクスポート | Rust 側で生成し、UI は処理中の二重送信を防ぐ。実測で必要になった時点で件数進捗 Event / Channel を追加 |

---

## 12. Markdown レンダリング (D-09)

要件 D-09 に従い、`react-markdown` + `remark-gfm` + `rehype-highlight` を採用、raw HTML はレンダリングしない。

- `react-markdown` は既定で raw HTML を描画しない → ローカルツールでも自衛として安全
- GFM (GitHub Flavored Markdown) は技術系プロンプトで実質標準
- **rehype-highlight (highlight.js ベース) を採用** (Q-16 解決 / ADR-0002 §2 で確定)
  - バンドル軽量、CSS テーマ切替で完結し、Shiki に対して Phase 1 では十分
  - Shiki は将来コード本文を扱う別モジュール追加時に再評価する

**サニタイズ**: `react-markdown` のデフォルト (raw HTML 不可) で十分。
`rehype-raw` は導入しない (HTML 直書きの利便性 < 自衛のシンプルさ)。

---

## 13. 技術スタック確認 (要件で確定済みの再掲)

| レイヤ | 採用 |
|-------|------|
| シェル | Tauri v2 |
| UI フレームワーク | React + TypeScript |
| UI コンポーネント | shadcn/ui (Radix UI primitives + Tailwind CSS) |
| 状態管理 | Zustand (アプリ全体状態のみ。モジュール内は素の useState) |
| バックエンド | Rust (Tauri ランタイム) |
| 非同期ランタイム | Tokio (Tauri 同梱) |
| データベース | SQLite (`rusqlite` ベース、FTS5 有効) |
| 全文検索 | SQLite FTS5 (items 更新と同一トランザクション、トリガで自動同期) |
| ロギング | `tracing` |
| Markdown | `react-markdown` + `remark-gfm` + `rehype-highlight` (ADR-0002 で確定) |
| Mermaid図 | Mermaid 11.17.2、strict security、dynamic import |
| 自由図編集 | draw.io 31.4.1固定submodule、IPC権限なしloopback origin、sandboxed iframe |
| PDF結合 | `lopdf 0.44`（MSRV 1.88、`aes 0.9.2`固定、展開済みstream 64 MiB上限） |
| NRBF解析 | .NET 10 NativeAOT sidecar + `System.Formats.Nrbf 10.0.11`（NuGet lock、型非生成） |

**確定済**:
- **CI パイプライン (検証)**: ADR-0010 で確定 — GitHub Actions / lint-rust / test-rust / lint-frontend / test-frontend / build-tauri matrix (macOS + Windows) / branch protection / `clippy.toml` `disallowed-methods` 連携。NRBFは既存build-tauri 2 job内で.NET test、禁止API検査、NativeAOT起動試験も行いrequired check 6件を維持する
- **Phase 1 CD パイプライン (無署名portable ZIP)**: ADR-0013で確定 — 手動version入力 / tag commit固定 / macOS + Windows全成功後のRelease作成 / 既存Release上書き禁止
- **図編集asset / size契約**: ADR-0017で確定 — 完全オフライン同梱 / local origin隔離 / portable ZIP各80,000,000 bytes上限

**まだ未確定**:
- **公開配布向けCD拡張**: 署名・Notarization・signtool / Azure Trusted Signing統合・SHA-256 / provenance添付・secrets管理

---

## 14. 残オープン論点

`data-model.md` / `module-contract.md` / 個別 ADR で決着させる残課題。

| ID | 論点 | 決着先 |
|----|------|--------|
| Q-11 | items テーブルの具体スキーマと FTS5 のトリガ設計 | data-model.md |
| Q-12 | `ModuleBackend` トレイトと TS 側 `ModuleDefinition` の正確な API | module-contract.md |
| Q-13 | 設定 JSON の名前空間設計 (コア / モジュール) | data-model.md |
| Q-14 | プロジェクト削除時のカスケード削除トランザクション設計 | data-model.md |

> Q-15 (重い処理のキャンセル機構) は ADR-0009 で **Tauri Channel + `CancellationToken` + 専用 IPC コマンド** として解決済み。

---

## 15. 改訂履歴

| 日付 | 版 | 内容 |
|------|----|------|
| 2026-04-25 | 0.1 | 初版ドラフト (要件 0.2 を前提) |
| 2026-04-25 | 0.2 | レビュー反映: §2.2 を「やらない」と「最初から入れる」に分離し Zustand を Day 1 採用 / Tokio が同梱前提であることを明示 / §6.1 に payload_schema_version カラム追加 / §6.2 で Lazy Migration on Read を規定 / §6.3 で FTS5 と items の同一トランザクション規約をトリガで実装と規定 / §6.6 で性能スケーリングの見通しと items 例外の逃げ道を明記 / §13 に Zustand 追加 / Q-06/07/09 (要件側で D 確定) と Q-10 (rusqlite 確定) を本書から削除 / Q-16 を新規起票 |
| 2026-04-30 | 0.3 | ADR-0009 受理反映: §11 のファイルハッシュ行を Tauri Channel + `CancellationToken` + `spawn_blocking` 規約に更新 / §14 から Q-15 を削除 (ADR-0009 で決着) |
| 2026-04-30 | 0.4 | ADR-0010 受理反映: §13 の「ビルド/配布パイプライン (CI、コード署名手順)」未確定項目を「CI 確定 (ADR-0010) / CD は将来 ADR」の形に分離。CI 範囲はジョブ構成・matrix・branch protection・lint 連携を ADR-0010 で固定済 |
| 2026-08-22 | 0.5 | ADR-0013受理反映: §9をmacOS / Windows portable ZIPへ統一し、手動version入力から全OS成功後にReleaseを公開するPhase 1 CDを§13の確定事項へ追加 |
| 2026-08-22 | 0.6 | 既存モジュールへ依存しない M-Palette を静的レジストリへ追加。共通 items + payload で永続化し、固有 IPC とコア DB スキーマ変更を持たない構成を追記 |
| 2026-08-23 | 0.7 | ADR-0014 / ADR-0015を反映。表示専用category metadata、一機能一モジュールのstateless開発ツール、HTTPのRust IPC・非ログ通信境界を追記 |
| 2026-08-25 | 0.8 | ADR-0016を反映。公開ID `linkmemo` のM-Linkと新規 `memo` backend/UIを分離し、共通items APIを維持した起動時所属移行を追加 |
| 2026-08-31 | 0.9 | ADR-0017を反映。Mermaid dynamic import、draw.io固定asset / loopback origin / Tauri ACL / postMessage隔離、file I/O、80MB release契約を追加 |
| 2026-09-02 | 1.0 | ADR-0018を反映。PDF結合のRust処理、対応範囲、size上限、進捗・cancel、atomic replace、MSRV 1.88を追加 |
| 2026-09-03 | 1.1 | ADR-0020を反映。NRBFの型非生成NativeAOT sidecar、IPC・上限・cancel境界、配布構成、CI検査を追加 |
| 2026-09-03 | 1.2 | NRBF IPCへbyte配列展開許可を追加し、node上限を500,000、protocol stdout上限を256 MiBへ変更。byte配列は許可時だけ50,000要素まで展開する契約を追加 |
