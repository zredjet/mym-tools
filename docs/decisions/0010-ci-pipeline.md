# ADR-0010: CI パイプライン (検証のみ、CD は別 ADR)

- **Status**: Accepted
- **Date**: 2026-04-30
- **Deciders**: zredjet
- **Related**: ADR-0001 (Tauri v2) / ADR-0002 (Frontend stack) / ADR-0003 (rusqlite) / ADR-0008 (配布 / §2.5 で本 ADR を予告) / ADR-0009 (キャンセル機構 / §6.2 の `clippy.toml` 規約) / `requirements.md` §3.1 / §3.2 / `architecture.md` §13

---

## 1. Context

Phase 1 着手前にリポジトリ規模の検証パイプライン (CI) を確定する。
既存の決定:

| 出典 | 制約 |
|------|------|
| ADR-0008 §2.5 | 「CI 詳細は別 ADR『CI/CD・リリースパイプライン』で扱う」と予告。本 ADR がその CI 部分 |
| ADR-0008 §6.1 / §6.2 | Phase 1 は無署名ビルド許容 / 公開配布フェーズで署名 + Notarization |
| ADR-0009 §6.2 | `clippy.toml` の **`disallowed-methods`** (kebab-case の設定キー / lint 名は `disallowed_methods` のアンダースコア) に `tokio::task::spawn_blocking` / `std::thread::spawn` / `tokio::runtime::Handle::block_on` を登録し `cargo clippy -- -D warnings` で違反検出。`disallowed_methods` lint は free function も捕捉対象 |
| `requirements.md` §3.1 | 軽量性 (起動 1.5s / インストーラ 30MB) — 巨大 CI 依存追加は避けたい |
| `requirements.md` §3.2 | Linux はサポート対象外。Phase 1 では検証もテストもしない |
| ADR-0002 / ADR-0003 | フロント = React + TS + Vite + Tailwind v4 + shadcn/ui + Zustand。Rust = rusqlite (bundled + FTS5) |
| `architecture.md` §13 | ビルド/配布パイプラインは未確定 (本 ADR と将来の CD ADR で確定) |

### 1.1 本 ADR の責務分界

| 本 ADR (CI) で扱う | 別 ADR (将来の CD・リリースパイプライン) で扱う |
|------------------|--------------------------------------------|
| build / test / lint / typecheck / format チェック | コード署名 (Apple Developer / OV / Azure Trusted Signing) |
| matrix (OS / Node / Rust) | macOS Notarization |
| PR・push トリガでの required check | リリースアーティファクト生成 (DMG / NSIS / portable ZIP) |
| キャッシュ戦略 | SHA-256 リリースノート添付 |
| `clippy.toml` / `eslint.config` / `tsconfig` の CI 連携 | secrets 管理 (notarytool / signtool / Azure 認証情報) |
| dependabot 等の依存更新 (任意) | tag / semver / GitHub Release 作成 |

CD ADR は ADR-0008 §6.2 / §7.8 のとおり**公開配布判断時に着手**。本 ADR は Phase 1 着手と同時に有効化する。

**強い分離決定**: signing / notarization secret を扱う workflow は **絶対に `pull_request` トリガと同一ファイルに置かない**。CD ADR は `.github/workflows/release.yml` を別ファイルとして起こし、トリガは `release: { types: [published] }` または `workflow_dispatch` のみとする。本 ADR の `ci.yml` には secret を一切追加しない。fork PR が `build.rs` / npm `postinstall` 経由で `printenv | curl` を仕掛けて secret を steal する攻撃経路を絶つため。

### 1.2 選定に効く制約

- **個人プロジェクト**: 月額課金や運用の重い CI は避ける。GitHub Actions の標準ランナーで完結すること
- **GitHub Actions 課金の現実**: 課金は **実時間 × multiplier** (Linux=1 / Windows≒2 / macOS≒10) を Linux 換算分で合算。private repo の Free tier は 2,000 min / 月 (Linux 換算)。GitHub は 2024 年に multiplier 表記から per-minute rate 表記 (Linux $0.006 / Windows $0.010 / macOS $0.062) に切り替えており、Linux 換算比は **Linux : Windows : macOS ≒ 1 : 1.67 : 10.33** で本 ADR の試算には実質影響なし (詳細は §8 References の公式リンク参照)。本 ADR 構成での試算: PR 1 回 ≒ **約 100 分 (cache hit) / 約 156 分 (cold)** ⇒ 月 12〜20 PR で枯渇する現実性が高い。**従って Phase 1 着手時に repo を public 化することを §2.8 で前提化する** (個人ツールで支障なく、ADR-0008 の portable 配布方針とも整合する)
- **Tauri 2 ビルドの所要時間**: 初回 cold ビルドは macOS で 10〜12 分 / Windows で 8〜10 分が現実的。キャッシュ hit でも 5〜8 分は掛かる
- **キャッシュ容量**: GitHub Actions の cache limit は **10 GB / repo**。Tauri 2 + rusqlite + WebView 系で `target/` は macOS 4 GB / Windows 5 GB 級になりうるため、`shared-key` の分割粒度を粗めに保つ必要がある (§2.6)
- **既存決定との整合**: Phase 1 で署名 / Notarization / インストーラ生成は不要 (ADR-0008)。CI ではビルドが通ることのみ確認すれば十分

---

## 2. Decision

### 2.1 ジョブ構成 (採用)

| ジョブ名 (GitHub UI 表示) | 内容 | OS | 必須 (required check) |
|----------------------|------|----|--------------------|
| `lint-rust` | `cargo fmt --check` + `cargo clippy --all-targets --all-features -- -D warnings` | ubuntu-latest | はい |
| `test-rust` | `cargo test --workspace --lib --all-features` (コアロジック crate のみ。Tauri 統合バイナリは対象外、§7.10 参照) | ubuntu-latest | はい |
| `lint-frontend` | `npm ci` + `tsc --noEmit` + `eslint .` + `prettier --check .` | ubuntu-latest | はい |
| `test-frontend` | `vitest run` (フロント単体テスト) + `npm run build` (Vite ビルドが通ること) | ubuntu-latest | はい |
| `build-tauri (macos-latest)` | `cargo tauri build --no-bundle` (macOS) — matrix ジョブ展開名 | macos-latest | はい |
| `build-tauri (windows-latest)` | `cargo tauri build --no-bundle` (Windows) — matrix ジョブ展開名 | windows-latest | はい |

**設計上のポイント**:
- **lint / test は ubuntu のみ**: 高速・低コスト。プラットフォーム差異が出るのは Tauri ビルド以降
- **Tauri ビルド検証は `--no-bundle`**: バイナリが生成できることだけを確認する。DMG / NSIS / portable ZIP の生成は CD ADR の責務 (本 ADR スコープ外)
- **Linux は Tauri ビルドしない**: 要件 §3.2 で Linux はサポート対象外。lint/test は ubuntu で動かすが、配布対象 OS は macOS / Windows のみなので Tauri 統合ビルドの matrix からは除外

### 2.2 トリガ

| トリガ | 走るジョブ | 用途 |
|--------|----------|------|
| `pull_request` (target: `main`) | 全ジョブ | マージ前の必須チェック |
| `push` (`main`) | 全ジョブ | マージ後のセーフティネット (PR を介さない直 push の防衛は branch protection で担う) |
| `workflow_dispatch` | 全ジョブ | 手動実行 (緊急時 / デバッグ) |

**`paths-ignore`**: `docs/**` / `**/*.md` / `.github/ISSUE_TEMPLATE/**` を除外する。`docs/decisions/` の ADR 追記が頻繁な本リポジトリで doc-only PR が約 100 分課金になるのを防ぐ。required check と path filter の併存は GitHub の仕様で **skip = success** として扱われるため branch protection と整合する (skip された required check はマージブロックにならない)。

**`paths-ignore` から除外する CI 設定ファイル群** (これらの変更時は必ず CI を回す。`paths-ignore` で skip させない):

`.github/workflows/**` / `package.json` / `package-lock.json` / `Cargo.toml` / `Cargo.lock` / `rust-toolchain.toml` / `.nvmrc` / `clippy.toml` / `eslint.config.js` / `.prettierrc` / `vite.config.ts` / `tsconfig*.json`

これらが変更された PR は `*.md` のみの変更を含んでいても全ジョブ走行する (CI 設定変更が無検証で main に乗るのを防ぐ防衛線)。`[skip ci]` 系 PR タイトル運用は禁止する。

**`concurrency:`**: 同一 PR で連続 push したときの古い run を自動キャンセルし二重課金を防ぐ:

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.head_ref || github.run_id }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

