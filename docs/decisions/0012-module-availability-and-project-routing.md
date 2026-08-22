# ADR-0012: モジュール有効状態とプロジェクト配下ルーティング

- **Status**: Accepted
- **Date**: 2026-08-22
- **Deciders**: zredjet
- **Related**: `requirements.md` C-04 / C-05 / D-01 / ADR-0002 / ADR-0004 / `data-model.md` §11 / `module-contract.md` §4
- **Partially supersedes**: ADR-0004 §2.1 の「enable/disable UI は Phase 1 では提供しない」という判断、および同判断を前提にした §4.2 / §5 の記述

---

## 1. Context

要件 C-04 はモジュール一覧と有効／無効切替を必須としている一方、ADR-0004 §2.1 は Phase 1 でその UI を提供しないとしていた。また D-01 は Hash を含む全モジュールをプロジェクト配下に置くが、フロントエンドには Hash だけを `/modules/hash` で開く例外経路が残っていた。

静的組み込みという ADR-0004 の中心判断は維持したまま、次を一貫した契約として定める必要がある。

- 有効状態をどこへ保存するか
- 無効化が Shell / routing / search / startup restore に与える影響
- 無効化中の既存データを export / import でどう扱うか
- 新モジュール追加時に Shell や router の列挙を編集せずに済む構造

## 2. Decision

### 2.1 有効状態は UI の利用可否であり、動的アンロードではない

- 全モジュールは従来どおりビルド時に静的組み込みし、Rust backend と Tauri command も起動時に登録する。
- ユーザーの選択は `settings.json` の `core.module_enabled.<module_id>: boolean` に保存する。
- キーが無いモジュールは `ModuleDefinition.enabledByDefault` を使う。これにより、新版で追加されたモジュールにも明示設定なしで既定値を適用できる。
- `ModuleId` は既知モジュールの union ではなく文字列契約とし、ID 形式・重複・route・stateful module の SearchAdapter 有無を registry 初期化時に検証する。

無効化は UI からの通常利用経路を閉じる機能であり、コードや backend を実行時にアンロードするセキュリティ境界ではない。

### 2.2 フロントエンド registry を唯一の列挙元にする

`src/modules/registry.ts` の `ModuleDefinition` 配列を、次の機能が共有する唯一のモジュール列挙元とする。

- サイドバー
- React Router のモジュール route
- 横断検索のモジュールフィルタと結果遷移
- 起動時の復元先
- 設定画面の有効／無効一覧
- 数字キーによるモジュール切替

アプリ本体の描画前に `core_module_ids` で Rust registry の全 ID (stateless を含む) を取得し、Frontend registry と集合が完全一致することを検証する。不一致なら起動を停止し、片側だけ登録されたモジュールを黙って提供しない。

新モジュール追加時に上記各所へ ID 分岐を追加してはならない。

### 2.3 無効化時の挙動

| 対象 | 挙動 |
|------|------|
| サイドバー / 数字キー | 対象モジュールを表示・選択しない |
| 横断検索 | フィルタ候補から除外し、対象モジュールの結果も表示しない |
| 起動復元 | `last_opened_module_id` が無効なら、registry 順の最初の有効モジュールへフォールバックする |
| 直接 URL | 無効モジュールの route は描画せず、最初の有効モジュールへ置換遷移する。全モジュール無効なら設定画面へ遷移する |
| Rust backend / IPC | 静的登録を維持する。無効化だけを認可機構として扱わない |
| export / import / backup | 無効モジュールの既存データも保持・移送する。無効化を理由にデータを欠落させない |

### 2.4 全モジュールをプロジェクト配下に置く

D-01 に従い、stateful / stateless を問わずモジュール route は次の形に統一する。

```text
/projects/:projectId/m/:moduleId/*
```

M-Hash は `items` を保存しないが、現在プロジェクトの文脈とサイドバー位置を他モジュールと共有する。`/modules/hash` のようなプロジェクト外の例外 route は設けない。

### 2.5 settings.json の保存規則

- Zustand はメモリ上の単一状態ストアとして使い、`persist` middleware / `localStorage` は使わない。
- 起動時に Rust の SettingsService から 1 回読み込み、読み込み完了前はアプリ本体を描画しない。
- 変更は 500 ms debounce 後に `settings.json.tmp` を作り、同一ディレクトリ内で原子的に置換する。
- 認識できないルート・core・modules 配下のキーは保持して書き戻す。
- 壊れた JSON や未対応の未来 `schema_version` は既定値で上書きせず、起動停止画面で再試行可能にする。

## 3. Consequences

### Positive

- C-04 / C-05 / D-01 の挙動が同じ registry と settings 契約で一貫する。
- モジュール追加時に Shell / router / search / settings の個別編集が不要になる。
- モジュールを一時的に隠しても既存データは export / import / backup に残る。

### Negative / Risks

- 無効化しても Tauri command は登録されたままであり、セキュリティ上の権限分離にはならない。
- 全モジュールを無効にできるため、設定画面を常に到達可能な例外 route として維持する必要がある。
- `core.module_enabled` と registry の既定値という 2 層を解決する共通関数が必要になる。

## 4. Validation Criteria

- registry に登録された各モジュールの route が `/projects/:projectId/m/<id>` 配下に生成される。
- Frontend / Backend registry の ID 集合が異なる場合はアプリ本体を描画しない。
- 無効モジュールが sidebar / search / startup restore / 直接 route から利用されない。
- 全モジュール無効でも設定画面へ到達できる。
- `core.module_enabled` 未指定時は `enabledByDefault` が使われる。
- 無効モジュールの items がアプリ全体／プロジェクト単位 export と import から欠落しない。
- settings の読み書きが `localStorage` を使わず、未知キーを保持する。

## 5. References

- `docs/requirements.md` C-03〜C-06 / D-01 / D-05
- `docs/decisions/0002-frontend-stack.md` §4.4.3
- `docs/decisions/0004-module-integration.md`
- `docs/data-model.md` §11〜§12
- `docs/module-contract.md` §4 / §8〜§10
