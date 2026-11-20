# ダイアグラム (draw.io) の検証と実機受入

最終確認: 2026-11-20。仕様は[ADR-0017](decisions/0017-full-offline-diagram-editors.md) (§9 で draw.io 32.7.4 へ更新)。同梱 draw.io を 31.5.3 から 32.7.4 へ上げた時の検証を記録する。macOS の実アプリ受入は QA 用 identifier で行った。Windows の実行受入は未実施なので、両 OS の配布受入が完了したとは扱わない。

31.4.1 から 31.5.3 へ上げた時 (2026-09-30、ADR-0017 §8) の記録は、この文書の git 履歴 (#149) にある。

## ローカル自動検証

| 対象 | 結果 |
|---|---|
| Frontend typecheck / ESLint / Prettier | 成功 |
| Frontend 全体 (vitest) | 210 ファイル・2,633 テスト成功。資産契約 (`prepare-assets.test.mjs`) と実ブラウザ検証の補助関数 (`browser-support.test.mjs`) を含む |
| Rust fmt / Clippy (警告禁止) | 成功 |
| Rust 全体 | 554 テスト成功 (所要時間の比較用の 1 件は従来どおり ignore)。draw.io の SVG 取込変換は 31.4.1・31.5.3・32.7.4 の書出しで検証する |
| 資産契約 | `DRAWIO_VERSION` / `DRAWIO_COMMIT` と、vendor の `js/app.min.js` に内包された `DOMPurify 3.4.18` と `EditorUi.VERSION="32.7.4"` を照合 |
| 同梱資産 | 3,065 ファイル、`du -sk` で 117,136 KiB (31.5.3 は 3,366 ファイル、153,868 KiB)。`resources/dia_ja.txt` は 2,998 キー (31.5.3 は 2,022) |
| 上流の `js/PreConfig.js` | 31.5.3 と同一 (diff なし)。引き続き `scripts/drawio/PreConfig.js` で置き換える |

## 実ブラウザ検証 (`npm run test:diagram:browser`)

Chromium (Playwright 1.61.1、headless) で同梱資産を動かす。CI では実行しないローカル専用の検証である。

条件はアプリと同じにしている:
- `protocol.rs` の release 用 CSP と応答ヘッダを付け、`127.0.0.1` のランダム port から配信する。
- `http://tauri.localhost` の親ページから、アプリと同じ属性の sandboxed iframe に置く。
- URL と message は `drawioBridge.ts` をそのまま読み込んで使う。

同じテストを 31.5.3 (基準) と 32.7.4 で実行し、どちらも成功した。

| 項目 | 31.5.3 | 32.7.4 |
|---|---|---|
| 実行時の DOMPurify | 3.4.16 | **3.4.18** |
| `window.EXPORT_URL` | `null` (書出し service なし) | 同じ |
| 日本語 UI (`save` / `orthogonalEnds`) | 保存 / 直角の端点 | 同じ |
| init までの時間 | 535ms | 249ms |
| 配信した要求 / bytes (検証全体) | 63 件 / 26,144,135 bytes | 41 件 / 25,048,273 bytes |
| load の応答 XML = 入力、読込後 1.5 秒の autosave | 一致、0 件 | 一致、0 件 |
| textContent | 各ページのラベルを取得 | 同じ |
| PNG (`currentPage: true`, 2 倍) | 1 ページ目 644×262、2 ページ目 1202×604、不透明 | 同じ |
| SVG (`asText`) | `id="ge-svg-"`、4,151 bytes、script / イベント属性なし | 4,114 bytes。前景色が `light-dark()` から `var(--ge-adaptive-fg, #000000)` になる。ほかは同じ |
| ページ切替後の autosave | 1 件 (アプリでは未保存表示になる) | 1 件 |
| 数式 (MathJax) | `math4/` から 8 件を読込 | `math4/es5/drawio-mathjax.min.js` の 1 件 (1 ファイルの bundle)。2 ページ目の PNG に数式が描かれる |
| PlantUML の変換 | ローカルで変換 | ローカルで変換 (同梱 bundle 更新) |
| Atlassian 2025 の図形 | stencil と描画を確認 | 同じ (stencil は `js/stencils.min.js` の bundle から) |
| 親を持たない cell を含む図 | 両方の cell を保持し、保存にも残る | 同じ |
| ページの並べ替え (キー / タブのドラッグ) | Shift+→ とタブのドラッグで、ページ順が保存 XML に反映され、undo / redo で行き来できる | **Ctrl (macOS は ⌘) + Shift+→** とタブのドラッグで同じ |
| `/stencils/*.xml` への要求 | なし | なし |
| 外部通信 / 資産欠落 / JS エラー / アプリが拒否する message | 0 件 | 0 件 |

既知の遮断として、次の 2 件だけを完全一致で許容している (外部通信ではない)。

- `offline=1` で draw.io が service worker を登録しようとするが、`service-worker.js` は同梱せず、editor CSP も `worker-src 'none'` なので遮断される (CSP 違反 1 件と console error 2 件)。31.5.3・32.7.4 とも同じ。
- ツールバーの「接続」「途中点」は、選択中のスタイルにアイコンが無いと `background-image: url(null)` になり、loopback 内の `/null` が 404 になる。31.5.3 では 13 件起きたが、32.7.4 では起きない。

CSP 違反は service worker の 1 件だけで、MathJax の bundle による `blob:` Worker の遮断は起きない。bundle には読み上げ (speech rule engine) 用に `blob:` の Worker を作る経路があるが、31.5.3 の `math4/es5/core.js` にも同じ経路があり、数式の描画では使われない。

### ページを移すキー

32.6.2 から、選択が無い時の Shift+矢印はフォーカスの移動になり、ページの移動は Ctrl (macOS は ⌘) + Shift+矢印になった (上流の `EditorUi.createKeyHandler` の変更)。検証は `browser-support.mjs` の版ごとの期待値 `pageMoveKey` で、版に合ったキーを押す。アプリの側では上書きしない。

### Undo / Redo

**embed protocol の `invokeAction` による自動検証**

保存 XML の履歴が正確に再生されることを見る。属性の並び順と、保存のたびに変わる属性は比較から除く。

- 図形 (複製、頂点と edge の削除)
- 全削除
- グループ化と解除
- ページ (挿入、複製、削除)
- コンテナ内の edge と頂点の削除

31.5.3 と 32.7.4 の両方で成功した。

**宙に浮く edge**

頂点だけを消して edge を宙に浮かせると、削除直後は削除済みの頂点を参照したまま残り、redo の時に修復処理がこの参照を端点座標へ置き換える (31.5 系からの上流の挙動)。32.7.4 も同じで、undo は元へ正確に戻る。

**大きな図 (約 0.85 MiB)**

| 操作 | 31.5.3 | 32.7.4 |
|---:|---:|---:|
| 読込 | 2,167ms | 671ms |
| 全選択して削除 | 933ms | 499ms |
| undo | 2,347ms | 823ms |
| redo | 212ms | 87ms |

保存 XML は入力の 1.166 倍 (990,731 bytes) で、1 MiB 以内。両版で同じ。32.7.4 は読込と undo が約 3 倍速い (32.3.0 の forward reference の decode の線形化など)。

検証の成果物は `.generated/drawio-verification/` に置く:
- 結果の JSON
- PNG / SVG
- 手動受入用の `.drawio` (複数ページ、親を持たない cell、1 MiB 未満と超過)

## macOS 実アプリ

既存データから分離するため、identifier `com.zredjet.mymtools.drawioqa20261120` (製品名 `MyMyTools Drawio QA`) の release `.app` を 31.5.3 と 32.7.4 でビルドし、実際の WKWebView とネイティブダイアログで確かめた。identifier と製品名は `npm run tauri -- build --config '{"identifier":…,"productName":…}'` で上書きし、`tauri.conf.json` は変えていない。

31.5.3 のビルドで次の 2 ページの図を作って保存し、32.7.4 のビルドで開き直した:
- 1 ページ目: AWS (Lambda)、Azure (Virtual Machine、画像)、GCP (Compute Engine)、Kubernetes (Pod)、BPMN (タスク) と、接続点を固定した (`exitX` / `entryX` など。1 本は途中点つき) 4 本の直角の edge
- 2 ページ目: swimlane の中と外をつなぐ edge と数式

| 操作 | 結果 |
|---|---|
| 31.5.3 で保存した図を開き直す | 「編集できます」のまま。未保存にならない。5 種類の図形はすべて描かれ (stencil は `js/stencils.min.js` から)、4 本の edge の接続点と途中点は 31.5.3 と同じ |
| 32.7.4 で保存し直した XML と、31.5.3 で保存した XML の比較 | 加えた 2 つの編集 (図形の移動と追加) を除き、全 cell の style・端点・途中点・geometry が一致 |
| 2 ページ目の数式 | オフラインで描画 |
| 図形を Shift+矢印で動かし、ツールバーの undo / redo | 位置と edge の接続が正しく戻る。undo はページの切り替えまで戻り、redo で移動後に戻る |
| 配置 > レイアウト > 縦向きフロー (ELK) | オフラインで並べ替わり、⌘Z で元の配置と edge に戻る |
| その他の図形で AWS 2026 / Azure / Google Cloud Platform / GCP Icons / Kubernetes / BPMN 2.0 を追加 | パレットが追加され、サムネイルが描かれる |
| GCP Icons の図形 (style に `editableCssRules=.*`) の挿入 | 描かれ、書式パネルに色を変えられる CSS の規則 (`.st0` / `.st1` / `.st2`) が出る。GHSA-55cm-f4p8-xq88 の上限を入れた後も、通常の使い方は変わらない |
| ページの並べ替え (選択が無い時の ⌘⇧←) | ページ順が変わり、undo で戻る。Shift+← だけではページは動かない (32.6.2 からの上流の変更) |
| アプリのツールバーの PNG / SVG / .drawio 書出し (保存ダイアログ) | 3 つとも成功。PNG は表示中のページ (2 ページ目、数式あり)、.drawio は 2 ページ、SVG に script は無い |
| draw.io のメニューの ファイル > 形式を指定してエクスポート > SVG | 保存ダイアログの後、`SVG export is invalid` で拒否される。31.5.3 のビルドでも同じ (下の既存の制限) |
| SVG 書出し → キャンバスへ取込 | 単純な図 (fixture と同じ図) は変換の通知とともに取り込める。AWS などのクラウドの図形や GCP Icons の図形を含む書出しは拒否される。31.5.3 の書出しも同じ (下の既存の制限) |

次の 3 つは 31.5.3 でも同じく起きる既存の制限で、今回の更新の回帰ではない:
- draw.io 自身のメニューからの SVG 書出しは、先頭に `<?xml …?>` と `<!DOCTYPE svg …>` (編集できる SVG ではコメントも) を付ける。`image_export.rs` の `looks_like_svg` は `<?xml …?>` の直後に `<svg` を求めるため拒否する。ツールバーの SVG 書出し (embed protocol の `export`) は先頭が `<svg` なので使える。
- キャンバスの埋め込み画像は PNG / JPEG / WebP だけなので、SVG の画像 (`data:image/svg+xml`) を含む書出しは「画像の形式と内容が一致しません」で拒否される。
- 色を変えられる SVG 画像 (style `editableCssRules`) は、draw.io 30.3.13 から `<symbol>` と CSS 変数 (`--mx-r0` など) で書き出される。キャンバスの SVG ポリシーは CSS 変数の宣言を受け付けないため「未対応のCSS属性です: --mx-r0」で拒否される。

ページタブのドラッグによる並べ替えは、Tauri の OS ファイルドロップ処理のため 31.4.1 から実アプリで動かない (#149 の記録)。今回の実アプリでは確かめていない。

実アプリ (WKWebView) で外部通信 0 件を直接測る手段は release build に無い。editor CSP (`connect-src 'self'` など) が同じであることと、上の実ブラウザ検証で確かめている。

## portable ZIP / サイズ

| 対象 | 31.5.3 | 32.7.4 |
|---|---:|---:|
| draw.io 生成資産 (`du -sk`) / ファイル数 | 153,868 KiB / 3,366 | 117,136 KiB / 3,065 |
| release binary (macOS arm64、ローカル) | 70,554,784 bytes | 62,447,376 bytes |
| `.app` (`du -sk`、ローカル) | 71,660 KiB | 63,740 KiB |
| portable ZIP macOS arm64 (ローカル) | 55,516,891 bytes | 47,431,683 bytes |

ローカルの値は、上の QA identifier の release build (Tauri 2.11.6、同じ作業ツリー) を `ditto -c -k --sequesterRsrc --keepParent` で固めたものである。参考値として扱う。

上限は次の 2 つ:
- CI のサイズゲート (alpha.10 比 +10,000,000 bytes): macOS 61,390,662 bytes / Windows 61,105,964 bytes。31.5.3 の main (commit `adc3cdb`、run 44686278984) の CI の ZIP は macOS 55,512,992 bytes / Windows 55,468,756 bytes で、余裕は macOS 5,877,670 bytes / Windows 5,637,208 bytes
- 80,000,000 bytes の上限

## 32.6.10 へ戻す判断

32.6.10 (commit `c72c9a98b7a6ce392556ed04c05e0ff19f43f5c3`、上流の stable channel、DOMPurify 3.4.17) へ戻すのは、次の両方を満たす回帰を確認した時だけとする。

- 32.7.4 でだけ起きる (31.5.3 や 32.6.10 では起きない)。
- アプリで手動再現できる (図の読込み・保存・書出し、既存の図の表示、undo / redo)。

自動検証だけの失敗や、31.5.3 でも起きる挙動は、既存の挙動として記録する。今回の検証では該当する回帰はなかった。

32.6.10 も GHSA-55cm-f4p8-xq88 と DOMPurify の 3 件の修正を含み、stencil と MathJax の構成、ページを移すキーも 32.7.4 と同じである。戻す場合は次を変える:
- `DRAWIO_VERSION` / `DRAWIO_COMMIT` を 32.6.10 にし、`DRAWIO_DOMPURIFY_VERSION` を 3.4.17 にする。
- `browser-support.mjs` の期待値表に 32.6.10 の行を足す (`pageMoveKey` は 32.7.4 と同じ)。
- SVG 取込変換の fixture を 32.6.10 の書出しで足す。

## 再実行

Node 22 (22.18 以降。`drawioBridge.ts` を型除去で読み込むため) を使う。

```sh
git submodule update --init --depth 1 vendor/drawio
npm ci
npx playwright install chromium
npm run prepare:drawio
npm run test:diagram:browser
```

`npm ci` だけでは Playwright の Chromium 本体は入らないため、初回は `npx playwright install chromium` を実行する。

31.5.3 で基準を取り直す手順:

1. `git -C vendor/drawio fetch --depth 1 origin 0f419a92c769adb5fb20f2b18053a5ae8c7e4993` を実行し、同じ commit を `checkout --detach` する。
2. `scripts/drawio/prepare-assets.mjs` と `PreConfig.js` を更新前の版に戻す (`browser-support.mjs` には 31.5.3 の行が残っている)。
3. 同じコマンドを実行する。
4. 終わったら元に戻す。
