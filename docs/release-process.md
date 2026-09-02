# リリース手順

MyMyToolsのmacOS / Windows向けportable ZIPを、GitHub Actionsから手動公開する担当者向けrunbook。

- リリース方式の設計判断は[ADR-0013](decisions/0013-manual-portable-zip-release.md)、required CI成果物の再利用は[ADR-0019](decisions/0019-reuse-required-ci-release-artifacts.md)、NRBF sidecarの同梱境界は[ADR-0020](decisions/0020-nrbf-inspector-boundary.md)を正典とする
- 実装は[`.github/workflows/release.yml`](../.github/workflows/release.yml)を正典とする
- Release本文と利用者向け更新方法は[`scripts/release/release-notes.md`](../scripts/release/release-notes.md)を正典とする
- 本書は、上記の方針を変更せずにリリース担当者が行う操作を定める

## 1. リリースの原則

- リリースは`main`から`workflow_dispatch`で手動実行する。tag pushだけでは起動しない
- versionはSemVerとする。設定ファイルには`0.1.0-alpha.5`、tagには`v0.1.0-alpha.5`の形式を使う
- リリース対象は、必須CIを通して`main`へマージしたcommitに固定する
- tagはRelease workflow実行前にpushする。一度pushしたtagは移動・再利用しない
- macOS / Windowsの両portable ZIPが成功した場合だけGitHub Releaseを公開する
- 原則として直前のrequired CIが生成したportable ZIPを厳格検証して再利用し、候補がない場合だけtagから再ビルドする
- 公開済みReleaseのassetを差し替えない。修正が必要なら新しいversionを発行する
- GitHub Actions画面と`gh`コマンドのどちらからでも起動できるが、同じversionで両方を実行しない

## 2. 事前条件

- `gh auth status`が成功し、対象アカウントに`repo`と`workflow`権限がある
- Node.jsは`.nvmrc`に記載された22系、Rustは`rust-toolchain.toml`に従う
- `main`のbranch protectionを迂回せず、release準備もPR経由でマージする
- 対象versionのtagとGitHub Releaseがまだ存在しない
- 作業開始時のworktreeがcleanである
- draw.io submoduleがcommit `fea5e877f3e6f849331ad09894f7edb9771708fa`で初期化されている

以下では例として次の変数を使う。実際に公開するversionとPR番号へ置き換える。

```bash
RELEASE_VERSION=0.1.0-alpha.5
PR_NUMBER=123
```

## 3. version更新

### 3.1 release準備ブランチを作る

```bash
git fetch origin main --tags
git switch -c "release/v${RELEASE_VERSION}" origin/main
```

### 3.2 versionを揃える

`v`を付けない同じversionへ更新する。

| ファイル | 更新内容 |
|----------|----------|
| `package.json` | npm package version |
| `package-lock.json` | root packageのversion |
| `src-tauri/Cargo.toml` | Rust package version |
| `src-tauri/Cargo.lock` | `mym-tools` packageのversion |
| `src-tauri/tauri.conf.json` | Tauri application version |
| `README.md` | 開発状況にversionを明記している場合は更新 |

npm側は次のコマンドで`package.json`と`package-lock.json`を同時更新できる。

```bash
npm version "${RELEASE_VERSION}" --no-git-tag-version
```

`Cargo.toml`を編集した後は、Cargo経由で`Cargo.lock`を同期する。

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

3つの実行時versionが揃っていることを、workflowと同じ契約で検証する。

```bash
node scripts/release/release-contract.mjs check-version "${RELEASE_VERSION}" .
```

## 4. ローカル検証

依存関係をlockfileどおりに入れ直し、フロントエンドとRustの検証を行う。

```bash
git submodule update --init
npm ci
npm run prepare:drawio
npm run lint
npm run typecheck
npm run test
npm run build

cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features --locked -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --workspace --lib --all-features --locked

node scripts/release/release-contract.mjs check-version "${RELEASE_VERSION}" .
git diff --check
```

`.github/workflows/`を変更した場合は、利用可能な`actionlint`でも検査する。最終判定はPRで実行される6つのrequired checkとする。

## 5. PRと必須CI

