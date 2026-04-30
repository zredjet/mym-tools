# ADR-0008: 配布と更新 (自動更新なし、portable 差し替え方式)

- **Status**: Accepted
- **Date**: 2026-04-30
- **Deciders**: zredjet
- **Related**: ADR-0001 (Tauri v2) / `requirements.md` D-04 / §3.8 / `architecture.md` §8 / §9 / `data-model.md` §2

---

## 1. Context

アプリの配布方法と更新機構を確定する。

選定に効く制約 (`requirements.md` / `architecture.md`):

| 制約 | 趣旨 |
|------|------|
| 個人ローカルツール | アカウント・サーバー・自動更新サービスの維持運用は不要 |
| D-04: 自動更新なし | ユーザーがエクスプローラー / Finder で差し替えるだけで更新が完結する構成 |
| 軽量性 (3.1) | 自動更新ランタイム / Tauri Updater のバンドル増を避けたい |
| ユーザーデータ保護 | アプリ実行ファイルとユーザーデータが**物理分離**され、差し替え時に消えない (architecture.md §8 / data-model.md §2) |
| OS の保護機構 | macOS Gatekeeper / Notarization、Windows SmartScreen を突破するためコード署名は必要 (3.8) |
| オフライン動作 (3.4) | 起動時にネットワークアクセスを行わない (アプリ内自動更新チェックも避ける) |

## 2. Decision

| 項目 | 採用 |
|-----|------|
| 自動更新機構 | **実装しない** (Tauri Updater 不採用) |
| アプリ更新方法 | **ユーザーがエクスプローラー / Finder で実行ファイルを差し替えるだけで完結** |
| 配布形式 (macOS) | **`.app` バンドル** を **DMG** に同梱 / Applications フォルダへドラッグドロップ |
| 配布形式 (Windows) | **portable ZIP** (主) / **NSIS インストーラ** (副、必要に応じて) |
| コード署名 (macOS) | **公開配布の目標**: Apple Developer Program のコード署名 + Notarization。**Phase 1 (自己利用 / 限定配布) では無署名ビルドを許容** |
| コード署名 (Windows) | **公開配布の目標**: OV コードサイニング証明書または Azure Trusted Signing 等で署名 (EV は追求しない / §3.4)。**Phase 1 (自己利用 / 限定配布) では無署名ビルドを許容** |
| ユーザーデータ配置 | OS 標準のユーザーデータディレクトリ (Tauri `app_data_dir()`、`architecture.md` §8 / `data-model.md` §2) |
| アプリ起動時のバージョン整合チェック | **DB schema バージョンが想定外なら起動停止 + エラー画面** (`data-model.md` §4 / architecture.md §9) |
| 「最新版を確認」機能 | アプリ内ボタンから **OS の既定ブラウザでリリースページを開く** だけ。バックグラウンドでの自動チェックはしない (オフライン動作 §3.4 と整合) |
| リリース告知の経路 | GitHub Releases (主)。アプリ内ヘルプから「リリースページを開く」リンクを提供 |
| アプリ内バージョン表示 | 設定画面 / About 画面に現行バージョンを表示 |

### 2.1 macOS の配布フロー

#### Phase 1 (自己利用 / 限定配布)

```
[ビルド]
  cargo tauri build → mym-tools.app
  ↓
[配布]
  .app を ZIP / DMG にパッケージング (無署名)
```

#### 公開配布 (将来)

```
[ビルド] ↓ 同上
  ↓
[コード署名]
  codesign で .app を署名 (Apple Developer 証明書)
  ↓
[Notarization]
  notarytool で Apple に提出 → 検査通過 → ticket を staple
  ↓
[配布]
  DMG に最終パッケージング
```

ユーザー視点:
1. DMG / ZIP をマウント・展開
2. `mym-tools.app` を Applications にドラッグドロップ
3. (更新時は) 既存 `.app` を上書き
4. **無署名版の場合**: 初回起動時に Gatekeeper 警告 → 「右クリック → 開く」で許可

### 2.2 Windows の配布フロー

#### Phase 1 (自己利用 / 限定配布)

```
[ビルド]
  cargo tauri build → mym-tools.exe + 関連ファイル
  ↓
[配布]
  ZIP に固める (portable / 無署名)
```

#### 公開配布 (将来)

```
[ビルド] ↓ 同上
  ↓
[コード署名]
  signtool で .exe を署名 (OV 証明書または Azure Trusted Signing)
  ↓
[配布]
  ZIP / 必要に応じて NSIS インストーラ
```

