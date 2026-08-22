# ADR-0014: 一機能一モジュールとカテゴリ別ナビゲーション

- **Status**: Accepted
- **Date**: 2026-08-23
- **Related**: requirements E-01〜E-04 / ADR-0004 / ADR-0012 / module-contract §4

## Context

開発向けの小さなツールを追加するにあたり、複数機能を一つのモジュールへまとめると、個別の有効化、責任境界、将来の削除や差し替えが不明瞭になる。一方で既存 5 モジュールへ 11 モジュールを追加すると、単一の MODULES リストは長くなる。

## Decision

- 一機能一モジュールを維持し、各機能は固有 ID、route、Frontend / Backend registry entry を持つ。
- 表示上だけをカテゴリにまとめ、カテゴリは機能境界や認可境界にしない。
- `ModuleDefinition.category` は省略可能な metadata とし、未指定は `other` に分類する。
- カテゴリ定義と順序は Frontend registry を唯一の列挙元とする。
- 開閉状態は `settings.json` の `core.collapsed_module_categories` に保存する。未知 ID を保持し、初回は全展開、active module のカテゴリは自動展開する。
- stateless module も D-01 / ADR-0012 に従ってプロジェクト配下 route を使う。

## Consequences

- Shell、Settings、routing は module ID ごとの分岐を増やさない。
- DB schema、items、検索、export / import には変更がない。
- カテゴリ変更は表示変更であり、モジュール ID や保存データの互換性へ影響しない。