変更内容を確認してコミット・pushし、`main`向けPRを作成する。

```bash
git status --short --branch
git add -A
git commit -m "chore(release): v${RELEASE_VERSION}"
git push -u origin "release/v${RELEASE_VERSION}"
gh pr create --base main --head "release/v${RELEASE_VERSION}"
```

次の6チェックがすべて成功するまでマージしない。

- `lint-rust`
- `test-rust`
- `lint-frontend`
- `test-frontend`
- `build-tauri (macos-latest)`
- `build-tauri (windows-latest)`

2つの`build-tauri`はRelease用portable ZIPとcandidate manifestも生成する。Release workflowが再利用できる期間はartifact保持期間の1日なので、短縮効果を得るにはPRマージ・tag push・Release実行を同日中に行う。

```bash
gh pr checks "${PR_NUMBER}" --watch
gh pr merge "${PR_NUMBER}" --auto --squash --delete-branch
```

自動レビューに未解決の指摘がある場合は、妥当性を確認して修正・再検証し、会話を解決してからマージする。

## 6. tag作成

PRのマージ後にリモートを再取得し、PRのmerge commitが`main`へ含まれることを確認する。後続commitが`main`へ入ってもリリース対象が変わらないよう、tagは`origin/main`ではなく確認済みのmerge SHAへ付ける。

```bash
git fetch origin main --tags
MERGE_SHA=$(gh pr view "${PR_NUMBER}" --json mergeCommit --jq '.mergeCommit.oid')
git merge-base --is-ancestor "${MERGE_SHA}" origin/main
git show --no-patch --format='%H %s' "${MERGE_SHA}"
```

同じtagがローカル・リモートに存在しないことを確認する。

```bash
git tag --list "v${RELEASE_VERSION}"
git ls-remote --tags origin "refs/tags/v${RELEASE_VERSION}"
```

どちらも何も出力しないことを確認してから、注釈付きtagを作成・pushする。

```bash
git tag -a "v${RELEASE_VERSION}" "${MERGE_SHA}" -m "Release v${RELEASE_VERSION}"
git show --no-patch --format='%H %s' "v${RELEASE_VERSION}^{}"
git push origin "v${RELEASE_VERSION}"
```

## 7. Release workflow実行

### 7.1 GitHub Actions画面から実行する場合

1. GitHubのリポジトリで`Actions`を開く
2. 左側から`Release (ref: ADR-0013)`を選ぶ
3. `Run workflow`を開き、branchに`main`を選ぶ
4. `version`へ`0.1.0-alpha.5`の形式で入力する（先頭の`v`は省略可能）
5. `Run workflow`を1回だけ押す

### 7.2 `gh`から実行する場合

```bash
gh workflow run release.yml --ref main -f version="${RELEASE_VERSION}"
gh run list --workflow release.yml --event workflow_dispatch --limit 5
gh run watch <RUN_ID> --exit-status
```

実行中は次の順で処理される。

1. `Validate release request`: main実行、SemVer、tag、3設定のversion、既存Releaseを検証
2. tag commitに対応するmerged PR、同一runのrequired check 6件、run attempt、2つのcandidate artifact IDを解決
3. candidate成立時は2つの`Build portable ZIP` jobをskip。不成立・期限切れ・API利用不能時だけ、検証済みtag SHAからmacOS / Windowsを再ビルド
4. `Publish GitHub Release`: candidate成立時はartifact ID指定でdownloadし、manifestのrepository / run / attempt / commit tree / version / platform / filename / size / SHA-256を検証
5. tag SHA、2 ZIP、展開可能性、内部構造、サイズ上限を再検証してからdraft作成、upload、公開

publish直前の`check-assets`は各ZIPが80,000,000 bytes以下であることを検査し、現在sizeと直前Releaseからの増減をStep Summaryへ出す。上限超過時はdraw.io assetを縮小せずReleaseを停止し、ADR-0017に従って再判断する。

通常の再利用経路では`Build portable ZIP`がskippedになることが正しい。`Validate release request`の`candidate_reason`で再利用 / fallbackの理由を確認する。candidateを選択した後にmanifest、digest、tree、ZIP検証が失敗した場合は安全上fallbackせず、Release作成前に停止する。

