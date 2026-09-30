# ダイアグラム (draw.io) の検証と実機受入

最終確認: 2026-09-30。仕様は[ADR-0017](decisions/0017-full-offline-diagram-editors.md) (§8 で draw.io 31.5.3 へ更新)。同梱 draw.io を 31.4.1 から 31.5.3 へ上げた時の検証を記録する。macOS の実アプリ受入は QA 用 identifier で行った。Windows の実行受入は未実施なので、両 OS の配布受入が完了したとは扱わない。

## ローカル自動検証

| 対象 | 結果 |
|---|---|
| Frontend typecheck / ESLint / Prettier | 成功 |
| Frontend 全体 (vitest) | 68 ファイル・408 テスト成功。資産契約 (`prepare-assets.test.mjs`) と実ブラウザ検証の補助関数 (`browser-support.test.mjs`) を含む |
| Rust fmt / Clippy (警告禁止) | 成功 |
| Rust 全体 | 403 テスト成功。draw.io の SVG 取込変換は 31.4.1 と 31.5.3 の書出しの両方で検証する |
| 資産契約 | `DRAWIO_VERSION` / `DRAWIO_COMMIT` と、vendor の `js/app.min.js` に内包された `DOMPurify 3.4.16` と `EditorUi.VERSION="31.5.3"` を照合 |
| 同梱資産 | 3,366 ファイル、`du -sk` で 153,868 KiB (31.4.1 は 3,362 ファイル、151,604 KiB)。`resources/dia_ja.txt` は 2,022 キー |

## 実ブラウザ検証 (`npm run test:diagram:browser`)

Chromium (Playwright 1.61.1、headless) で同梱資産を動かす。CI では実行しないローカル専用の検証である。

条件はアプリと同じにしている:
- `protocol.rs` の release 用 CSP と応答ヘッダを付け、`127.0.0.1` のランダム port から配信する。
- `http://tauri.localhost` の親ページから、アプリと同じ属性の sandboxed iframe に置く。
- URL と message は `drawioBridge.ts` をそのまま読み込んで使う。

同じテストを 31.4.1 (基準) と 31.5.3 で実行し、どちらも成功した。

| 項目 | 31.4.1 | 31.5.3 |
|---|---|---|
| 実行時の DOMPurify | 3.4.13 | **3.4.16** |
| `window.EXPORT_URL` | `https://convert.diagrams.net/node/export` (CSP で遮断) | **`null`** (書出し service なし) |
| 日本語 UI (`save` / `orthogonalEnds`) | 保存 / (キーなし) | 保存 / 直角の端点 |
| init までの時間 | 434ms | 455ms |
| load の応答 XML = 入力、読込後 1.5 秒の autosave | 一致、0 件 | 一致、0 件 |
| textContent | 各ページのラベルを取得 | 同じ |
| PNG (`currentPage: true`, 2 倍) | 1 ページ目 644×262、2 ページ目 1202×604、不透明 | 同じ |
| SVG (`asText`) | `id="ge-svg-"`、4,151 bytes、script / イベント属性なし | 同じ (text ラベルの y 座標だけが異なる) |
| ページ切替後の autosave | 1 件 (アプリでは未保存表示になる) | 1 件 |
| 数式 (MathJax、`math4`) | 同一 origin から読込 | 同じ |
| PlantUML の変換 | ローカルで変換 | ローカルで変換 (同梱 bundle 更新) |
| Atlassian 2025 の図形 | なし | stencil と描画を確認 |
| 親を持たない cell を含む図 | 正常な cell が消える | **両方の cell を保持**し、保存にも残る |
| ページの並べ替え (Shift+→ / タブのドラッグ) | ページ順が保存 XML に反映され、undo / redo で行き来できる | 同じ |
| 外部通信 / 資産欠落 / JS エラー / アプリが拒否する message | 0 件 | 0 件 |

既知の遮断として、次の 2 件だけを完全一致で許容している (どちらも 31.4.1 でも起き、外部通信ではない)。

- `offline=1` で draw.io が service worker を登録しようとするが、`service-worker.js` は同梱せず、editor CSP も `worker-src 'none'` なので遮断される (CSP 違反 1 件と console error 2 件)。
- ツールバーの「接続」「途中点」は、選択中のスタイルにアイコンが無いと `background-image: url(null)` になる。loopback 内の `/null` が 404 になる。

### Undo / Redo

31.5 系では、全ての model 変更に undo / redo の実行時修復処理が入った。これを主な回帰リスクとして、次を検証した。

**embed protocol の `invokeAction` による自動検証**

保存 XML の履歴が正確に再生されることを見る。属性の並び順と、保存のたびに変わる属性は比較から除く。

- 図形 (複製、頂点と edge の削除)
- 全削除
- グループ化と解除
- ページ (挿入、複製、削除)
- コンテナ内の edge と頂点の削除

31.4.1 と 31.5.3 の両方で成功した。

**宙に浮く edge**

頂点だけを消して edge を宙に浮かせる操作は、31.4.1 から、削除済みの頂点を参照したまま終点座標を失う (上流の既存挙動)。31.5.3 は redo の時に修復処理がこの参照を端点座標へ置き換える。そのため、redo の結果は最初の削除と一致しない。undo は両版とも元へ正確に戻る。回帰ではないため、31.4.6 へ切り替える理由にはしない。

**大きな図 (約 0.85 MiB)**

| 操作 | 31.4.1 | 31.5.3 |
|---|---:|---:|
| 読込 | 1,393ms | 2,020ms |
| 全選択して削除 | 845ms | 846ms |
| undo | 1,566ms | 2,258ms |
| redo | 178ms | 189ms |

