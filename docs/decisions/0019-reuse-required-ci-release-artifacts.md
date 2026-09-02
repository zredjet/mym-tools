# ADR-0019: required CI成果物をReleaseへ再利用する

- **Status**: Accepted
- **Date**: 2026-09-02
- **Deciders**: zredjet
- **Related**: ADR-0010 (CIパイプライン) / ADR-0013 (手動portable ZIPリリース) / ADR-0017 (配布サイズ上限) / ADR-0020 (NRBF sidecar)
- **Supersedes**: ADR-0010の`build-tauri`をビルド確認だけに限定する決定、ADR-0013 §2.3のRelease workflow内で常に2 OSを再ビルドする決定

---

## 1. Context

リリース準備PRではrequired CIのmacOS / WindowsジョブがTauri applicationをビルドする。その直後のRelease workflowも同じソースを2 OSで再ビルドしており、公開まで数分から十数分の重複待ちが発生していた。

手動version入力、事前push済みtag、2 OSのportable ZIP、公開済みReleaseの不変性は維持する。高速化のためにソース同一性や成果物完全性を弱めてはならない。

## 2. Decision

### 2.1 required CIを配布物の生成元にする

- required check名は従来の6件を維持する
- `build-tauri (macos-latest)`と`build-tauri (windows-latest)`はビルド確認に加え、Release契約どおりのportable ZIPを生成する
- Tauri CLIは`package-lock.json`の`@tauri-apps/cli`を`npm run tauri`で実行し、`cargo`には`--locked`を渡す。CIとfallback buildで同じtoolchain境界を使う
- 各jobはZIPとcandidate manifestを`release-candidate-macos` / `release-candidate-windows` artifactへ保存する
- artifactの保持期間は1日、外側artifactの圧縮は無効とする。保持期間切れは異常公開ではなくfallback buildの条件とする

### 2.2 candidate manifest

manifest schema version 1は次を記録する。

- repository
- workflow run ID / run attempt
- checkoutしたcommit ID / tree ID
- release version / platform
- ZIP filename / byte size / SHA-256
- Tauri CLI version / rustc version

Release側は未知のschema、repository、run / attempt、tag commitのtree、version、platform、filename、size、SHA-256の不一致をすべて拒否する。candidateを選択した後の不一致では別成果物へ自動切替せず、GitHub Release作成前にfail closedとする。

### 2.3 candidate runの一意な解決

Release workflowはtag commitに対応するcandidateを次の順で解決する。

1. tag commitをmerge commitとする`main`向けmerged PRが1件だけ存在する
2. PR head commit上のrequired check 6件が、すべて同じGitHub Actions check suite / workflow runに属して成功している
3. workflow runが`.github/workflows/ci.yml`の`pull_request` runで、PR head SHAと一致して成功している
4. そのrunに期限内で非空のcandidate artifactがOSごとに1件だけ存在する
5. artifact ID、run ID、run attemptを固定してdownloadする

古い成功run、別runのcheck混在、同名artifactの曖昧選択、名前patternだけによるcross-run downloadは禁止する。

### 2.4 fallbackと公開前検証

- candidateが存在しない、期限切れ、required checkを一意に解決できない、またはGitHub APIを利用できない場合は、検証済みtag commitから2 OSを再ビルドする
- fallback buildもlockfile固定のTauri CLIとCargo `--locked`を使う
- candidate再利用とfallbackのどちらでも、publish jobはRelease作成前にtag SHA、ZIP 2件、80,000,000 bytes上限、展開可能性、macOSの`MyMyTools.app/`、Windowsの`MyMyTools.exe` / `nrbf-decoder.exe` 2ファイル構造を検証する (ADR-0020)
- candidate再利用時は外側artifactのdigest検証に加え、manifest内のinner ZIP SHA-256を独立に検証する
- draft作成後の失敗時は、そのrunが作ったdraftだけを削除する。公開済みReleaseの不変性はADR-0013どおり維持する

### 2.5 権限とjob graph

- candidate resolverは`contents: read` / `pull-requests: read` / `actions: read`
- fallback buildは`contents: read`
- publishは`contents: write` / `actions: read`
- candidate再利用時はfallback matrixをskipしてpublishへ進み、candidate不成立時だけfallback matrixの両OS成功をpublish条件とする

## 3. Consequences

### 3.1 Positive

- 通常経路ではPR required CIで完了済みの2 OSビルドを繰り返さず、Release実行から公開までを検証・転送時間中心に短縮できる
- 配布物がrequired CIで実際に検査されたbinaryと同一になる
- candidateの保持期間切れや一意性不足でも、安全なtag再ビルドによりリリース可能性を維持できる

### 3.2 Negative / Risks

- CI artifactとmanifestの生成・検証契約が増え、workflowとテストが複雑になる
- PR mergeから1日を超えると通常はfallback buildになり、短縮効果を得られない
- GitHub API / artifactの仕様変更時にはresolverがfallbackへ移り、所要時間が従来相当に戻る

## 4. Performance Criteria

計測区間を混同しない。

- PR CI: required CI run開始から6 checks完了まで
- Release再利用経路: `workflow_dispatch` run開始からRelease公開まで
- 全体: candidateとなるPR CI開始からRelease公開まで
- fallback: Release run開始からRelease公開まで

最初の実リリースで計測し、cache hit時の目標をPR CI 10分以内、再利用経路2分以内、全体12分以内、fallback 10分以内とする。目標超過は正しさの失敗とはせず、job / step timingとcandidate選択理由を次の改善判断に残す。

## 5. Validation Criteria

- [ ] manifest生成・検証とSHA-256改ざん検出のunit testが成功する
- [ ] merged PR / required checks / run attempt / artifact選択のfixture testが成功する
- [ ] tree、run、version、platform、filename、size、digest不一致を公開前に拒否する
- [ ] 実ZIP fixtureでmacOS / Windowsの内部構造を検査する
- [ ] candidate不成立時だけfallback buildが実行される
- [ ] candidate選択後の検証失敗ではdraft Releaseを作成しない
- [ ] required check名6件とbranch protection設定を変更しない
- [ ] `actionlint`、frontend / Rustの全品質gate、`git diff --check`が成功する

## 6. References

- ADR-0010: `docs/decisions/0010-ci-pipeline.md`
- ADR-0013: `docs/decisions/0013-manual-portable-zip-release.md`
- GitHub Actions artifacts: https://docs.github.com/actions/using-workflows/storing-workflow-data-as-artifacts
- Download workflow artifacts: https://docs.github.com/actions/managing-workflow-runs/downloading-workflow-artifacts