最初の実リリースでは、PR CI開始から6 checks完了、Release run開始から公開、両者を合わせた開始から公開、fallback時のRelease run開始から公開を分けて記録する。cache hit時の目標は順に10分、2分、12分、10分以内とする。

## 8. 公開後の確認

Releaseがdraftではなく、pre-release versionなら`isPrerelease`が`true`であり、assetが期待する2件だけであることを確認する。

```bash
gh release view "v${RELEASE_VERSION}" \
  --json url,tagName,targetCommitish,isDraft,isPrerelease,publishedAt,assets
```

期待するasset名は次のとおり。

- `MyMyTools_<version>_macos_aarch64.zip`
- `MyMyTools_<version>_windows_x64.zip`

公開済みassetを一時ディレクトリへ再ダウンロードし、workflow外からも検査する。

```bash
VERIFY_DIR=$(mktemp -d "/tmp/mym-tools-release-${RELEASE_VERSION}.XXXXXX")
gh release download "v${RELEASE_VERSION}" --dir "${VERIFY_DIR}"
node scripts/release/release-contract.mjs check-assets "${RELEASE_VERSION}" "${VERIFY_DIR}"

unzip -t "${VERIFY_DIR}/MyMyTools_${RELEASE_VERSION}_macos_aarch64.zip"
unzip -Z1 "${VERIFY_DIR}/MyMyTools_${RELEASE_VERSION}_macos_aarch64.zip" | grep -q '^MyMyTools.app/'

test "$(unzip -Z1 "${VERIFY_DIR}/MyMyTools_${RELEASE_VERSION}_windows_x64.zip" | sort)" = $'MyMyTools.exe\nnrbf-decoder.exe'
unzip -t "${VERIFY_DIR}/MyMyTools_${RELEASE_VERSION}_windows_x64.zip"

shasum -a 256 "${VERIFY_DIR}"/*.zip
```

`shasum`の結果が`gh release view`の各assetの`digest`と一致することを確認する。

## 9. 失敗時の対応

最初に失敗stepと、Releaseが作成されているかを確認する。

```bash
gh run view <RUN_ID> --log-failed
gh release view "v${RELEASE_VERSION}"
```

| 状況 | 対応 |
|------|------|
| candidateが見つからない、期限切れ、required checkを一意に解決できない | workflowがtagから自動fallback buildする。手動でartifactを指定しない |
| candidate選択後にmanifest / digest / tree / ZIP検証が失敗 | Releaseは作成されない。fallbackへ切り替えず、候補の生成元と契約不一致を修正して新しいrequired CIを通す |
| 一時的なrunner / network障害で、tagのソースに変更がなくReleaseも存在しない | 同じversionでworkflowを再実行してよい |
| workflowだけを修正し、tagのアプリソースは変更しない | workflow修正をPRで`main`へ入れ、Releaseが存在しないことを確認して同じversionを再実行してよい |
| アプリソース、version設定、release notesの修正が必要 | push済みtagを動かさず、新しいversionで手順を最初から行う |
| publish途中で失敗 | workflowがその実行で作成したdraftを削除する。Releaseが残っていないことを確認してから原因に応じて再実行する |
| 公開済みReleaseが存在する | 再実行・asset差し替えをせず、新しいversionを発行する |

次の操作は禁止する。

- push済みtagの強制更新・再利用
- 公開済みReleaseの削除・再作成
- `gh release upload --clobber`によるasset上書き
- 片方のOSだけを手動uploadしてReleaseを公開すること

## 10. 完了条件

- release準備PRが6つのrequired check成功後に`main`へマージされている
- `v<version>` tagが確認済みmerge SHAを指している
- Release workflowの全jobが成功している
- 通常経路はrequired CI candidateを再利用してfallback buildがskip、候補不成立時はfallback buildが両OS成功している
- GitHub Releaseが公開済みで、draftではない
- macOS / Windowsのportable ZIPが2件ちょうど存在する
- 公開済みZIPの展開、内部構造、SHA-256を確認している
- 両ZIPが各80,000,000 bytes以下で、workflowのsize / 前Release差分reportを確認している