ユーザー視点 (portable):
1. ZIP を任意のディレクトリに展開
2. `mym-tools.exe` を起動
3. (更新時は) ZIP を上書き展開、または新しい実行ファイルを差し替え
4. **無署名版の場合**: SmartScreen 警告 → 「詳細情報 → 実行」で進める

### 2.3 ユーザーデータの物理分離

D-04 を確実に守るため、**ユーザーデータをアプリ実行ファイルと同じディレクトリには絶対に置かない**。

| 種別 | 配置 | OS 別パス例 |
|------|-----|-----------|
| ユーザーデータ (DB / 設定 / バックアップ / ログ) | `<userdata>/` (Tauri `app_data_dir()`) | macOS: `~/Library/Application Support/mym-tools/` / Windows: `%APPDATA%\mym-tools\` |
| アプリ本体 | OS の標準アプリ配置 | macOS: `/Applications/mym-tools.app/` / Windows: ユーザーが展開した任意ディレクトリ |

これにより、ユーザーがアプリを差し替えても DB / 設定 / バックアップは保持される。

### 2.4 コード署名 (公開配布の目標)

**コード署名は配布品質の要件であり、Phase 1 実装開始のブロッカーではない**。

| OS | 公開配布での署名 | 追加要件 | Phase 1 での扱い |
|----|--------------|---------|---------------|
| macOS | Developer ID 署名 | **Notarization 必須** (macOS 10.15+ Gatekeeper 突破のため) | **無署名ビルド許容** |
| Windows | OV 署名または Azure Trusted Signing | EV は追求しない (§3.4) | **無署名ビルド許容** |

**Phase 1 における無署名配布の許容範囲**:
- 自己利用 / 限定配布の範囲で運用する
- ユーザーガイドに必ず記載:
  - macOS: Gatekeeper 警告 → 「右クリック → 開く」で初回許可する手順
  - Windows: SmartScreen 警告 → 「詳細情報 → 実行」で進める手順
  - 無署名であるリスク (改ざん検知が無い / 配布元検証が無い) の説明

### 2.5 本 ADR と CI ADR / CD ADR の責任分界

本 ADR では**配布方針のみ**を確定する。実装パイプラインは **CI と CD で 2 本立て**として分離する:

- **CI ADR (検証パイプライン)**: build / test / lint / typecheck / matrix 戦略 → **ADR-0010 で確定済**
- **CD ADR (リリースパイプライン)**: 署名・Notarization・Release 作成・SHA-256 添付・secrets 管理 → **公開配布判断時に着手**

| 本 ADR (配布方針) で扱うもの | CI ADR (ADR-0010) で扱うもの | CD ADR (将来) で扱うもの |
|--------------------------|------------------------|----------------------|
| 自動更新を持つか | GitHub Actions matrix の中身 | リリースアーティファクト生成 (DMG / NSIS / portable ZIP) |
| 配布形式は何か (DMG / ZIP / NSIS 等) | `cargo tauri build --no-bundle` の検証 | secrets 管理 / notarytool / signtool / Azure Trusted Signing |
| 署名・Notarization を公開配布の目標にするか | キャッシュ戦略 / branch protection | SHA-256 生成 / GitHub Release への成果物添付 |
| ユーザーデータをアプリ本体と分離するか | dependabot / `paths-ignore` / `concurrency` | tag / semver / GitHub Release 作成 |
| 「最新版を確認」の導線をどうするか | `clippy.toml` / `eslint` / `tsconfig` の CI 連携 | コード署名証明書管理 |

CI ADR は Phase 1 着手と同時に有効化済 (ADR-0010)。CD ADR は Phase 1 の公開配布判断時 (もしくは初回リリース準備時) に着手する。Phase 1 実装中は手元のローカルビルドで十分。**signing / notarization secret を扱う workflow は ADR-0010 §1.1 / ADR-0009 §6.2 の方針により `pull_request` トリガと同居させず `release.yml` 別ファイルとする。**

### 2.6 起動時のバージョン整合チェック

新版アプリが古い DB スキーマを開けない / 旧版アプリが新版データを開けないケースに備える:

- 起動時に `meta.db_schema_version` を読み、現行アプリが対応するバージョンと比較
- 旧 DB → 新版アプリ: 必要なマイグレーションを順次適用 (data-model.md §14)
- 新 DB → 旧版アプリ: **起動を停止しエラー画面**を表示 (黙って動作させない、`data-model.md` §4 / `architecture.md` §9)
- payload 側の未来バージョン検出は ADR-0006 §7 / `module-contract.md` §7.3 を参照

### 2.7 「最新版を確認」機能

オフライン動作と整合させるため、**バックグラウンドの自動バージョンチェックは行わない**。

代わりに:
- 設定画面 / ヘルプメニューに「最新版を確認」ボタンを置く
- 押下時、OS の既定ブラウザで GitHub Releases ページを開く
- ユーザーが目視で新版有無を判断 / 必要なら配布物をダウンロード

リリース告知のチャネルは GitHub Releases を主、必要に応じて自サイトのお知らせや RSS / ATOM フィードを副として提供する想定 (Phase 1 では GitHub Releases のみ)。

## 3. Alternatives Considered

### 3.1 自動更新機構

| 候補 | 評価 |
|------|-----|
| **自動更新なし (採用)** | 個人ツールとして必要十分。Tauri Updater 関連の依存・コード・運用 (アップデート配布サーバ / 署名 / ローリング戦略) が不要 |
| Tauri Updater (公式) | ✅ Tauri 公式機構。✅ delta updates 対応。❌ アプリ側に updater ランタイムが入る (バイナリ増)。❌ 配布サーバ (HTTPS で update manifest をホスト) の運用が要る。❌ オフライン動作の方針 (§3.4) と矛盾する起動時自動チェックがデフォルト |
| 自前の更新通知 (起動時に GitHub Releases API を叩く) | ❌ オフライン動作の方針と矛盾。❌ レート制限・障害時のフォールバック設計が要る |
| Sparkle (macOS 専用 / WinSparkle (Windows 専用)) | ❌ クロスプラットフォーム性が崩れる。Tauri との統合がカスタム実装になる |
| MS Store / Mac App Store 配布 | ❌ サンドボックス制約 (任意ファイルパスへのアクセス制限等) で M-LinkMemo の OS ファイラー連携が動かなくなる可能性。❌ アプリ審査の運用負荷 |

→ **自動更新なし採用**。個人ツール規模で運用負荷を最小化する第一原則。

### 3.2 配布形式 (macOS)

| 候補 | 評価 |
|------|-----|
| **DMG (`.app` 同梱) (採用)** | macOS の慣習通り。ユーザーが DMG をマウント → Applications にドラッグでセットアップ完了 |
| PKG インストーラ | ❌ サイレントインストール / システムディレクトリ書き込みは個人ツール用途に過剰。Notarization のためにスクリプト署名も追加で必要 |
| ZIP (`.app` 直接) | △ DMG と比較してインストールガイドの分かりやすさで劣る。Notarization の staple は ZIP 越しでも有効だが、初回起動の Gatekeeper UX が悪い |
| Mac App Store | ❌ 3.1 の通りサンドボックス制約 |

→ **DMG (`.app` 同梱) 採用**。

### 3.3 配布形式 (Windows)

| 候補 | 評価 |
|------|-----|
| **portable ZIP (主) (採用)** | D-04 の差し替え更新と最も相性が良い。インストーラ不要 / レジストリを汚さない / アンインストールはディレクトリ削除のみ |
| NSIS インストーラ (副) | **ショートカット作成・初心者向け導線・アンインストール登録が必要になった場合の副配布**。利点: ショートカット / Add or Remove Programs 登録 / インストールガイドの分かりやすさ。**SmartScreen 回避を NSIS の主目的にはしない** (signed installer であっても新規証明書は同様にレピュテーション獲得が必要であり、portable ZIP との差にはならない) |
| MSI | ❌ 個人ツールに対して重い (組織配布向けの仕組み) |
| MSIX | ❌ MS Store 配布前提でないと運用が複雑。Mac App Store と同じく審査負荷 |
| Microsoft Store | ❌ サンドボックス制約 |

→ **portable ZIP 主 + NSIS 副採用**。

### 3.4 コード署名

| 候補 | 評価 |
|------|-----|
| **公開配布で署名 + macOS Notarization、Phase 1 は無署名許容 (採用)** | 公開配布品質と個人開発の現実のバランス。実装開始のブロッカーにしない。署名コストは公開配布判断時に予算確保 |
| Phase 1 から両 OS で署名必須 | ❌ Apple Developer Program / Windows OV 証明書のコスト (年額 数千〜数万円) を Phase 1 着手の前提にすると個人開発のスタートが遅れる |
| 完全無署名 (公開配布も含めて) | ❌ ユーザーへの配布品質として弱い。改ざん検知 / 配布元検証ができない |
| Windows EV 署名 | ❌ **2024 年以降、Microsoft の資料では EV 証明書だけで SmartScreen 警告を即時回避できる前提は成立しない**。EV 署名でも OV と同じく評判 (レピュテーション) 構築が必要になっている。EV 取得のハードウェアトークン運用負荷 (年額数十万円) は割に合わない |
| Azure Trusted Signing 等のクラウド署名 | ✅ 将来的に魅力的な選択肢 (証明書のハードウェアトークン管理が不要 / 月額課金)。Phase 1 公開配布タイミングで OV 自前証明書と並行で再検討 |
| ベータ版のみ無署名 | △ 開発中の私製ビルドは無署名でも問題ないが、本 ADR の「公開配布フェーズの目標」と整合する形で運用する |

→ **両 OS 署名 + macOS Notarization 採用**。

### 3.5 リリース告知 / バージョン取得

| 候補 | 評価 |
|------|-----|
| **アプリ内ボタンから OS ブラウザでリリースページ開く (採用)** | オフライン動作と整合。実装が極小。ユーザーが意識的に確認 |
| 起動時にバージョン API を叩く | ❌ オフライン動作と矛盾 |
| メールニュースレター | ❌ 個人ツールで運用負荷高 |
| RSS / ATOM フィード提供 | △ Phase 1 では追加実装無しで GitHub Releases の RSS をそのまま使える。明示的に案内する程度 |

→ **アプリ内ボタンから OS ブラウザ採用**。

## 4. Consequences

### 4.1 Positive
- **アプリ更新が極めて単純**: ユーザーは新しい `.app` / `.exe` で上書きするだけ。失敗のシナリオが少ない
- **ユーザーデータが差し替えで失われない**: アプリ本体とユーザーデータが OS レベルで別ディレクトリ (D-04 の実装根拠)
- **配布バイナリが小さい**: Tauri Updater 関連の依存が無いためインストーラサイズ目標 (30MB) を圧迫しない
- **オフライン動作と整合**: 起動時のネットワークアクセスがゼロ
- **更新サーバー運用ゼロ**: 個人開発で大きい (HTTPS / 署名検証 / 可用性 / DDoS 対策などが要らない)
- **配布物が他ツール (sqlite3 CLI 等) と直接互換**: バックアップ・export JSON はコード署名と独立に他ツールで開ける

### 4.2 Negative / Risks
- **ユーザーが古いバージョンを使い続けやすい**: 自動通知が無いため、新版があっても気づかない可能性
  - 対策: アプリ内に「最新版を確認」ボタン (§2.6) / アプリ内バージョン表示 / リリース告知の場所を README で明示
- **Phase 1 無署名配布のリスク**: 改ざん検知 / 配布元検証ができない
  - 対策: 自己利用 / 限定配布の範囲に留める。ユーザーガイドにリスクと起動手順 (Gatekeeper / SmartScreen 警告対応) を記載
- **公開配布フェーズで発生するコード署名コスト** (Phase 1 では発生しない): macOS Apple Developer Program ($99/年) + Windows OV 証明書 (年額 数千〜数万円) または Azure Trusted Signing 等のクラウド署名サービス
  - 対策: 公開配布判断時に予算確保。Phase 1 実装着手のブロッカーにしない
- **公開配布時の Windows SmartScreen レピュテーション問題**: 新規 OV / EV 証明書ともに、署名済みでも初回ダウンロード時に警告が出る (2024 年以降 EV だけで即回避できる前提は成立しない)
  - 対策: ユーザーガイドに警告対応手順を記載。時間経過とダウンロード数で警告が消える
- **公開配布時の macOS Notarization 失敗の可能性**: ハードコードされた API キーや禁止 API 使用で提出が落ちる
  - 対策: CD ADR (将来) で Notarization 検証ステップを組み込む
- **公開配布時の証明書失効・期限切れリスク**: 証明書更新ミスで配布版バイナリが失効
  - 対策: 公開配布フェーズで証明書期限管理ルール (CI と個人カレンダーで二重化) を確立

### 4.3 Neutral
- portable ZIP 配布は Windows ユーザーにとって馴染みが薄い場面がある (慣れたユーザーは抵抗ないが、初心者には NSIS インストーラの方が分かりやすい)
- 自動更新を将来導入したくなった場合は Tauri Updater 追加で対応可能 (本 ADR の Superseded で別 ADR を起こす)

## 5. Mitigations

| リスク | 対策 |
|-------|------|
| ユーザーが古い版を使い続ける | アプリ内に「最新版を確認」ボタン + 起動画面 / 設定画面に現行バージョン表示 + README にリリース告知場所明記 |
| Phase 1 無署名配布の警告 | ユーザーガイドに OS 別の起動手順 (macOS: 右クリック→開く、Windows: 詳細情報→実行) と無署名のリスクを明記 |
| 公開配布フェーズの署名コスト | 公開配布判断時に予算確保 (Phase 1 実装着手の前提にしない)。OV vs Azure Trusted Signing を選定 ADR で扱う |
| Windows SmartScreen 警告 (公開配布フェーズ) | ユーザーガイドに警告対応手順を記載。時間経過でレピュテーションが上がる。EV を即回避目的では使わない |
| Notarization 失敗 (公開配布フェーズ) | CD ADR (将来) で Notarization ステップを組み込み、リリース前に必ず通す。手動リリースは禁止 |
| 証明書失効 (公開配布フェーズ) | 期限管理を CI と個人カレンダーで二重化 |
| 旧版アプリで新 DB を開く事故 | 起動時 `db_schema_version` チェックで起動停止 (§2.6)。ユーザーには「アプリを最新版に更新してください」ガイドを表示 |
| ユーザーが間違ってアプリディレクトリにユーザーデータを置く | OS 標準のユーザーデータディレクトリを使う規約 (`Tauri::app_data_dir()` 経由のみ。コード内でハードコードされたパスを書かない) |

## 6. Validation Criteria

### 6.1 Phase 1 最低条件 (実装開始のブロッカー)

- macOS / Windows ともに**無署名ビルド**で起動 / 更新 / データ保持を確認できること
- macOS で `.app` を Applications に上書きするだけで更新が完結し、`<userdata>/` (DB / 設定 / バックアップ) が消失しないこと
- Windows で portable ZIP の中身を上書き展開するだけで更新が完結し、`%APPDATA%\mym-tools\` が消失しないこと
- アプリ内「最新版を確認」ボタンが OS の既定ブラウザで GitHub Releases ページを開くこと
- バックグラウンドでネットワークアクセスが発生していないこと (Tauri 許可リスト / プロキシツールで確認)
- 旧版アプリで新 DB スキーマを開いた場合、起動が停止してエラー画面が出ること
- アプリのバージョン番号がアプリ内 (設定 / About) に表示されていること

### 6.2 公開配布条件 (Phase 1 後 / 別タイミングで判断)

公開配布判断時に以下を満たすこと:

- **macOS**: Developer ID 署名 + Notarization 済みアプリが Gatekeeper 警告なしで初回起動できること
- **Windows**: 可能なら OV 署名済み (または Azure Trusted Signing 経由) の実行ファイルが SmartScreen を「詳細情報 → 実行」で通せること (新証明書ではレピュテーション獲得まで時間が必要)
- **SHA-256 ハッシュをリリースノートに掲載** しユーザーが配布物の整合性を検証可能であること
- 配布パイプラインが CI で自動化されていること (CI 検証は ADR-0010、CD リリース手順は将来の CD ADR)

## 7. Known Concerns / 将来見直しが要りうる判断

#### 7.1 自動更新の将来導入

- ユーザー数が増え「古い版を使い続ける」問題が顕在化したら自動更新を再検討
- **対応**: Tauri Updater 導入の ADR を別途起こす (本 ADR を Superseded にする)。導入時はオフライン動作の方針 (3.4) との整合性を再確認

#### 7.2 Mac App Store / Microsoft Store 配布

- 個人ツールが将来「より広いユーザー層に届けたい」となった場合の検討余地
- **対応**: ストア配布のサンドボックス制約 (M-LinkMemo の OS ファイラー連携など) との整合を取った上で別 ADR

#### 7.3 Windows EV 証明書 / Microsoft からの認証

- SmartScreen の警告を完全になくしたい場合の選択肢
- **対応**: Phase 1 では追求しない。OV 証明書 + 時間によるレピュテーション獲得で実用上問題なければそのまま

#### 7.4 アプリ内通知 (自動更新なしのまま新版告知だけ送る)

- 「自動更新はしない / 新版があることだけ通知する」という中間策
- **懸念**: オフライン動作 (§3.4) と矛盾する。ユーザーがネットを禁止した環境ではエラーが出る
- **対応**: 通知タイミングを「起動時に都度チェック」ではなく「ユーザーが明示的に『最新版を確認』を押したとき」に限定する規約は本 ADR §2.6 で確定済。これで両立する

#### 7.5 配布物の整合性検証 (ハッシュ / 署名検証ガイド)

- ユーザーが配布物を信頼できる方法でダウンロードできるよう、SHA-256 などのハッシュをリリースページに併記する
- **対応**: Phase 1 のリリース運用で SHA-256 をリリースノートに記載する規約。CI でハッシュ自動計算

#### 7.6 Linux サポート (将来)

- 要件 §3.2 で Linux はサポート対象外
- **対応**: 顕在化したら新 ADR で AppImage / Flatpak / Snap / .deb / .rpm のどれを取るか検討

#### 7.7 Azure Trusted Signing 等のクラウド署名サービス

- 2024 年以降 Microsoft が提供する Azure Trusted Signing は、ハードウェアトークンによる証明書管理を不要にし、クラウド経由で署名できる仕組み (月額課金)
- Phase 1 では公開配布タイミングが未定のため評価しない
- **対応**: 公開配布判断時に「OV 自前証明書 vs Azure Trusted Signing vs その他のクラウド署名サービス」を比較する選定 ADR (CD ADR の一部 or 別 ADR) を起こす

#### 7.8 CI ADR と CD ADR の 2 本立て構成

- 本 ADR は配布方針のみを扱う。CI / CD は 2 本立てで分離して扱う:
  - **CI ADR (検証パイプライン)**: ADR-0010 で確定済 (Phase 1 着手と同時に有効化)
  - **CD ADR (リリースパイプライン、将来)**: 署名・Notarization・signtool / Azure Trusted Signing 統合・SHA-256 / GitHub Releases 添付・secrets 管理を扱う
- **対応**: CD ADR は Phase 1 の公開配布判断タイミング (もしくは初回リリース準備時) に着手する。Phase 1 実装中は ADR-0010 の `--no-bundle` 検証 + ローカルビルドで運用

## 8. References

- ADR-0001 (Tauri v2)
- 要件: `docs/requirements.md` D-04 / §3.2 / §3.4 / §3.8
- アーキテクチャ: `docs/architecture.md` §8 (ファイル配置) / §9 (更新機構)
- データモデル: `docs/data-model.md` §2 (WAL モードのファイルコピー禁止) / §4 (`db_schema_version`)
- Tauri 配布: https://v2.tauri.app/distribute/

## 9. 改訂履歴

| 日付 | 版 | 内容 |
|------|----|------|
| 2026-04-30 | 1.0 | 初版ドラフト |
| 2026-04-30 | 1.1 | レビュー反映: コード署名を「公開配布の目標」に位置付け直し、Phase 1 では無署名ビルドを許容 (実装開始のブロッカーにしない) §2 / §2.1 / §2.2 / §2.4 / §3.4 / NSIS の主目的から SmartScreen 回避を除外し「ショートカット・初心者向け導線・アンインストール登録が必要になった場合の副配布」と表現を弱めた §3.3 / Windows EV 不採用を「2024 年以降 EV だけで SmartScreen 即回避できる前提が成立しない」根拠で強化 §3.4 / 新規 §2.5 で本 ADR と CI/CD ADR の責任分界を明示 (CI 詳細は別 ADR で扱う) / Validation Criteria を §6.1 Phase 1 最低条件と §6.2 公開配布条件に分割 / Known Concerns に §7.7 Azure Trusted Signing と §7.8 CI/CD ADR の必要性を追加 / Mitigations / Negative を Phase 1 vs 公開配布フェーズで段階化 (Accepted) |
| 2026-04-30 | 1.2 | ADR-0010 受理反映: §2.5 を「CI ADR + CD ADR の 2 本立て」構造に書き換え、CI ADR は ADR-0010 で確定済・CD ADR は将来として明示。`pull_request` トリガと signing secret を同居させない方針も注記 / §7.8 を「CI ADR と CD ADR の 2 本立て構成」に変更し ADR-0010 への参照を追加 / §4.2 / §5 / §6.2 / §7.7 の本文中の「CI/CD ADR」表記を「CD ADR (将来)」に統一して責務分界を整合 |
