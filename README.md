# MyMyTools

軽量なクロスプラットフォーム多目的 GUI ツール (個人用ローカルツール)。
プロンプト管理 / リンク・メモ / カラー選択 / ハッシュ計算をモジュール統合。

- **対象 OS**: macOS / Windows (Linux は対象外)
- **配布形式**: portable 差し替え方式 (自動更新なし)
- **データ保存**: ローカル SQLite (アプリ実行ファイルとは別ディレクトリ)
- **ライセンス**: MIT

## ドキュメント

| 文書 | 内容 |
|------|------|
| [docs/requirements.md](docs/requirements.md) | 何を作るか / 作らないか、決定事項 D-01〜D-14 |
| [docs/architecture.md](docs/architecture.md) | プロセス / スレッドモデル、レイヤ責務 |
| [docs/data-model.md](docs/data-model.md) | SQLite スキーマ、payload バージョニング、エクスポート JSON |
| [docs/module-contract.md](docs/module-contract.md) | モジュール / コア境界の API 契約 |
| [docs/ui-design.md](docs/ui-design.md) | UI トークン、画面スケルトン、キーボードショートカット |
| [docs/decisions/](docs/decisions/) | ADR-0001〜0010 (Tauri / FE スタック / rusqlite / モジュール統合 / JST タイムスタンプ / payload バージョニング / バックアップ / 配布 / キャンセル機構 / CI) |
| [CLAUDE.md](CLAUDE.md) | 作業時の不変条件と参照優先順位 |

## 開発

### 必要環境

- Node.js **22 系** LTS (`.nvmrc` 参照)
- Rust **1.83+** stable (`rust-toolchain.toml` 参照)
- macOS は Xcode CLT、Windows は MSVC build tools

### セットアップ

```bash
npm install
```

### よく使うコマンド

```bash
npm run tauri:dev          # 開発モード (Vite + Tauri)
npm run tauri:build        # リリースビルド
npm run lint               # ESLint + Prettier (check)
npm run lint:fix           # ESLint + Prettier (auto-fix)
npm run typecheck          # tsc --noEmit
npm run test               # Vitest (run once)
npm run test:watch         # Vitest (watch)
```

Rust 側:

```bash
cd src-tauri
cargo fmt --check
cargo clippy --all-targets --all-features --locked -- -D warnings
cargo test --workspace --lib --all-features --locked
```

## 開発状況

**Phase 1 着手前のリポジトリ整備完了**。

設計ドキュメントと ADR-0001〜0010 はすべて Accepted。雛形は `cargo create-tauri-app`
ベースの React 19 + TypeScript + Tailwind v4 + shadcn/ui (init は Phase 1 着手時) +
Zustand。Rust 側は rusqlite (bundled) + FTS5 / tokio + tokio-util / tracing。

CI 6 ジョブ (lint-rust / test-rust / lint-frontend / test-frontend / build-tauri ×2)
と main ブランチ保護を ADR-0010 §2.8 に従って GitHub 側で運用中。
PR 経由マージのみ受付け、6 ジョブ全 green が必須。

## 関連

- [Tauri 2 公式](https://v2.tauri.app/)
- リリース告知: GitHub Releases (公開配布判断後に運用開始)
