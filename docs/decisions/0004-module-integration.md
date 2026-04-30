# ADR-0004: モジュール統合方式 (ビルド時静的 + 共有 items + 集中コマンド登録)

- **Status**: Accepted
- **Date**: 2026-04-30
- **Deciders**: zredjet
- **Related**: ADR-0001 (Tauri v2) / `requirements.md` D-01 / D-02 / E-01〜E-04 / `architecture.md` §4.4 / §5 / `data-model.md` §6 / `module-contract.md` 全体

---

## 1. Context

本アプリは **「コア + モジュール」構造** を採用する (要件 §1.3 設計の中心思想 #3)。
新機能 (例: 将来追加されるスニペット管理 / RSS リーダ等) はコアを編集せずモジュール追加で対応できることを目指す (E-01)。
本 ADR ではモジュール統合の 3 つの根本方針を確定する:

1. **モジュールローディング方式** — ビルド時に静的に組み込むか、ランタイムに動的読み込みするか
2. **データレイアウト方式** — 全モジュールが共有する `items` テーブル + JSON payload か、モジュール毎の専用テーブルか
3. **Tauri コマンド登録方式** — 各モジュールが builder にコマンドを継ぎ足すか、registry で集中列挙するか

選定に効く制約:

| 制約 | 趣旨 |
|------|------|
| 個人ローカルツール | プラグイン市場・サンドボックス・サードパーティ実装の受け入れは不要 |
| 軽量性・配布シンプルさ (D-04) | アプリは portable 差し替えで更新。プラグインの動的取得は要件外 |
| 「コアを書き換えずモジュール追加」(E-01) | モジュール追加コストを 1 行追加レベルに抑える |
| データ移行不要原則 (D-03 / D-11) | モジュール追加・更新で DB スキーマが変わらない構造 |
| 排他制御モデル (data-model.md §13.7) | モジュールが共通の StorageService 経由でのみ書き込む |
| Rust + Tauri v2 制約 | `generate_handler!` マクロの挙動・モジュールごとの builder 拡張可能性 |

## 2. Decision

| 軸 | 採用 | 関連決定 |
|---|------|---------|
| モジュールローディング | **ビルド時静的組み込み** | D-02 |
| データレイアウト | **共有 `items` テーブル + JSON `payload`** | data-model.md §6 / D-11 |
| Tauri コマンド登録 | **registry.rs での `generate_handler!` 集中列挙** | module-contract.md §5.3 / Q-22 |
| モジュール ↔ コア境界 | **`Arc<dyn ModuleBackend>` + `ScopedStorage`** | module-contract.md §5.1 |
| モジュール追加で編集が必要なコア側ファイル | **`registry.rs` / `registry.ts` の 2 つに限定** (内部の編集行数は固有コマンド数等で変動) | architecture.md §5.1 |

### 2.1 ビルド時静的組み込み (D-02)

- 全モジュールはアプリと同じ Rust crate / TS バンドルにコンパイルされる
- 動的ロード (dlopen / wasm runtime / plugin 市場) は提供しない
- アプリのリリース単位でモジュールが増減する。ユーザーがアプリ実行中にモジュール追加することはない
- enable/disable UI は Phase 1 では提供しない (`enabledByDefault` は将来用フィールド、`module-contract.md` §4.2)

### 2.2 共有 items テーブル + JSON payload (data-model.md §6 と整合)

```
items (
  id, project_id, module_id,
  title, tags, search_text,
  payload_schema_version, payload (JSON),
  created_at, updated_at
)
```

- 全モジュールは `module_id` で行を区別する単一テーブルを共有
- モジュール固有フィールドは `payload` カラム (JSON 文字列) に格納
- スキーマ進化は payload 内で完結 (D-11 Eager-on-Read)
- モジュール追加時に DB スキーマ変更が発生しない (E-04)

### 2.3 集中コマンド登録 (Q-22 を本 ADR で確定)

```rust
// src-tauri/src/registry.rs
pub fn register_all(builder: tauri::Builder<impl tauri::Runtime>) -> tauri::Builder<impl tauri::Runtime> {
    builder.invoke_handler(tauri::generate_handler![
        // core
        core::commands::list_projects,
        core::commands::create_project,
        core::commands::search,
        core::commands::export_data,
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

- `generate_handler!` マクロは**全コマンドを 1 か所で展開する**設計を前提とする (Tauri v2 の標準パターン)
- モジュールごとに `builder.invoke_handler(...)` を継ぎ足す方式は採らない
- コマンド名は `<module_id>_<action>` (snake_case) で、Rust 関数名・Tauri コマンド名・フロント `invoke` 文字列を完全一致させる
- 名前空間衝突はコンパイル時 (関数名重複) または `generate_handler!` 展開時に検出される

### 2.4 モジュール追加ワークフロー

1. `src-tauri/src/modules/<id>/` に Rust 実装 (`mod.rs` / `payload.rs` / `upgrade.rs` / `commands.rs`)
2. `src/modules/<id>/` に TS 実装 (`index.ts` / `routes/` / `searchAdapter.ts` / `types.ts`)
3. `src-tauri/src/modules/registry.rs` を編集: ModuleBackend 配列に `Arc::new(<Id>Module)` を追加 + 固有コマンド関数を `generate_handler!` リストに列挙 (コマンド数に応じて複数行)
4. `src/modules/registry.ts` の `ModuleDefinition` 配列に `<id>Module` を追加 (通常 1 行)

**コアサービス・既存モジュールのコードは編集しない**。コアの新規ロジック分岐 (`if module_id == "<new>" { ... }`) を書きそうになったら、それは ModuleBackend / ModuleDefinition の契約に不足があるサインとして検出する (`module-contract.md` §11)。
編集が registry.rs / registry.ts に閉じていれば、行数は問わない。

## 3. Alternatives Considered

### 3.1 モジュールローディング方式

| 候補 | 評価 |
|------|-----|
| **ビルド時静的 (採用)** | 配布が単一バイナリで完結。プラグイン署名・ABI 互換・サンドボックスを考えなくてよい。個人ツールに最適 |
| Tauri Plugin システム (動的) | Tauri v2 の plugin 機能は強力だが、別 crate / 別バージョン管理 / 別ビルドが必要。本アプリのモジュールは「アプリの機能」であり外部配布物ではないため過剰 |
| dlopen / cdylib | C ABI 経由の動的ロード。Rust 同士でも ABI 安定性が保証されないため壊れやすい。プラグイン市場のような構造を作りたい場合のみ意味がある |
| WASM ランタイム同梱 (wasmtime 等) | サードパーティ製モジュールを安全に動かすには有効だが、実行コスト + 依存サイズ + IPC 設計の複雑化で個人ツールには不適 |
| Lua / JavaScript スクリプティング | ユーザーに簡単な拡張を書かせる用途には便利だが、本アプリの機能モジュールには不向き |

→ **ビルド時静的を採用** (D-02 で確定済を本 ADR で正式に記録)。

### 3.2 データレイアウト方式

| 候補 | 評価 |
|------|-----|
| **共有 `items` + JSON payload (採用)** | モジュール追加で DB スキーマ変更不要 (E-04 を実装可能にする中心メカニズム)。`title` / `tags` / `created_at` などの共通カラムでクロスカット (検索 / 一覧 / エクスポート) が統一できる。`json_extract()` でモジュール固有フィールドにもアクセス可能 |
| モジュール毎の専用テーブル | 型安全 / インデックス自由度 / クエリの可読性で勝るが、モジュール追加で DB schema migration が必須になり E-04 / D-03 と矛盾。検索やエクスポートのコア処理が「モジュール毎にテーブル名を組み立てる」コードになり、コアからモジュールへの依存が出る |
| Document DB 風 (1 テーブル / すべて JSON) | コア共通カラム (title / tags) も JSON に閉じ込める案だが、UI 一覧表示 / ソート / フィルタの度に `json_extract()` が要り、SQLite での性能と可読性で劣る |
| ORM (sea-orm / diesel) でエンティティ毎にテーブル | ADR-0003 で却下した方向と同じ理由で採用しない (オーバーヘッド) |

→ **共有 `items` + JSON 採用**。性能スケーリングの上限と苦しくなる境界は data-model.md §6.6 で文書化済み。逃げ道として「モジュール専用テーブルの例外」を限定的に許可する規定もある (architecture.md §6.6)。

### 3.3 Tauri コマンド登録方式

| 候補 | 評価 |
|------|-----|
| **registry.rs での集中 `generate_handler!` (採用)** | Tauri v2 のマクロ展開と最も親和性が高い。モジュール毎の `builder.invoke_handler(...)` 連鎖と異なり、macro が 1 回だけ走るためコマンド衝突をコンパイル時に検出できる |
| モジュール毎の `tauri_commands()` 関数 + builder 連鎖 | 当初検討した API。`builder.invoke_handler(...)` を複数回呼べるかが Tauri v2 で保証されない / `generate_handler!` のマクロ展開と相性が悪い (前回の `module-contract.md` 0.1 で書いていた案を 0.2 で取り下げ) |
| 動的ディスパッチ (名前 → 関数ポインタの HashMap) | 全コマンドをまず `Box<dyn Fn>` に集めて HashMap を作り、Tauri の `manage(state)` 経由でディスパッチする実装。マクロを使わない自由度は高いが、Tauri のシリアライズ・State 注入・エラー処理の自動化恩恵を失う |
| Tauri Plugin 化 | 各モジュールを Tauri Plugin として実装する案。3.1 と同じ理由で却下 (個人ツールでは過剰) |

→ **集中 `generate_handler!` 採用** (Q-22 で本 ADR の Validation Criteria の 1 つとして PoC を要求)。

### 3.4 モジュール ↔ コア境界の API 形

| 候補 | 評価 |
|------|-----|
| **`Arc<dyn ModuleBackend>` + `ScopedStorage` (採用)** | registry が Arc で一元保持し、コマンド毎に clone を `scoped_for` に渡す。await / spawn_blocking をまたいでも安全 (`module-contract.md` §5.1) |
| `&'a dyn ModuleBackend` (借用ベース) | ライフタイムパラメータが async / Tokio タスク跨ぎで複雑化。0.1 で検討したが 0.3 で取り下げ |
| `Box<dyn ModuleBackend>` (所有移動) | 1 度移動すると registry に残らず複数コマンドで使い回せない |
| 静的 dispatch (各モジュールが具象型を持つ generics 化) | コア側が `M: ModuleBackend` の generic を取ると、コードが膨らみ動的なモジュール一覧表示が辛くなる |

→ **`Arc<dyn ModuleBackend>` 採用**。

## 4. Consequences

### 4.1 Positive
- **モジュール追加コストが極端に低い** (新ディレクトリ 2 つ + registry 1 行追加 × 2)。コアロジックを書き換えずに機能拡張できる
- DB スキーマ変更が原則発生しない (E-04) ため、データ移行不要原則 (D-03) が守りやすい
- 検索・エクスポート・一覧表示などのクロスカット処理がコアに統一される。モジュール毎に重複実装しなくてよい
- `Arc<dyn ModuleBackend>` で registry を一元保持するため、Tauri コマンドからモジュール解決が安定して可能
- `generate_handler!` の集中列挙によりコマンド衝突がコンパイル時に検出される

### 4.2 Negative / Risks
- **`generate_handler!` の集中登録方式が Tauri v2 で期待通り動くかは PoC 必要 (Q-22)**: マクロ展開規模が大きくなったときのコンパイル時間 / エラーメッセージの可読性は実装前に検証する
- **モジュール毎のローカル状態を持ちたくなった場合に窮屈**: `is_stateless = false` のモジュールは items + payload 経由でしか永続化できない (専用テーブルを切らない方針 §3.2)。本当に items で表現できないデータが出てきたときは「items 例外」として ADR で承認を要する
- **モジュール独立性が「規約」依存**: コア / 他モジュールへの import を禁止しているが (`module-contract.md` §6.2)、コンパイラは強制しない (Rust の workspace で crate 分離するか、TS の eslint rule で禁止する程度)
- **コマンド名の衝突は人間がレビューで防ぐ必要**: 命名規則 `<module_id>_<action>` で衝突は起きにくいが、複数モジュールで同じ action 名を使うのは避けるべき (例: `prompt_open` と `linkmemo_open` は OK だが、両方が `open` のような無名前空間関数を作ると混乱する)
- **モジュール無効化機能が無い**: Phase 1 では全モジュール常時有効。「特定モジュールだけ非表示にしたい」要望が出たら ADR-0004-amendment が必要

### 4.3 Neutral
- ステートレスモジュール (D-06 の M-Hash) は items テーブルに何も書かないが、仕組み上「該当モジュールのみ書き込み API がエラー」になるだけで、設計はクリーンに収まる
- フロント側のモジュール独立性は React Router のネストルーティングと shadcn コンポーネントの一般性で十分担保できる

## 5. Mitigations

| リスク | 対策 |
|-------|------|
| `generate_handler!` PoC | Phase 1 最初期に **M-Hash の `hash_compute_text` 1 コマンドのみ**を実装し、registry.rs の集中登録方式で動くことを確認する。動かない場合は本 ADR を 2.0 で改訂し、代替方式を選定 |
| items + JSON で表現できないデータ | 「items 例外」として data-model.md §6.6 に逃げ道を文書化済。例外を発動するときは必ず ADR で記録 |
| モジュール独立性の規約破り | レビュー時のチェックリスト化。可能なら eslint rule (TS) / dependency-check スクリプト (Rust workspace) で機械的に弾く (Phase 1 着手時に検討) |
| コマンド名衝突 | コマンド名を `<module_id>_<action>` (snake_case) に統一し、レビュー時に prefix を確認 (`module-contract.md` §5.3 表) |
| モジュール無効化要望が顕在化 | 顕在化した時点で ADR を起こし、無効化中の items / 検索 / export / routing / IPC 動作を網羅的に定義 (`module-contract.md` Q-23) |

## 6. Validation Criteria

Phase 1 終了時点で以下を確認する:

- **モジュール追加時のコア側編集が `src-tauri/src/modules/registry.rs` と `src/modules/registry.ts` に限定されている**こと
  - registry 内の編集行数は問わない (固有コマンドを `generate_handler!` に列挙するため複数行になり得る)
  - 重視するのは「コアサービスや既存モジュールのコードに**新モジュール固有の分岐が入らない**こと」
- 4 モジュール (M-Prompt / M-LinkMemo / M-Color / M-Hash) の追加・改修により、コア (`src-tauri/src/core/` / `src/core/`) や既存モジュールのコードに「モジュール特有の分岐」(`if module_id == "..."` / `match module_id { "prompt" => ..., ... }` 等) が**1 件も**生まれていないこと
- `generate_handler!` の集中登録方式が Tauri v2 で動くこと (Q-22)
- M-Hash 追加時にテーブルスキーマが変わっていないこと (`is_stateless = true` で items を使わないため自然に守られる)
- M-Prompt / M-LinkMemo / M-Color の追加で **コア DB スキーマのバージョン (`meta.db_schema_version`)** が **1 のまま**であること (E-04 の実証)
  - この基準は **コアテーブル定義 (items / projects / meta / items_fts) の不変性** のみを縛る
  - 各モジュールが管理する `payload_schema_version` はモジュール固有の都合で上げてよい (例: M-Prompt の payload に新フィールドを足して v2 にする等)。本基準の対象外
  - 両者は orthogonal: コア DB スキーマは Phase 1 中ずっと 1、モジュール payload はモジュールごとに独立に進化する

達成できない場合の対応:
- コアや既存モジュールにモジュール分岐が生まれている → ModuleBackend / ModuleDefinition 契約の拡張で吸収する。それで解決しないなら本 ADR を改訂
- コア DB schema 変更が発生 → 「items 例外」として ADR を別途起こし、本 ADR の前提条件を更新

## 7. Known Concerns / 将来見直しが要りうる判断

#### 7.1 動的モジュール市場への将来移行

- 個人ツールが将来「他人が書いたモジュールを取り込める」市場を持ちたくなる可能性はゼロではない
- **懸念**: その時点では本 ADR のビルド時静的方針が制約になる
- **対応**: 顕在化したら ADR-0004 を Superseded にし、新方式 (Tauri Plugin / WASM 同梱等) を選定する別 ADR を起こす。本 ADR では「個人ツール前提」を強調し、その制約を明記済

#### 7.2 共有 items テーブルの限界がモジュールごとに異なる

- M-Prompt / M-LinkMemo / M-Color の Phase 1 モジュールは items + JSON で十分だが、将来「メディア管理」「タイムラインデータ」のような大量・特殊スキーマモジュールが入ると窮屈になる
- **懸念**: 「items 例外」を多用するとアーキテクチャの一貫性が崩れる
- **対応**: 例外発動時は必ず ADR を残す。例外が 2 件目に到達した段階で「アーキテクチャ全体の見直し」を行う閾値とする

#### 7.3 モジュール独立性のコンパイラ強制

- Rust workspace で `core_crate` / `module_<id>_crate` に分割すれば、Cargo の dependency graph で「モジュール間の直接 import」が機械的に弾ける
- **懸念**: Phase 1 では単一 crate で扱っているため、規約依存。レビューを通さないコードでも本能的に書けてしまう
- **対応**: Phase 1 で違反が 1 件でも出たら workspace 分割 ADR を起こす閾値とする
- TS 側は ESLint の `import/no-restricted-paths` ルールで `src/modules/<a>` から `src/modules/<b>` への import を弾く設定を Phase 1 着手時に入れる

#### 7.4 「1 行追加」の実体化チェック

- 本 ADR は registry への 1 行追加でモジュールが完結することを E-01 の実証指標としている
- **懸念**: 実装中に「実は registry 編集 + 別の場所も触る必要がある」と判明する場合がある (例: 設定 UI のモジュール一覧表示)
- **対応**: Phase 1 で 4 モジュール実装後に「モジュール追加時に編集が必要だった全ファイルリスト」を集計。registry 以外の編集が複数あれば本 ADR を 1.x で更新し、編集ポイントを明示する

## 8. References

- ADR-0001 (Tauri v2)
- 要件: `docs/requirements.md` D-01 / D-02 / D-06 / E-01〜E-04
- アーキテクチャ: `docs/architecture.md` §4.4 / §5 / §6
- データモデル: `docs/data-model.md` §6 / §7 / §15 (整合性テスト)
- モジュール契約: `docs/module-contract.md` §3 / §4 / §5 / §6 / §11

## 9. 改訂履歴

| 日付 | 版 | 内容 |
|------|----|------|
| 2026-04-30 | 1.0 | 初版ドラフト |
| 2026-04-30 | 1.1 | レビュー反映: §6 Validation Criteria の「`db_schema_version` が 1 のまま」を「**コア DB スキーマ** のバージョンが 1 のまま」と限定し、「各モジュールの `payload_schema_version` は独立に進化してよい」旨を明示して誤読を防止 / 「registry に 1 行追加」の表現を「**コア側編集は registry に限定 / 行数は問わない / 新モジュール固有分岐がコアや既存モジュールに入らないことを重視**」に変更 §2 表 / §2.4 ワークフロー / §6 全て一貫化 / 整合のため architecture.md §5.1 を同期 (Accepted) |