PR の場合は古い run をキャンセル / `push (main)` の場合は完走させる (group に `head_ref || run_id` を使う)。

### 2.3 ツール / バージョン固定

| 項目 | 採用 |
|-----|------|
| CI プラットフォーム | **GitHub Actions** |
| ワークフローファイル | `.github/workflows/ci.yml` (単一ファイル) |
| Rust toolchain | `rust-toolchain.toml` で固定 (本 ADR 書記時点の参考値: `channel = "1.83"` — **Tauri 2 の最新 MSRV を必ず公式で確認**してから固定する)、CI では **`dtolnay/rust-toolchain@<sha-pin>`** (バージョン入力なし、ただし `@master` ではなく commit SHA で pin する)。意図は `rust-toolchain.toml` を真とすること (`@stable` 相当だと action 側で stable を入れた直後に rustup が toolchain ファイルを読み二重 DL になる)。`taiki-e/install-action` の `tauri-cli` は prebuilt バイナリで動くため Rust toolchain 上げで再 install は不要 |
| Node.js バージョン | `.nvmrc` で **LTS の偶数 major 1 つを完全 pin** (例: `20.18.0`)、`package.json` の `engines.node` を同じ major (`>=20 <21`) に揃える。`actions/setup-node@v4` で `node-version-file: '.nvmrc'` 指定 |
| `tauri-cli` | **`taiki-e/install-action@<sha-pin> with: { tool: tauri-cli }`** を採用。**`tauri-cli` は当該 action の managed manifest 対象外**のため、既定 fallback の **`cargo-binstall`** 経由で release バイナリが取得される (公式 README: "If a tool not included in the list above is specified, this action uses cargo-binstall as a fallback")。`Swatinem/rust-cache` は `~/.cargo/bin/cargo-tauri` を非キャッシュのため `cargo install tauri-cli` を直接使うと毎ジョブで cold install になる。Phase 1 Day 0 PoC で **macOS arm64 / Windows x64 双方で 1 分以内に取得完了するか**を実測。失敗時の逃げ道: (a) `tool: cargo-binstall` を先に install し `cargo binstall --locked tauri-cli` を別 step にする / (b) `cargo install --locked tauri-cli` への明示切替を許容 (cold install を許容する判断) |
| 最小実装ファイル | Phase 1 Day 0 で `cargo create-tauri-app` (npm + React + TS テンプレート) で雛形生成し、`src-tauri/tauri.conf.json` / `src-tauri/icons/` / `src-tauri/Cargo.toml` / `src-tauri/src/main.rs` / `src-tauri/src/lib.rs` / `src-tauri/build.rs` / `vite.config.ts` / `index.html` / `src/main.tsx` を確保する。本 ADR の CI が前提とする「最小実装」はこの雛形を基点とする (§6.1 Day 0 手順参照) |
| 第三者 action の pin | **すべて commit SHA で pin** する (例: `Swatinem/rust-cache@<40hex> # v2.7.5`)。`@master` / mutable tag 直参照は禁止 (`dtolnay/rust-toolchain@master` も含めて SHA に置き換える)。dependabot は SHA pin に対応しており、SHA を更新する PR を出してくれるためメンテ負荷は増えない。攻撃シナリオ: action maintainer 乗っ取りで `v2` tag が悪意あるコミットに付け替えられた瞬間、CI runner で任意コード実行・secret steal が成立する |
| package manager | **npm** (`package-lock.json` 必須)。pnpm / yarn は採用しない (個人ツールでの併用は混乱の元) |

### 2.4 lint 設定の中身

#### 2.4.1 Rust (`cargo clippy`)

`clippy.toml` (リポジトリ直下) に以下を登録:

```toml
# clippy.toml — 設定キーは kebab-case (`disallowed-methods`)、対応する lint 名はアンダースコア (`disallowed_methods`)
disallowed-methods = [
    { path = "tokio::task::spawn_blocking", reason = "use tauri::async_runtime::spawn_blocking instead (ADR-0009 §2.3 R-2)" },
    { path = "std::thread::spawn", reason = "use tauri::async_runtime::spawn_blocking instead (ADR-0009 §2.3 R-2)" },
    { path = "tokio::runtime::Handle::block_on", reason = "do not block Tauri runtime (ADR-0009 §2.3 R-3)" },
]
```

`disallowed_methods` lint は **method / associated function / free function すべて捕捉対象** (clippy 内部実装で `DefKind::Fn | AssocFn | Ctor(_, Fn)` を見るため)。`cargo clippy --all-targets --all-features -- -D warnings` で違反を検出。

ただし以下のケースは clippy が path 解決できず取りこぼす可能性がある:

- `use tokio::task as t; t::spawn_blocking()` のような **モジュールエイリアス経由の path 短縮**
- マクロ展開を経由した呼び出しで path 情報が失われるケース

これらに備え、CI 末尾に `grep` ベースの簡易チェックを追加する (§2.5 参照)。`use tokio::task::spawn_blocking as sb` のような **シンボルリネーム** は use 文自体が grep ヒットするので捕捉できるが、path 短縮は grep でも見逃しうるため最終的にはコードレビューが防衛線。

#### 2.4.2 Frontend (`eslint`)

- ESLint flat config (`eslint.config.js`) を採用 (Tailwind v4 / TS / React 18 と整合する Phase 1 標準)
- 既定プリセット: `@eslint/js` recommended + `typescript-eslint` recommended + `eslint-plugin-react-hooks` + `eslint-plugin-react-refresh`
- カスタムルール: フロント側でも `core_*` Tauri コマンドの直接呼び出しをモジュール配下から禁止する規約 (`module-contract.md` §6.2) を `no-restricted-imports` 等で表現するかは Phase 1 では**任意** (実装着手後に判断)

#### 2.4.3 prettier

- `prettier --check .` を CI で回す
- `.prettierrc` は最小構成 (Tailwind プラグイン **`prettier-plugin-tailwindcss` v0.6.10 以降**を `package.json` で固定 — Tailwind v4 の CSS-first config / `@theme` ディレクティブ対応がこのバージョン以降で安定)
- ESLint は `eslint-config-prettier` で format ルールを無効化し、format は prettier 単独に

### 2.5 grep ベースの追加チェック

`clippy.toml` の `disallowed_methods` で取りこぼす可能性のあるパターン (モジュールエイリアス経由の path 短縮、マクロ展開等) を補完するため、CI 末尾に以下のチェックを追加する。

**対象集合の方針**: 主 (clippy `disallowed_methods`) と副 (grep) で対象を **意図的に揃える**。例外として `rayon::*` のような **ワイルドカード禁止** は `disallowed_methods` の `path =` 単一エントリで表現しにくいため grep のみで担保する (この非対称は意図的):

```yaml
- name: Forbidden patterns (text-grep fallback)
  run: |
    set -e
    ! grep -rn --include='*.rs' \
        -e 'std::thread::spawn' \
        -e 'std::thread::Builder::spawn' \
        -e 'tokio::task::spawn_blocking' \
        -e 'tokio::runtime::Handle::block_on' \
        -e 'rayon::' \
        src-tauri/src
```

`disallowed_methods` を主、grep を副としており、grep ヒットが clippy を通過してきた場合は実装上の bug としてレビューで弾く。

**主と副の対象一覧**:

| シンボル | clippy `disallowed-methods` | grep | 補足 |
|---------|--------------------------|------|------|
| `tokio::task::spawn_blocking` | ✓ | ✓ | ADR-0009 R-2 |
| `std::thread::spawn` | ✓ | ✓ | ADR-0009 R-2 |
| `std::thread::Builder::spawn` | ✓ | ✓ | ADR-0009 R-2 (Builder 経由も禁止) |
| `tokio::runtime::Handle::block_on` | ✓ | ✓ | ADR-0009 R-3 |
| `rayon::*` (ワイルドカード) | — | ✓ | clippy `path =` で表現不能のため grep のみ。`use rayon::prelude::*` 等を含めて検出 |

### 2.6 キャッシュ戦略

| キャッシュ対象 | 鍵 | 用途 |
|--------------|-----|------|
| `~/.cargo/registry` / `~/.cargo/git` / `target/` | `Cargo.lock` + Rust toolchain (Swatinem/rust-cache が自動生成) | Rust 依存と target/ の増分化。Tauri ビルドの cold 時間を圧縮 |
| `~/.npm` (npm グローバルキャッシュ) | `package-lock.json` ハッシュ (`actions/setup-node` の `cache: 'npm'` が自動管理) | `npm ci` のパッケージ再ダウンロード抑制。`node_modules/` 自体は毎回再構築されるが、グローバルキャッシュから tar 展開のみで通常 30 秒程度で終わる |
| `~/Library/Caches/Tauri` (macOS) / `%LOCALAPPDATA%\tauri` (Windows) | Tauri / WebView 関連のキャッシュ | Tauri アセット再生成抑制 (Phase 1 では `actions/cache` で別途明示しなくても影響軽微、必要が顕在化したら追加) |

