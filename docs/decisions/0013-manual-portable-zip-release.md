# ADR-0013: 手動portable ZIPリリース

- **Status**: Accepted
- **Date**: 2026-08-22
- **Deciders**: zredjet
- **Related**: ADR-0008 (配布 / 自動更新なし) / ADR-0010 (CIパイプライン) / `requirements.md` §3.8 / `architecture.md` §9・§13
- **Supersedes**: ADR-0008 §2のうち配布形式に関する決定、§2.1・§2.2のDMG / NSIS / installer記述

---

## 1. Context

Phase 1のリリースは、リリースしたいタイミングで担当者がGitHub Actionsへversionを入力して実行する。自動更新は持たず、ユーザーはportable archiveを展開してアプリ本体を差し替える。

従来の`release.yml`には次の問題があった。

- Releaseを先に作成するため、OS別ビルド失敗時に空または片系だけのReleaseが残る
- bundle globが0件でもstepが成功し得る
- 入力tagと`package.json` / `Cargo.toml` / `tauri.conf.json`のversion一致を検証しない
- `--clobber`により公開済みRelease assetを同じtagで置換できる
- 実配布がmacOS DMG / Windows NSISとなり、portable差し替え方針と一致しない

コード署名・Notarization・Windows署名は、ADR-0008どおりPhase 1の必須条件にはしない。

## 2. Decision

### 2.1 起動とversion契約

- Release workflowのtriggerは`workflow_dispatch`だけとし、tag pushでは自動起動しない
- workflowは`main`からのみ手動実行できる
- 入力はSemVerの`version`とし、先頭の`v`は任意。内部tagは常に`v<version>`へ正規化する
- `v<version>` tagは事前にpush済みでなければならない
- tag commit上の`package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json`がすべて入力versionと一致しなければ停止する
- 検証後はtag名ではなくcommit SHAをOS別buildへ渡し、実行中のtag移動でbuild内容が変わらないようにする。公開直前にもtagが同じSHAを指すことを再確認する

### 2.2 portable成果物

| OS | build | ZIP内容 | Release asset |
|----|-------|---------|---------------|
| macOS | `cargo tauri build --target aarch64-apple-darwin --bundles app` | `MyMyTools.app` | `MyMyTools_<version>_macos_aarch64.zip` |
| Windows | `cargo tauri build --no-bundle` | `MyMyTools.exe` | `MyMyTools_<version>_windows_x64.zip` |

- macOSは`ditto`で`.app`の構造とmetadataを保持してZIP化する
- Windowsはrelease executableだけをZIP化し、NSIS / MSIを生成しない
- `tauri.conf.json`の共通設定ではbundleを無効化し、`tauri.macos.conf.json`だけ`.app` bundleを有効化する
- 各build jobはZIPの内部検査を行い、`actions/upload-artifact`の`if-no-files-found: error`で欠落を失敗にする

### 2.3 Release公開順序と不変性

1. version / tag / 既存Releaseを検証する
2. macOS / Windowsを`fail-fast: false`でbuildし、両portable ZIPをworkflow artifactへ保存する
3. publish jobで成果物が期待名の2件ちょうどであり、非空のZIPであることを再検証する
4. 両build成功後にdraft GitHub Releaseを作成する
5. 2 ZIPを`--clobber`なしでuploadする
6. upload成功後にdraftを公開する

公開処理が失敗した場合、その実行が作成した未完成draftだけを削除する。既存Releaseがある場合はworkflowを失敗させ、assetの上書きやReleaseの再作成は行わない。

### 2.4 権限と将来範囲

- workflow全体は`contents: read`、publish jobだけ`contents: write`へ昇格する
- 使用するsecretはGitHub標準の`GITHUB_TOKEN`だけとする
- 第三者Actionは完全commit SHAでpinする
- コード署名、Notarization、Windows署名、checksum、provenanceは公開配布向けCD拡張として別途扱う

## 3. Consequences

### 3.1 Positive

- 2 OSの成果物が揃わないReleaseを通常公開しない
- 手動入力したversionと実際にbuildするソースのversionが一致する
- installer固有制約を避け、差し替え更新をmacOS / Windowsで統一できる
- 公開済みtagのasset差し替えを防ぎ、Releaseの追跡性を高める

### 3.2 Negative / Risks

- macOSはApple Silicon専用で、Intel Macをサポートしない
- Windowsはinstaller、ショートカット作成、アンインストール登録を提供しない
- Phase 1は無署名のため、Gatekeeper / SmartScreenの警告対処が必要
- tagと3つのversion設定を事前に揃えてpushする手作業は残る

## 4. Validation Criteria

- [ ] 通常versionとpre-release versionをSemVerとして正規化できる
- [ ] 3設定のどれかが入力versionと異なる場合にpublish前に失敗する
- [ ] macOS / Windowsのどちらかのartifactが欠けた場合に失敗する
- [ ] 空ファイルまたはZIPでないartifactを拒否する
- [ ] OS別buildが両方成功するまでGitHub Releaseを作成しない
- [ ] Release assetがportable ZIP 2件だけになる
- [ ] 既存Releaseへの再実行が上書きせず失敗する

## 5. References

- ADR-0008: `docs/decisions/0008-distribution-no-autoupdate.md`
- ADR-0010: `docs/decisions/0010-ci-pipeline.md`
- Tauri Distribution: https://v2.tauri.app/distribute/
- Tauri macOS Application Bundle: https://v2.tauri.app/distribute/macos-application-bundle/
- GitHub Actions Artifacts: https://docs.github.com/actions/using-workflows/storing-workflow-data-as-artifacts
