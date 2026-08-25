# ADR-0016: Link / Memo 分離と限定的なモジュール所属移行

- **Status**: Accepted
- **Date**: 2026-08-25
- **Related**: requirements D-03 / D-08 / ADR-0006 / ADR-0011 / ADR-0012 / ADR-0014

## Context

公開済みの `linkmemo` は URL / Path / 単独Memoを同じ一覧で扱っていた。登録数が増えると種類の判別が負担になり、長いMemoをモーダルで表示・編集する構成も読みづらい。一方、ID変更は既存設定・export・itemsの互換性を壊す。

ADR-0011は既存値の書換えを通常のDB schema migrationから除外しており、D-03も例外を新ADRへ記録することを要求する。本件はテーブルやカラムではなく `items.module_id` とpayloadの所属変更であり、payloadのEager-on-Readだけでは実行できない。

## Decision

- 公開済みID `linkmemo` はLink用として維持し、URL / Pathと任意のリンクメモだけを扱う。新規ID `memo` を追加し、単独Memoを一機能一モジュールとして分離する。
- `db_schema_version` とexport `schema_version` は変更しない。
- 起動時、`linkmemo` かつ `payload.type = "memo"` の行がある場合だけ、`pre-split-linkmemo` pre-opバックアップを取得する。バックアップ失敗時は移行を開始しない。
- 対象行を単一トランザクションで `memo` へ再所属し、payload v1を `{ "body": string }` に正規化する。ID、project、title、tags、created_at、updated_atと各集合内の相対順序を保持し、Link / Memoそれぞれのpositionを密な連番へ直す。
- search_textをMemo契約で再生成し、既存FTSトリガで所属と索引を同じトランザクション内に同期する。これはユーザー編集ではないため `updated_at` と `data_revision` を増やさない。
- 変換不能payloadまたはSQL失敗は全件ロールバックし、通常画面を表示せず既存の起動失敗経路で停止する。再起動時は未移行行だけを判定する。
- export schema v1の旧 `module_id=linkmemo` / `type=memo` はimportのmodule解決前に `memo` payload v1へ正規化する。新規exportは `linkmemo` と `memo` を別々に出力する。
- 旧設定で `linkmemo` の有効状態が明示され、`memo` が未設定の場合だけ同値を継承する。以後は個別設定として保存する。
- この例外はLink / Memo分離に限定する。一般的な値書換えをADR-0011のadditive migrationへ持ち込む根拠にはしない。

## Consequences

- 既存利用者は手作業なしで単独Memoを新画面へ移行でき、Linkに付随する任意メモはそのまま残る。
- 旧版へのダウングレード移行は提供しない。必要時はpre-opバックアップを復旧手段とする。
- 共通 `ModuleDefinition` / `StorageService` / items APIは変更しないが、起動、検索、設定、export/importの結合テストが必要になる。