実装には `Swatinem/rust-cache@v2` (Rust 用、`Cargo.lock` 自動キー生成) と `actions/setup-node@v4` の `cache: 'npm'` を採用する。

**PR からの cache 書き込みを禁止 (キャッシュポイズニング防御)**: `Swatinem/rust-cache@<sha>` の各使用箇所で `with: { save-if: "${{ github.ref == 'refs/heads/main' }}" }` を**全ジョブで指定**する。攻撃シナリオ: 悪意ある PR で `target/` に proc-macro 中間生成物を仕込んだキャッシュを upload → `main` の次回ビルドが汚染キャッシュを fetch して任意コードを実行する経路を絶つ。10 GB 制限の議論にも整合する (PR が枠を食わない)。

**重要 (10 GB cache limit との整合)**: `Swatinem/rust-cache` の `with: { shared-key: ... }` の粒度設計:

- `lint-rust` と `test-rust` は **同じ debug profile** のため `shared-key: ubuntu-debug` に**統合**する (10 GB cache limit 圧迫を回避するため、debug profile の `target/` を 2 ジョブで共有)
- `build-tauri` は OS ごと release profile で別なので `shared-key: build-${{ matrix.os }}` で OS 別に分ける

合計サイズの目安: ubuntu-debug 1〜2 GB / build-macos 4 GB / build-windows 5 GB ≒ **10〜11 GB**。10 GB を超えると古いエントリが evict され実質的にキャッシュヒット率が下がるため、初期 PoC 後にサイズを実測して必要なら不要 feature の絞り込み (`--no-default-features` 戦略) を検討する。

**キャッシュしないもの**: `~/.cargo/bin/cargo-tauri` は `Swatinem/rust-cache` の対象外のため、§2.3 のとおり `taiki-e/install-action@v2` で prebuilt バイナリを毎回取得する (短時間で完了)。

### 2.7 ジョブ並列度と所要時間目標

- ubuntu ジョブ (lint-rust / test-rust / lint-frontend / test-frontend): 並列実行で **壁時計 5 分以内**
- macOS / Windows Tauri ビルド: キャッシュ hit で **壁時計 8 分以内**、cold でも **壁時計 15 分以内**
- 全体 (PR 作成 → 全 required check 完了): **壁時計 15 分以内** を目標

**課金分 (Linux 換算分)** はこれと別計算: cache hit で約 100 分 / cold で約 156 分相当 (PR 1 回あたり)。`paths-ignore` で doc-only PR を skip する効果と、`concurrency` で連続 push 時の古い run キャンセルでさらに圧縮できる。

達成できない場合は `target/` キャッシュ範囲の見直し / `cargo nextest` 採用の再検討 / Tauri matrix を `pull_request` のみに絞る等を §7 に従って検討する。

### 2.8 Branch Protection / Required Checks

**前提**: §1.2 で示した課金見積りより、**Phase 1 着手時に repo は public 化する** (個人ツールで支障なし、ADR-0008 §2.1 / §3.2 の portable 配布方針とも整合)。private のまま運用する場合は本 ADR の Tauri matrix 部分を `pull_request` のみに絞り、`push (main)` での Tauri ビルドを停止することで月分消費を半減できる (詳細は §5 Mitigations)。

- `main` ブランチに以下を設定する:
  - **Require pull request reviews before merging**: 個人プロジェクトで 1 人運用のため、レビュー必須化はしない (self-merge 許容)
  - **Require status checks to pass before merging**: §2.1 の全 6 ジョブを required にする。required check 名は GitHub Web UI で**ジョブ表示名の文字列完全一致**で指定する必要があるため、§2.1 表のとおり `lint-rust` / `test-rust` / `lint-frontend` / `test-frontend` / `build-tauri (macos-latest)` / `build-tauri (windows-latest)` の 6 つを登録する (matrix ジョブは `<job-name> (<matrix-value>)` 形式)
  - **Require branches to be up to date before merging**: ON (古いブランチでのマージを防ぐ)
  - **Include administrators**: ON (自分にも適用、規律のため)
  - **Allow force pushes**: OFF (`main` への force push 禁止)
  - **Allow deletions**: OFF
- 直 push を禁止し、すべての変更を PR 経由にする (個人プロジェクトでも CI を必ず通す規律)

**緊急 hotfix 手順**: GitHub Actions の外因障害 (例: macOS runner 全停止 6h 復旧見込) 等で CI が回せない場合の対処を以下に固定する:

1. Settings の Branch protection で `Include administrators` を**一時的に OFF**
2. hotfix を `main` に直 push
3. **24 時間以内**に `Include administrators` を再度 ON に戻し、Issue に「障害理由 / 対応 commit SHA / 再 ON 時刻」をログとして残す

`Allow specified actors to bypass required pull requests` は**使わない方針**を維持する (例外経路を増やすほど不正利用余地が増えるため)。

**matrix 片肺成功への注意**: `build-tauri (macos-latest)` と `build-tauri (windows-latest)` を個別 required check に登録するが、`fail-fast: false` で並列実行している関係で「片方 OS だけ通った状態」が GitHub UI で一瞬 mergeable に見える表示遅延がありうる。マージ前に必ず **Web UI 目視 + `gh pr checks` 再確認** を行う。

### 2.9 dependabot / 依存更新

- `.github/dependabot.yml` を Phase 1 から有効化
- 対象: `cargo` / `npm` / `github-actions` の 3 つ
- 頻度: weekly (Monday)
- 自動マージはしない (PR を作るだけで、マージは目視レビューを通す)

セキュリティ更新の機械的取り込みは個人プロジェクトでも有用。dependabot 自身に追加コストはない。

**PR 量を抑える運用**:
- `dependabot.yml` の `groups:` 機能で `rust-minor-patch` / `npm-minor-patch` / `gha-actions` 等にまとめる (rusqlite + tokio + serde 系の transitive で週 5〜10 PR 出る想定)
- **`actions/cache` 等の GitHub Actions メジャー更新は dependabot まかせにせず手動で別 PR を切ってテスト** (過去 v3 → v4 等で過去 CI が壊れた事例があるため、breaking change には人間判断を介す規律)
- バージョン pin は最小範囲とし、不要に細かく ignore リストへ振らない
- **security advisory 起点 PR (GitHub の security label が自動付与される) のみ auto-merge を許可**: `gh pr merge --auto --squash` 相当を許す。`groups` でまとめた通常 minor/patch は引き続き目視。半年放置 → 公開配布フェーズで 30 件積み上がる事故を防ぐ二段運用

`.github/dependabot.yml` の例 (概念):

```yaml
version: 2
updates:
  - package-ecosystem: cargo
    directory: /
    schedule: { interval: weekly }
    groups:
      rust-minor-patch:
        update-types: [minor, patch]
  - package-ecosystem: npm
    directory: /
    schedule: { interval: weekly }
    groups:
      npm-minor-patch:
        update-types: [minor, patch]
  - package-ecosystem: github-actions
    directory: /
    schedule: { interval: weekly }
    groups:
      gha-actions:
        update-types: [minor, patch]
```

### 2.10 ワークフローファイルの最小スケルトン

