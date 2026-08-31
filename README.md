# MyMyTools

軽量なクロスプラットフォーム多目的 GUI ツール (個人用ローカルツール)。
保存系ツール7種と、変換・解析・生成・通信の開発ツール11種を、一機能一モジュールで統合。

- **対象 OS**: macOS / Windows (Linux は対象外)
- **配布形式**: portable 差し替え方式 (自動更新なし)
- **図編集**: Mermaid 11.17.2 / draw.io 31.4.1を全資産同梱で完全オフライン実行
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
| [docs/developer-tools-plan.md](docs/developer-tools-plan.md) | 開発ツール11モジュールの範囲、段階、品質条件 |
| [docs/release-process.md](docs/release-process.md) | 担当者向けの手動リリース手順、公開後検証、失敗時対応 |
| [docs/decisions/](docs/decisions/) | ADR-0001〜0017 (モジュール化 / HTTP通信境界 / 完全オフライン図編集) |
| [CLAUDE.md](CLAUDE.md) | 作業時の不変条件と参照優先順位 |

## 開発

### 必要環境

- Node.js **22 系** LTS (`.nvmrc` 参照)
- Rust **1.85+** stable (`rust-toolchain.toml` / `src-tauri/Cargo.toml` 参照)
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

## 手動リリース

リリースはGitHub Actionsの`Release (ref: ADR-0013)`を`main`から手動実行する。
担当者向けの準備、PR、tag作成、実行、公開確認、失敗時対応は
[docs/release-process.md](docs/release-process.md)にまとめている。

1. `package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json`のversionを同じSemVerへ更新
2. 変更を`main`へ反映し、`v<version>`タグをpush
3. Actions画面でversionを入力してworkflowを実行 (`v`は省略可)

入力・タグ・3設定のversionが一致し、macOS / Windowsの両ビルドが成功した場合だけ、
`MyMyTools_<version>_macos_aarch64.zip`と`MyMyTools_<version>_windows_x64.zip`を公開する。
既存のGitHub Releaseは上書きしない。

## 開発状況

**Phase 1 の主要機能を実装済み (`0.1.0-alpha.8`)**。

Tauri 2 + React 19 + TypeScript + Tailwind v4 + Zustand のフロントエンドと、
rusqlite (bundled) + FTS5 / tokio + tokio-util / tracing の Rust バックエンドで構成。
プロジェクト管理、カテゴリ表示付き19モジュール、横断検索、`settings.json`、バックアップ、
アプリ全体／プロジェクト単位の JSON export / import を備える。

CI 6 ジョブ (lint-rust / test-rust / lint-frontend / test-frontend / build-tauri ×2)
と main ブランチ保護を ADR-0010 §2.8 に従って GitHub 側で運用中。
PR 経由マージのみ受付け、6 ジョブ全 green が必須。

## 関連

- [Tauri 2 公式](https://v2.tauri.app/)
- リリース告知・配布: GitHub Releases (portable ZIP / 手動更新)