保存 XML は入力の 1.166 倍 (990,731 bytes) で、1 MiB 以内。31.5.3 は読込と undo が約 1.5 倍遅いが、実用上の問題はない。

検証の成果物は `.generated/drawio-verification/` に置く:
- 結果の JSON
- PNG / SVG
- 手動受入用の `.drawio` (複数ページ、親を持たない cell、1 MiB 未満と超過)

## macOS 実アプリ

既存データから分離するため、identifier `com.zredjet.mymtools.depsqa20260930` (製品名 `MyMyTools Deps QA`) の release `.app` で、実際の WKWebView とネイティブダイアログを使って検証した。

31.4.1 のビルドで先に作った図を、31.5.3 のビルドで開き直して確かめた:
- 単純な図
- 複数ページの図 (swimlane、数式を含む)

| 操作 | 結果 |
|---|---|
| 31.4.1 で保存した図を開き直す | 「編集できます」のまま。5 秒待っても未保存にならない |
| ページ切替 | 31.4.1 と同じく、切り替えの向きによって未保存表示になることがある (上の autosave 1 件と同じ既存挙動) |
| 日本語 UI、書式パネル | 日本語で表示 |
| 図形のドラッグ移動と、ツールバーの undo / redo | 位置と edge の接続が正しく戻る |
| その他 > 図の編集で XML を置換し、undo / redo | 置換前後を正しく行き来し、ページ構成を保つ |
| 数式ラベル | オフラインで描画 |
| 親を持たない cell を含む `.drawio` の取込 | 両方の cell を表示 |
| 1 MiB を超える `.drawio` の取込 | backend が拒否し、編集中の内容を保つ |
| SVG 書出し → ベクター描画へ取込 | 変換の通知 (HTML ラベル 2 件、ダークモード用の色 6 件など) とともに取込 |
| その他の図形 > Atlassian | Apps / Work Types / Logos のパレットが追加され、図形の挿入と描画ができる |
| 配置 > 挿入 > 詳細 > PlantUML | 編集できる図としてオフラインで挿入 |
| PNG 書出し (保存ダイアログ) | 書出しに成功 |
| ページの並べ替え (タブの右クリック > 移動、選択が無い時の Shift+← / →) | ページ順が変わり、undo / redo で行き来できる。保存して開き直しても順序を保ち、未保存にならない |
| ページタブのドラッグによる並べ替え | 動かない (次の段落。31.4.1 から同じ) |

ページタブのドラッグは HTML5 の drag and drop を使う。Tauri は OS からのファイルドロップを受け取るため、WKWebView の drag 処理 (draggingEntered / draggingUpdated / performDragOperation) を置き換えている。tauri-runtime-wry の handler が常に true を返すので、ページ内のドラッグも WebKit に渡らず、iframe 内の `dragover` / `drop` が発生しない。PDF 結合などがファイルドロップを使うため `dragDropEnabled` は無効にできない。ページの並べ替えは、右クリックメニューとキー操作で行える。

実アプリ (WKWebView) で外部通信 0 件を直接測る手段は release build に無い。editor CSP (`connect-src 'self'` など) が同じであることと、上の実ブラウザ検証で確かめている。

## portable ZIP / サイズ

| 対象 | 31.4.1 | 31.5.3 |
|---|---:|---:|
| draw.io 生成資産 (`du -sk`) / ファイル数 | 151,604 KiB / 3,362 | 153,868 KiB / 3,366 |
| release binary (macOS arm64、ローカル) | 69,854,992 bytes | 70,388,096 bytes |
| `.app` (`du -sk`、ローカル) | 71,024 KiB | 71,544 KiB |
| portable ZIP macOS arm64 (ローカル) | 55,471,762 bytes | 56,010,464 bytes |

ローカルの値は参考値である。31.4.1 の列は Tauri 2.11.6 の作業ツリー、31.5.3 の列は Tauri 2.11.0 の作業ツリーでビルドした。Tauri の差による ZIP の増減は、CI で ±3 KB 程度だった。

ADR-0017 には CI の値を記録する。上限は次の 2 つ:
- CI のサイズゲート (alpha.10 比 +10,000,000 bytes): macOS 61,390,662 bytes / Windows 61,105,964 bytes
- 80,000,000 bytes の上限

## 31.4.6 へ戻す判断

31.4.6 (commit `744cb5420fdf126efd7a09b1d7082ca3e12c0841`) へ戻すのは、次の両方を満たす undo / redo の回帰を確認した時だけとする。

- 31.5.3 でだけ起きる。
- アプリで手動再現できる。

自動検証だけの失敗や、31.4.1 でも起きる挙動は、既存の挙動として記録する。今回の検証では該当する回帰はなかった。

戻す場合は次を変える:
- `DRAWIO_DOMPURIFY_VERSION` を 3.4.15 にする。
- `browser-support.mjs` の期待値表に 31.4.6 の行を足す (`orthogonalEnds` と親を持たない cell の修正は含まれない)。

## 再実行

Node 22 (22.18 以降。`drawioBridge.ts` を型除去で読み込むため) を使う。

```sh
git submodule update --init --depth 1 vendor/drawio
npm run prepare:drawio
npm run test:diagram:browser
```

31.4.1 で基準を取り直す手順:

1. `git -C vendor/drawio fetch --depth 1 origin fea5e877f3e6f849331ad09894f7edb9771708fa` を実行し、同じ commit を `checkout --detach` する。
2. `scripts/drawio/prepare-assets.mjs` と `PreConfig.js` を更新前の版に戻す。
3. 同じコマンドを実行する。
4. 終わったら元に戻す。