```yaml
# .github/workflows/ci.yml (概念)
# ref: ADR-0010 — 各ジョブ失敗時はジョブ名と本 ADR §2.1 / §2.4.x を参照すること
name: CI (ref: ADR-0010)

# GITHUB_TOKEN 最小権限 (デフォルトの write 権限を明示的に剥奪、Critical C-1 対策)
# 書込み権限が必要なジョブは job 単位で permissions: を上書きする (本 ADR ではなし)
permissions:
  contents: read

on:
  pull_request:
    branches: [main]
    paths-ignore: ['docs/**', '**/*.md', '.github/ISSUE_TEMPLATE/**']
  push:
    branches: [main]
    paths-ignore: ['docs/**', '**/*.md', '.github/ISSUE_TEMPLATE/**']
  workflow_dispatch:

concurrency:
  group: ${{ github.workflow }}-${{ github.head_ref || github.run_id }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

jobs:
  lint-rust:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<sha-pin>     # v4.x
      - uses: dtolnay/rust-toolchain@<sha-pin>  # master 直参照は禁止
        with: { components: rustfmt, clippy }
      - uses: Swatinem/rust-cache@<sha-pin>  # v2.7.x、SHA pin 必須
        with: { shared-key: ubuntu-debug, save-if: "${{ github.ref == 'refs/heads/main' }}" }
      - run: cargo fmt --check
        if: always()                          # 集約失敗パターンに揃える
      - run: cargo clippy --all-targets --all-features --locked -- -D warnings
        if: always()
      - name: Forbidden patterns (grep fallback)
        if: always()
        run: |
          ! grep -rn --include='*.rs' \
              -e 'std::thread::spawn' \
              -e 'std::thread::Builder::spawn' \
              -e 'tokio::task::spawn_blocking' \
              -e 'tokio::runtime::Handle::block_on' \
              -e 'rayon::' \
              src-tauri/src

  test-rust:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<sha-pin>     # v4.x
      - uses: dtolnay/rust-toolchain@<sha-pin>  # master 直参照は禁止
      - uses: Swatinem/rust-cache@<sha-pin>  # v2.7.x、SHA pin 必須
        with: { shared-key: ubuntu-debug, save-if: "${{ github.ref == 'refs/heads/main' }}" }   # lint-rust と統合 (debug profile 共有)
      - run: cargo test --workspace --lib --all-features --locked

  lint-frontend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<sha-pin>     # v4.x
      - uses: actions/setup-node@<sha-pin>   # v4.x
        with: { node-version-file: '.nvmrc', cache: 'npm' }
      - run: npm ci
      - run: npx tsc --noEmit
      - run: npx eslint .
        if: always()                          # tsc が落ちても eslint / prettier は走らせる
      - run: npx prettier --check .
        if: always()

  test-frontend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<sha-pin>     # v4.x
      - uses: actions/setup-node@<sha-pin>   # v4.x
        with: { node-version-file: '.nvmrc', cache: 'npm' }
      - run: npm ci
      - run: npx vitest run
        if: always()                          # build と並行して必ず両方走らせる
      - run: npm run build
        if: always()

  build-tauri:
    strategy:
      fail-fast: false
      matrix:
        os: [macos-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@<sha-pin>     # v4.x
      - uses: dtolnay/rust-toolchain@<sha-pin>  # master 直参照は禁止、必ず SHA pin
      - uses: Swatinem/rust-cache@<sha-pin>  # v2.7.x、SHA pin 必須
        with: { shared-key: build-${{ matrix.os }}, save-if: "${{ github.ref == 'refs/heads/main' }}" }
      - uses: actions/setup-node@<sha-pin>   # v4.x
        with: { node-version-file: '.nvmrc', cache: 'npm' }
      - run: npm ci
      - uses: taiki-e/install-action@<sha-pin>  # v2.x
        with: { tool: tauri-cli }
      - run: cargo tauri build --no-bundle
```

最終的なファイルは Phase 1 着手時に整備。本 ADR は概念骨格のみを固定する。

### 2.11 既存ドキュメントへの影響と更新箇所

本 ADR 受理に伴い以下を**同コミットで更新**する (ADR-0009 §2.5 と同パターン):

| ドキュメント | 箇所 | 変更内容 |
|------------|------|----------|
| `decisions/0008-distribution-no-autoupdate.md` §2.5 表 / §7.8 | 「CI/CD・リリースパイプライン ADR」単一名で予告 | **「CI ADR (本 ADR-0010 で確定) + CD ADR (将来、公開配布判断時)」の 2 本立て**に書き換え。本 ADR §1.1 の責務分界表を参照させる |
| `decisions/0009-cancellation-and-spawn-blocking.md` §6.2 受入条件 checklist の最終項目 + 改訂履歴 | 「`clippy.toml` の `disallowed_methods` に … `use ... as ...` での名称書き換えに備え、CI で grep チェックを併用」の項目 | 当該 checklist 項目を「`disallowed_methods` lint が free function も捕捉する。grep fallback の役割は **モジュールエイリアス経由の path 短縮 + マクロ展開取りこぼし** の二重防御。`rayon::*` のワイルドカード禁止は grep のみで担保 (詳細は ADR-0010 §2.4.1 / §2.5 / §6.2)」に差し替え |
| `architecture.md` §13 | 「ビルド/配布パイプラインは未確定」 | 「CI は ADR-0010 で確定 / CD は将来 ADR」に更新 |

**受理判定 checklist** (ADR-0009 §2.5 と同形式):

1. 本表のすべての対象ファイル更新が同コミットに含まれる
2. 本 ADR の Status を `Proposed` → `Accepted` に書き換える
3. 改訂履歴に「Accepted 化」行を追加する

3 つすべてが揃って初めて Accepted となる。途中状態でマージしてはならない。

---

## 3. Alternatives Considered

### 3.1 CI プラットフォーム

| 候補 | 評価 |
|------|-----|
| **GitHub Actions (採用)** | ✅ GitHub と統合済 / 個人プロジェクトの定石 / public repo は無料 / dependabot との連携が標準 / runner の OS matrix が揃っている |
| GitLab CI | ❌ GitHub に置く前提と矛盾。移行コスト |
| CircleCI | ❌ 個人プロジェクトで月額課金が発生する規模になりやすい |
| Jenkins (self-hosted) | ❌ 自前運用は個人開発の趣旨に反する |
| Drone / Buildkite | ❌ 同上、過剰 |

→ **GitHub Actions 採用**。

### 3.2 Tauri ビルドの matrix

| 候補 | 評価 |
|------|-----|
| **macOS + Windows のみ (採用)** | ✅ 要件 §3.2 の対象 OS と一致 / Linux は要件外で配布もしない / runner コストを最小化 |
| ubuntu も含める | ❌ Linux は要件外 (§3.2) でビルドが通ったとしても保証する意味が無い / runner 時間の浪費 |
| macOS のみ | ❌ Windows ビルドの構成漏れを CI で検出できない |
| Windows のみ | ❌ macOS ビルドの構成漏れを CI で検出できない |

→ **macOS + Windows 採用**。

### 3.3 lint / test の matrix

| 候補 | 評価 |
|------|-----|
| **ubuntu のみ (採用)** | ✅ 高速・低コスト / lint と単体テストはプラットフォーム差異が出にくい |
| 3 OS 全てで lint / test | ❌ runner 時間 3 倍になるが、検出できる差異は Tauri ビルドの方で十分 |
| macOS で test を回す (rusqlite の bundled SQLite が OS 依存挙動を持たないか確認) | △ 顕在化したら追加検討。Phase 1 では ubuntu で十分 |

→ **ubuntu のみ採用**。

### 3.4 package manager

| 候補 | 評価 |
|------|-----|
| **npm (採用)** | ✅ Node.js 同梱 / `package-lock.json` で再現性 / GitHub Actions の `setup-node` キャッシュが標準対応 |
| pnpm | ✅ ディスク効率良 / 高速。❌ 個人ツールに移行コストが見合わない |
| yarn (classic / berry) | ❌ classic は EOL / berry は移行コストが大きい |
| bun | △ 高速だが Tauri との統合が新しすぎてリスク。Phase 1 後に再検討 |

→ **npm 採用**。

### 3.5 pre-commit hook

| 候補 | 評価 |
|------|-----|
| **任意 (推奨せず必須にしない、採用)** | ✅ CI を主防衛線にする方針と整合 / フック故障で commit が止まるリスクを避ける |
| husky + lint-staged を必須化 | ❌ 個人ツールで commit 速度を落とすほど価値が無い / メンテ負荷 |
| 全く入れない | △ 任意で入れる選択肢を残しておくのが望ましい |

→ **任意採用**。`.husky/` を Phase 1 で作るかは実装者判断、CI チェックは別軸で必ず通す。

### 3.6 Coverage 計測

| 候補 | 評価 |
|------|-----|
| **入れない (採用)** | ✅ 個人ツールで coverage 数値の追跡コストが見合わない |
| codecov | ❌ Phase 1 では過剰 / トークン管理が増える |
| `cargo llvm-cov` (ローカル参考のみ) | △ 開発者個人の手元で必要になったら使う。CI 化はしない |

→ **入れない採用**。Phase 1 後に再評価。

### 3.7 セキュリティスキャン

| 候補 | 評価 |
|------|-----|
| **dependabot のみ (採用)** | ✅ GitHub 標準 / 設定コスト低 / セキュリティアラートを GitHub UI で確認できる。**マージ後の追従**を担当 |
| `actions/dependency-review-action` (PR マージ前ゲート) | △ dependabot とは**直交する役割** (マージ前の防衛線)。public repo ならコスト 0、追加 30 秒。Phase 1 では見送るが §7.2 で public 化後の追加検討項目として明記する |
| `cargo audit` を CI で定期実行 | △ Phase 1 では dependabot で代替。顕在化したら追加 |
| `npm audit --production` を CI で必須化 | ❌ 偽陽性が多く CI 失敗が頻発する。手動運用で十分 |
| Snyk / Trivy 等の外部 SaaS | ❌ 個人ツールで過剰 |

→ **dependabot のみ採用**。

### 3.8 Cron / 定期実行

| 候補 | 評価 |
|------|-----|
| **走らせない (採用)** | ✅ 依存更新は dependabot が担当 / Phase 1 で他に定期検証は不要 |
| 週次で `cargo build` をデイリー実行 | ❌ 依存変更がない時の runner 浪費 |
| 週次で nightly Rust toolchain と互換性チェック | ❌ Phase 1 では stable に固定で十分 |

→ **走らせない採用**。

### 3.9 フロント単体テストランナー (本 ADR で初出確定)

ADR-0002 ではフロントテストランナーは未確定だったため、本 ADR で採用を確定する。

| 候補 | 評価 |
|------|-----|
| **vitest (採用)** | ✅ Vite ツールチェーン (ADR-0002 採用) と統合済で `vite.config.ts` を共有、設定の二重管理ゼロ / ✅ Jest API 互換でドキュメント豊富 / ✅ React 18 + TypeScript strict との相性良 / ✅ `jsdom` / `happy-dom` を選べて DOM 環境セットアップが軽量 |
| Jest | ❌ Vite と別ツールチェーン化し `tsconfig` / module resolution の二重管理が発生 / ❌ ESM ファースト時代に設定がやや煩雑 |
| Playwright Component Test | △ E2E に近い領域。Phase 1 のユニット用途には過剰、将来 E2E ADR で別途検討 |
| `node:test` | ❌ React コンポーネントテストの DOM 環境セットアップが手間 / エコシステムが薄い |

→ **vitest 採用**。E2E (WebDriver / Playwright での Tauri バイナリ操作) は本 ADR スコープ外、Phase 1 後の別 ADR で扱う (§7.10 参照)。

**設定ファイル方針**: `vitest.config.ts` を別出ししない。**`vite.config.ts` 内 `test:` セクション**で一元管理する (`vitest` は `vite-node` を介して同設定を読む)。ESM / TS 解決を Vite と二重管理せずに済ませる。

---

## 4. Consequences

### 4.1 Positive

- **CI 範囲が明確**: 検証 (build/test/lint/typecheck) のみで、署名 / リリースアーティファクト生成は CD ADR に分離。Phase 1 着手時に必要十分が揃う
- **runner コスト最小**: lint/test を ubuntu に集約、Tauri ビルドのみ macOS/Windows、Linux ビルドはしない
- **ADR-0009 の lint 規約が機能する**: `clippy.toml` の `disallowed_methods` + grep フォールバックが CI で実効化され、`spawn_blocking` 規約違反がマージできない
- **dependabot で受動的にセキュリティ追従**: 設定コストほぼゼロでパッチが PR として流れてくる
- **再現性が高い**: Rust toolchain / Node バージョン / tauri-cli を全てロックファイル経由で固定
- **Phase 1 から regression を防げる**: 6 ジョブ全部が required になっているので、ビルドが壊れた状態で `main` が進まない

### 4.2 Negative / Risks

- **macOS / Windows runner のコスト**: private repo の場合、macOS = 10x 課金。Phase 1 着手時に repo を public にしておくのが**実質的に必須** (個人ツールなので公開してもよいはず)
  - 対策: 公開判断を本 ADR 受理時に決めておく。private のまま回すなら月の Actions 利用枠を消費するため、回数を `pull_request` のみに絞る等の調整余地を残す
- **Tauri ビルド時間**: §1.2 のとおり cold は macOS 10〜12 分 / Windows 8〜10 分、cache hit でも 5〜8 分。PR フィードバックが遅い
  - 対策: `Swatinem/rust-cache` で `target/` を確実にキャッシュ / matrix の fail-fast = false で並列ロス減 / §6.3 で「壁時計 cold 20 分以内 / cache hit 10 分以内」を受入条件として固定
- **CI の保守コスト**: GitHub Actions / runner / Tauri / Rust / Node 各レイヤのバージョンドリフトに追従が必要
  - 対策: dependabot で `github-actions` の更新も流す
- **個人プロジェクトで PR を必ず作る運用**: ローカルから直 push できなくなる手間
  - 対策: 規律として受け入れる。`gh pr create` の活用 / 簡素な PR 説明で運用負荷を抑える
- **CD ADR との接続点が未確定**: 公開配布判断時に CD ADR を切るが、その際に本 ADR のジョブと CD のジョブの**統合 / 分離**を再判断する必要がある
  - 対策: 本 ADR §1.1 で責務分界を明示し、CD ADR 着手時にこの境界を再評価できるようにしている
- **GitHub Actions ベンダーロックイン**: GitHub から離れる場合に書き直しが必要
  - 対策: Phase 1 では受容。代替プラットフォームへの移行が必要になったら別 ADR

#### 4.2.1 セキュリティ・運用障害リスク (§5 と対称)

Round 5 で識別したセキュリティ・運用障害リスクの要約。詳細な対策は §5 Mitigations 表を参照:

- **fork PR からの任意コード実行 / secret 露出**: 第三者 action 乗っ取り or `build.rs` / npm `postinstall` / vitest setup 経由での `printenv | curl`。対策 §1.1 / §2.3 / §2.6 / §2.10 / §5
- **キャッシュポイズニング**: 悪意ある PR が `target/` キャッシュに proc-macro 中間生成物を仕込み `main` ビルドを汚染。対策 §2.6 (`save-if: main`)
- **`paths-ignore` skip = success による無検証マージ**: CI 設定ファイル変更が無検証で `main` に乗る。対策 §2.2 (CI 設定ファイル群を除外対象から外す)
- **matrix 片肺成功で UI 表示遅延からマージ**: `fail-fast: false` 並列で片方 OS だけ通った状態が一瞬 mergeable に見える。対策 §2.8 (Web UI 目視 + `gh pr checks` 再確認)
- **dependabot security PR の放置**: 半年放置 → 公開配布フェーズで脆弱性パッチ未適用が 30 件積み上がる。対策 §2.9 (security 起点 PR のみ auto-merge)
- **GitHub Actions メジャー更新で過去 CI 突然 break**: `actions/cache` v3→v4 等の breaking change が dependabot 経由で混入。対策 §2.9 / §7.11 (手動 PR + 年次再点検)

### 4.3 Neutral

- **pre-commit hook を任意にしている**: ローカルでの即時フィードバックを欲する開発者は別途 husky を設定可能。CI で必ず弾けるので必須化しない
- **`workflow_dispatch` を残している**: 緊急時 / デバッグで手動実行できる。日常的には使わない
- **`paths-ignore` の運用**: §2.2 で doc-only PR は全ジョブを skip するが、CI 設定ファイル群 (workflow / lockfile / toolchain pin / lint 設定) は除外対象から外して必ず走らせる二段構え。skip = success として branch protection と整合する

---

## 5. Mitigations

| リスク | 対策 |
|-------|------|
| Tauri ビルドの遅延 | `Swatinem/rust-cache` で `target/` をキャッシュ / matrix を `fail-fast: false` で並列実行 / cold 15 分超が常態化したら `cargo nextest` / `sccache` を §7 に従って導入検討 |
| macOS / Windows runner コスト超過 | repo を public にする (個人ツールで支障なし) / 超過時は `pull_request` トリガのみに絞り `push (main)` での Tauri ビルドを停止する選択肢を残す |
| `clippy.toml` の `disallowed_methods` を rename import で素通り | §2.5 の grep ベース fallback を CI 末尾で必ず実行 / レビュー時に rename を受理しない規約を `module-contract.md` 拡張で追加するかを将来検討 |
| dependabot PR の山 | 自動マージしない方針を維持。PR は週次でまとめてレビュー。重要度低い更新は ignore リストへ |
| CI 失敗の原因切り分け | 各ジョブ名を機能粒度 (`lint-rust` / `test-frontend` 等) で分離。失敗 OS とジョブが GitHub UI から即わかる |
| Rust toolchain / Node バージョン更新時の整合崩れ | `rust-toolchain.toml` / `.nvmrc` / `engines.node` をすべて同一の更新 PR で動かす規律 |
| `workflow_dispatch` を悪用した不正実行 | repo 権限のあるユーザーしか実行できないため Phase 1 では懸念しない |
| `package-lock.json` の差分混入 | `npm ci` を強制 (lockfile に従う) / `npm install` は CI で使わない |
| **fork PR からの secret 露出 / 任意コード実行** | (a) workflow level `permissions: { contents: read }` を必ず設定 (§2.10) (b) 第三者 action は commit SHA で pin (§2.3 行) (c) signing secret は `release.yml` 別ファイルに隔離し `pull_request` トリガと同居させない (§1.1) (d) `Swatinem/rust-cache` を `save-if: main` に絞り PR からの cache 書込みを禁止 (§2.6) |
| `paths-ignore` skip = success による無検証マージ | CI 設定ファイル群 (`.github/workflows/**` / lockfile / toolchain pin / lint 設定) を `paths-ignore` 対象から明示除外 (§2.2) / `[skip ci]` 系 PR タイトル運用は禁止 |
| matrix 片肺成功で UI 表示遅延からマージしてしまう事故 | マージ前に Web UI 目視 + `gh pr checks` 再確認を運用ルール化 (§2.8) |
| dependabot security PR が放置される | `groups` 通常 PR は目視 / **security advisory 起点 PR のみ auto-merge を許可** (§2.9) で 2 段運用 |
| GitHub Actions メジャー更新で過去 CI 突然 break | `actions/cache` v3→v4 等の breaking change は dependabot まかせにせず手動 PR (§2.9) / 年 1 回 (1〜2 月) で全 action SHA pin と バージョンを再点検 (§7.11) |

---

## 6. Validation Criteria

### 6.1 Phase 1 着手時の最低条件

#### Phase 1 Day 0〜Day 2 の手順 (実装者向け「やることリスト」)

以下の順序で進めれば、本 ADR が想定する CI 整備が完了する:

| Day | やること | 出典 |
|-----|---------|------|
| Day 0 | `cargo create-tauri-app` で雛形生成 (npm + React + TS テンプレート) | §2.3 最小実装ファイル行 |
| Day 0 | `tauri.conf.json` の app id / window 初期サイズを `ui-design.md` §6 と合わせる | ADR-0002 / `ui-design.md` §6 |
| Day 0 | `hash_compute_text` の最小スタブ (`#[tauri::command]` 1 つ + registry 登録) を追加し、ローカルで `cargo tauri build --no-bundle` が通ることを確認。**目的は CI が前提とする最小実装の確保のみ** (`module-contract.md` §5.3 Q-22 PoC は §7.10 のテスト戦略 ADR に持ち越し、本 Day 0 では CI green 化の最低条件として最小コマンドを 1 個入れるだけ) | §2.3 最小実装ファイル行 |
| Day 1 | `clippy.toml` / `eslint.config.js` / `.prettierrc` / `rust-toolchain.toml` / `.nvmrc` / `vite.config.ts` (内 `test:` セクション含む) を配置 | §2.3 / §2.4 / §3.9 |
| Day 1 | `.github/workflows/ci.yml` / `.github/dependabot.yml` を配置、PR を作って 6 ジョブが green になることを確認 | §2.10 / §2.9 |
| Day 2 | branch protection で §2.8 の required check 6 個 (`lint-rust` / `test-rust` / `lint-frontend` / `test-frontend` / `build-tauri (macos-latest)` / `build-tauri (windows-latest)`) を Web UI で登録。`Include administrators` ON、`Allow force pushes` OFF | §2.8 |
| Day 2 | repo を public 化 (§1.2 / §2.8 の前提) | §1.2 / §2.8 |

以下の checklist は上記完了条件として用いる:

- [ ] `.github/workflows/ci.yml` が存在し、§2.1 の 6 ジョブが定義されている
- [ ] `clippy.toml` に §2.4.1 の 3 つの `disallowed_methods` が登録されている
- [ ] `eslint.config.js` / `.prettierrc` / `tsconfig.json` の最小構成が存在する
- [ ] `rust-toolchain.toml` / `.nvmrc` / `package.json` の `engines.node` が一致するバージョンを指している
- [ ] `package-lock.json` がコミット済 (gitignore されていない)
- [ ] `Cargo.lock` がコミット済 (バイナリ crate のため必須)
- [ ] `cargo` 系コマンド全てに `--locked` を付与し、CI 内での `Cargo.lock` 改変を拒否する設定になっている
- [ ] `.github/dependabot.yml` が cargo / npm / github-actions の 3 ecosystem を有効化している
- [ ] `main` ブランチの protection ルールで §2.8 の required checks が設定されている (GitHub Web UI でスクリーンショット保管)
- [ ] 空の最小プロジェクト (Hello World 相当) で全 6 ジョブが green になる
- [ ] `cargo tauri build --no-bundle` が macOS / Windows ともに成功する

### 6.2 ADR-0009 統合確認

- [ ] `tokio::task::spawn_blocking` を Rust ファイルに直接書いた dummy commit が `lint-rust` で fail することを確認 (`disallowed_methods` lint が free function を捕捉)
- [ ] grep fallback (§2.5) が `disallowed_methods` 通過後に同パターンを検出することを確認 (例: `use tokio::task as t; t::spawn_blocking()` のような **モジュールエイリアス経由の path 短縮** で grep が拾えること。`use tokio::task::spawn_blocking as sb` のシンボルリネームは clippy 段階で捕捉済)

### 6.3 性能受入条件

- [ ] cold ビルド (キャッシュなし) で全ジョブ完了が 20 分以内
- [ ] cache hit で全ジョブ完了が 10 分以内
- [ ] 達成できない場合は §7.1 の手段を順に検討する

---

## 7. Known Concerns / 将来見直しが要りうる判断

### 7.1 ビルド時間圧縮

- `cargo nextest` (テストランナー高速化) / `sccache` (Rust コンパイラキャッシュ) / `cargo-chef` (Docker レイヤキャッシュ) は Phase 1 では入れない
- ビルド時間が CI 体験を阻害する規模になったら順に検討

### 7.2 `cargo audit` / `npm audit` / `actions/dependency-review-action` の CI 組み込み

- Phase 1 は dependabot のみで運用 (マージ後の追従)
- **`actions/dependency-review-action`** (PR マージ前の脆弱性ゲート) は dependabot と直交する役割。public 化後 (§1.2 / §2.8) に SHA pin で追加検討。設定コストはほぼゼロ
- 公開配布フェーズで「依存の脆弱性が公開前に検出されないこと」を保証したくなったら `cargo audit` を CI に組み込む

### 7.3 Coverage 計測の本格導入

- Phase 1 では入れない (個人ツールに過剰)
- 公開配布 / 規模拡大 / 共同開発化のいずれかが顕在化したら codecov / Coveralls / `cargo llvm-cov` を再評価

### 7.4 Linux サポート顕在化時

- 要件 §3.2 が変わって Linux サポートを追加する場合、本 ADR の matrix を再構築 (build-tauri に ubuntu-latest を追加)
- AppImage / Flatpak / Snap / .deb / .rpm のどれを取るかは別 ADR (ADR-0008 §7.6 の通り)

### 7.5 CD ADR との統合

- 公開配布判断時に CD ADR を切る際、本 ADR の `build-tauri-*` ジョブと CD のリリースジョブをどう整理するかを再評価
- 候補: `build-tauri-*` を「ビルドが通ること」確認に絞り、リリース時は `release.yml` 別ファイルで signed bundle を作る分離構成

### 7.6 monorepo 化

- Phase 1 はモジュール (M-Prompt / M-LinkMemo / M-Color / M-Hash) を単一リポジトリ単一 crate にビルド時静的合成 (ADR-0004)
- 将来的にモジュールを別 crate に分けたくなったら `cargo workspace` 化。本 ADR の `--workspace` 指定は将来も有効

### 7.7 self-hosted runner — 採用不可として固定

- macOS / Windows runner コストが私物 PC で代替できるかは個人プロジェクトでは引き合わない見込み (運用負荷・電気代・メンテで結局割高)
- 加えて **GitHub 公式が public repo の self-hosted runner は fork PR からの任意コード実行が可能で危険**と警告している (https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/about-self-hosted-runners#self-hosted-runner-security)
- §1.2 で repo public 化を前提化した本 ADR では **採用不可**として固定する。再検討する場合は本 ADR を supersede する新 ADR が必要

### 7.8 PR テンプレート / Issue テンプレート

- `.github/pull_request_template.md` / `.github/ISSUE_TEMPLATE/*.md` は本 ADR スコープ外
- 公開配布判断時に外部コントリビューションを受け入れるなら作る

### 7.9 ESLint custom rule での `core_*` 直接呼び出し検出

- `module-contract.md` §6.2「モジュール配下の UI から `core_*` Tauri コマンドを直接呼ばない」の自動検出
- Phase 1 では `no-restricted-imports` ベースの簡易チェックに留める / それでもすり抜ける場合は実装後に custom rule を ADR で追加検討

### 7.10 テスト戦略 ADR への持ち越し項目 (本 ADR スコープ外)

本 ADR は CI ジョブの **外形 (どのコマンドを走らせるか / どの OS で / どんな lint を)** のみ確定する。以下は CI の中身として顕在化するが、本 ADR では具体ルールを縛らず、**後続のテスト戦略 ADR で確定**する:

| 項目 | 取り扱い |
|------|----------|
| `data-model.md` §15 T-01〜T-34 整合性テスト | どれを `test-rust` ユニット / どれを integration / どれを手動チェックリストに置くかの分類 |
| CLAUDE.md 不変条件の機械検出 | フロントから `@tauri-apps/plugin-sql` 直 import 禁止 (`no-restricted-imports`) / Rust ソース内の `CURRENT_TIMESTAMP` / `datetime('now')` 等 DB 側時刻生成パターン grep 禁止 / 検索スコープ内部値 `"project" \| "global"` 以外の出現禁止 (TS 型で保護) |
| Tauri バイナリ E2E | WebDriver / Playwright を使ったキー操作・スクリーンショット差分など |
| バンドルサイズ計測 | 要件 §3.1 のインストーラ 30MB 目標を CI 上で検証する仕組み (CD ADR と要相談) |
| `module-contract.md` §5.3 Q-22 PoC (`generate_handler!` 集中登録) | Phase 1 着手最初期の PoC 結果を CI に取り込むかどうか |

これらは本 ADR では「規約のフックポイントだけ用意」 (§2.4.2 ESLint flat config / §2.5 grep) に留め、具体ルールはテスト戦略 ADR で確定する。

### 7.11 GitHub Actions 仕様変更による陳腐化

`actions/cache` v3 → v4 強制移行 / `node20` 強制 / runner image (`ubuntu-22.04` 廃止等) / Free tier 配分変更等で 1〜2 年スパンで本 ADR が陳腐化する可能性がある。**年 1 回 (1〜2 月想定)** で本 ADR §2.3 / §2.10 のバージョン・action SHA pin を再点検する運用を採用する。dependabot の `github-actions` ecosystem PR は流れてくるが、メジャー更新は手動で別 PR を切ってテストする規律を §2.9 で明記済。

### 7.12 macOS Intel (x86_64) サポートの境界

- `macos-latest` runner は現在 **arm64**。`macos-13` 以前を指定すると Intel runner が取れる
- 本 ADR §2.1 matrix は `macos-latest` 単一なので **Intel Mac 向けバイナリは CI で全く検証されない**
- Phase 1 配布対象に Intel Mac を含めるかは `requirements.md` §3.2 / ADR-0008 で決まる:
  - 含める場合: 本 ADR §2.1 matrix に `macos-13` を追加 (課金分が +macos 換算で 10x 増加するため §1.2 の試算に影響)
  - 含めない場合: ADR-0008 §2.4 / §6.1 に「Intel Mac 非対応」を 1 行追記し、本 ADR は据え置き
- Phase 1 着手時に明示的に判断すること (現状は arm64 のみ検証 = Intel 向けの暗黙非対応)

### 7.13 actionlint / `npm --ignore-scripts`

- `actionlint` (workflow YAML 自体の構文 lint): SHA pin した単一 action の追加で導入できるが、Tauri 公式 / Spacedrive / lapce のいずれも採用していないため Phase 1 は見送り。本 ADR §2.10 の YAML が複雑化したら再評価
- `npm ci --ignore-scripts` (postinstall script の悪用防止): Round 5 の fork PR 攻撃経路をさらに絞る効果あり。Tauri が postinstall を必要とするかは要 PoC のため、Day 0 で `--ignore-scripts` でビルドが通るかを確認、ダメなら見送る

### 7.14 `cargo test` のスコープと crate 分割戦略

- Phase 1 の `test-rust` は `cargo test --workspace --lib --all-features` で **ライブラリターゲットのみ** を対象にする
- 理由: Tauri 2 の `tauri::Builder` を含むバイナリを `cargo test` 配下で動かすと、test harness 起動時に WebView 関連の初期化パスを踏んでヘッドレス CI で fail することがある。`--lib` フラグは **バイナリターゲット (`[[bin]]`) を除外** するため、単一 crate のままでもライブラリ部分だけがテスト対象になる (`#[cfg(test)]` モジュールは lib target 内に書けば走る)
- **Phase 1 は単一 crate 前提** (ADR-0004 §7.3 の workspace 分割は将来検討事項のまま据え置く)。`--workspace` フラグは将来 crate 分割した際の no-op 保険として付けておく
- `mym-tauri` 側の integration test (WebDriver 系) は §7.10 のテスト戦略 ADR で扱う。本 ADR では入れない

---

## 8. References

- ADR-0001 (Tauri v2)
- ADR-0002 (Frontend stack)
- ADR-0003 (rusqlite + bundled SQLite)
- ADR-0008 (配布 / 自動更新なし) §2.5 / §6.2 / §7.8
- ADR-0009 (キャンセル機構 / `spawn_blocking` 規約) §2.3 / §6.2
- 要件: `docs/requirements.md` §3.1 / §3.2
- アーキテクチャ: `docs/architecture.md` §13 (技術スタック / 未確定事項)
- GitHub Actions: https://docs.github.com/en/actions
- `Swatinem/rust-cache`: https://github.com/Swatinem/rust-cache
- `dtolnay/rust-toolchain`: https://github.com/dtolnay/rust-toolchain
- Tauri 2 配布ガイド: https://v2.tauri.app/distribute/ (CI 関連ガイドは Phase 1 着手時に最新版 URL を再確認、本 ADR 書記時点で `/distribute/pipelines/` は 404)
- `taiki-e/install-action`: https://github.com/taiki-e/install-action
- GitHub Actions 課金 (per-minute rate): https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-actions/about-billing-for-github-actions

---

## 9. 改訂履歴

| 日付 | 版 | 内容 |
|------|----|------|
| 2026-04-30 | 1.0 | 初版ドラフト (Phase 1 着手前に CI 構成を確定) |
| 2026-04-30 | 1.1 | レビュー round 1 反映: `clippy.toml` のキー名は kebab-case `disallowed-methods` (lint 名はアンダースコア) と明記 / §1 表 / §2.4.1 で表記揺れ解消 (Critical C-1) / matrix ジョブ表示名を `build-tauri (macos-latest)` / `build-tauri (windows-latest)` に統一し required check 名と整合 (M-4) / `cargo install tauri-cli` を `taiki-e/install-action@v2` ベースに変更 (M-3、Swatinem/rust-cache が `~/.cargo/bin` を非キャッシュのため) / `dtolnay/rust-toolchain@stable` を `@master` に変更し `rust-toolchain.toml` を真とする (M-2) / `test-rust` を `cargo test --workspace --lib --all-features` に絞り §7.10 でコア crate / Tauri crate 分割方針を新設 (M-6) / §2.6 で `setup-node@v4` の `cache: 'npm'` が `~/.npm` のみで `node_modules/` 自体は再構築されることを明示 (M-5) / `Swatinem/rust-cache@v2` の `shared-key` をジョブごとに分ける指示を追加 (M-7) / `prettier-plugin-tailwindcss` v0.6.10 以降を最低条件と明記 (M-8) / `disallowed_methods` lint が free function も捕捉する事実と grep fallback の役割 (path 短縮の取りこぼし対策) を §2.4.1 に明記 (M-1) |
| 2026-04-30 | 1.2 | レビュー round 2 反映 (コスト・スケーリング): §1.2 に PR 1 回あたり約 100 分 (cache hit) / 約 156 分 (cold) の課金試算 と Phase 1 で repo public 化を前提化 (Critical C-1) / §2.6 の `shared-key` を粒度見直し: `lint-rust` と `test-rust` を `ubuntu-debug` に統合し 10 GB cache limit 圧迫を回避 (M-1) / §2.2 に `concurrency:` 設定を追加し PR 連続 push 時の二重課金を防止 (M-3) / §2.2 / §2.10 に `paths-ignore` (`docs/**` 等) を追加し doc-only PR の全ジョブ走行を skip (M-4) / §2.10 各 lint ジョブに `if: always()` を追加し集約失敗パターンに変更 (M-5) / §6.3 に「壁時計時間 vs 課金分」の区別を明記 / §2.8 冒頭に public 化前提を明記 |
| 2026-04-30 | 1.3 | レビュー round 3 反映 (既存 ADR との整合): §2.11 に「既存ドキュメントへの影響と更新箇所」表を新設し ADR-0008 §2.5 / §7.8 の「CI ADR + CD ADR の 2 本立て」化と ADR-0009 §6.2 grep fallback 説明の同期、`architecture.md` §13 更新を受理判定 checklist 化 (M-2) / §3.9 に vitest 採用根拠を追加 (本 ADR で初出確定、Jest / Playwright Component Test / `node:test` との比較、M-4) / §7.10 を「テスト戦略 ADR への持ち越し項目」に書き換え、T-01〜T-34 / CLAUDE.md 不変条件 / E2E / バンドルサイズ計測 / Q-22 PoC を後続 ADR 対象として明記 (M-5 / M-6) / §7.11 (旧 §7.10) を「Phase 1 単一 crate 前提、`--workspace` は将来分割の no-op 保険、ADR-0004 §7.3 と矛盾しない書き方」に修正 (M-3) / §6.2 の grep fallback 検証例を「モジュールエイリアス経由 path 短縮」(`use tokio::task as t; t::spawn_blocking()`) に差し替え (Minor) |
| 2026-04-30 | 1.4 | レビュー round 4 反映 (Phase 1 着手の現実性): §2.3 表に「最小実装ファイル」行を追加し `cargo create-tauri-app` 雛形生成を本 ADR の前提として明記 (Critical C-1) / Rust toolchain `1.83` を「本 ADR 書記時点の参考値、Tauri 2 最新 MSRV を必ず公式で確認」に弱め (Critical C-2) / `taiki-e/install-action` の prebuilt 提供範囲・fallback 時の `cargo binstall` 切替えを明記 (M-2) / §2.9 dependabot に `groups:` 機能の例と「actions メジャー更新は手動 PR」規律を追加 (M-3 / M-6) / §2.10 ワークフロー冒頭コメントを `name: CI (ref: ADR-0010)` に変更しトラブルシュート導線を強化 (M-4) / §6.1 冒頭に **Day 0〜Day 2 のやることリスト** (`cargo create-tauri-app` → 設定ファイル配置 → CI 走行確認 → branch protection → public 化) を追加し checklist を達成条件として明確化 (M-5 / M-1) / `.nvmrc` を LTS の偶数 major で完全 pin / §3.9 で `vitest.config.ts` を別出しせず `vite.config.ts` 内 `test:` セクションに一元化を明記 (Minor) / §8 References に `taiki-e/install-action` のリンクを追加 (Minor) |
| 2026-04-30 | 1.5 | レビュー round 5 反映 (セキュリティ・運用障害): §2.10 ワークフローに `permissions: { contents: read }` を追加し `GITHUB_TOKEN` のデフォルト write 権限を剥奪 (Critical C-1: fork PR からの任意コード実行で secret steal 経路を絶つ) / §2.3 表に「第三者 action の pin」行を追加し `Swatinem/rust-cache` / `dtolnay/rust-toolchain` / `taiki-e/install-action` / `actions/checkout` / `actions/setup-node` を **commit SHA で pin** することを必須化、`@master` 直参照を禁止 (Critical C-2: action maintainer 乗っ取りによる任意コード実行) / §2.6 に `Swatinem/rust-cache` の `save-if: main` を全ジョブで指定する規律を追加し PR からの cache 書込みを禁止 (M-2: キャッシュポイズニング) / §1.1 に「signing secret を `release.yml` 別ファイルに隔離し `pull_request` トリガと同居させない」決定を格上げ (M-1) / §2.2 の `paths-ignore` から CI 設定ファイル群 (`.github/workflows/**` / lockfile / toolchain pin / lint 設定) を除外する明示ルールを追加 (M-3) / §2.8 に**緊急 hotfix 手順**と matrix 片肺成功への注意を追加 (M-4 / M-6) / §2.9 に security advisory PR のみ auto-merge を許可する 2 段運用を追加 (M-7) / §7.11 GitHub Actions ベンダ陳腐化への年次再点検 / §7.12 self-hosted runner を public repo の fork PR セキュリティ警告を根拠に「採用不可」として固定 (Minor) / §7.13 (旧 §7.11) `cargo test` スコープ |
| 2026-04-30 | 1.6 | レビュー round 6 反映 (内部整合・読みやすさ): §4.3 第 3 項目「`paths` フィルタなし」を「`paths-ignore` の運用 (§2.2 で doc-only PR skip / CI 設定ファイル除外の二段構え)」に修正 (M6-1: Round 2 反映時の取り残し) / §4.2 第 2 項目の Tauri ビルド時間を §1.2 と一致する数字 (cold macOS 10〜12 分 / Windows 8〜10 分、cache hit 5〜8 分) に更新 (M6-2) / §4.2.1 副節「セキュリティ・運用障害リスク」を新設し §5 の 6 件のセキュリティリスクと対称化 (M6-3) / §2.5 grep ベース fallback の対象集合を `clippy.toml` `disallowed-methods` と揃え `std::thread::Builder::spawn` / `tokio::runtime::Handle::block_on` を grep 対象に追加、`rayon::*` をワイルドカード禁止として grep のみで担保する非対称を明示する対応表を追加 (M6-4) / §2.10 ワークフロー内の grep step も同期更新 / §7.7 と §7.12 (self-hosted runner) を §7.7 に統合し「採用不可として固定」と一本化、後続節を §7.12 (`cargo test` スコープ) に繰り上げ (M6-5) |
| 2026-04-30 | 1.7 | レビュー round 7 反映 (OSS ベストプラクティスとの比較): §3.7 セキュリティスキャン比較表に `actions/dependency-review-action` (PR マージ前の脆弱性ゲート、dependabot と直交) を追加 / §7.2 タイトルを「`cargo audit` / `npm audit` / `actions/dependency-review-action` の CI 組み込み」に変更し public 化後の追加検討を明記 (M-1) / §2.10 の `cargo clippy` / `cargo test` に **`--locked`** を追加し CI 内での `Cargo.lock` 改変を拒否 (Minor: lapce 等の OSS ベストプラクティス) / §6.1 checklist に `Cargo.lock` コミット必須と `cargo --locked` 付与の 2 項目を追加 (Minor) / §7.12 を新設し macOS Intel (`macos-13`) サポートの境界判断を `requirements.md` §3.2 / ADR-0008 への持ち越しとして明記 (M-2) / §7.13 を新設し `actionlint` 見送り (本 ADR §2.10 が複雑化したら再評価) と `npm ci --ignore-scripts` の Day 0 PoC 確認 (Minor) を追加 / §7.14 (旧 §7.12) `cargo test` スコープ |
| 2026-04-30 | 1.8 | レビュー round 8 反映 (最終 sign-off): §2.3 `tauri-cli` 行を **事実訂正** — `taiki-e/install-action` の managed manifest に `tauri-cli` は無く、fallback は `cargo install` ではなく **`cargo-binstall`** が既定 (Critical C8-1 / 公式 README で確認) / §8 References の Tauri 公式 URL `/distribute/pipelines/` が 404 のため `/distribute/` (CI ページは Phase 1 着手時に再確認) と GitHub Actions 課金公式リンクに差し替え (Critical C8-2) / §1.2 の課金記述に「2024 年に multiplier 表記から per-minute rate 表記に変わったが Linux 換算比は実質変わらず」の鮮度注記を追加 (M8-1) / §6.1 Day 0 行から「Q-22 PoC を兼ねる」の二重決定を削除し「CI が前提とする最小実装の確保のみ、Q-22 PoC は §7.10 持ち越し」と一本化 (M8-2) / §2.11 の ADR-0009 §6.2 更新粒度を「末尾」から「**受入条件 checklist の最終項目を差し替え**」に詳細化 (M8-3) / §2.10 lint-rust の `cargo fmt --check` と test-frontend の `vitest run` にも `if: always()` を付与し集約失敗パターンを完全化 (Minor) / §7.14 の `cargo test --lib` の説明を「`main.rs` を含まない」から「**バイナリターゲット (`[[bin]]`) を除外**」に正確化 (Minor) |
| 2026-04-30 | 1.9 | **Accepted 化**: §2.11 受理判定 checklist の 3 項目すべてを満たすコミットで Status を Proposed → Accepted に昇格。同コミットで `decisions/0008-distribution-no-autoupdate.md` §2.5 / §7.8 を「CI ADR (ADR-0010) + CD ADR (将来) の 2 本立て」に書き換え / `decisions/0009-cancellation-and-spawn-blocking.md` §6.2 受入条件 checklist 最終項目を ADR-0010 §2.4.1 / §2.5 / §6.2 ベースに差し替え / `architecture.md` §13 「未確定」を「CI 確定 (ADR-0010) / CD は将来」に分離、をすべて更新済み |
