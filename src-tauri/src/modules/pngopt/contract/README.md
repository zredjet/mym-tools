# PNG最適化の契約テスト (ADR-0023 §2.7)

アプリ内の `shotq::optimize` が、shotq の CLI

```sh
shotq --quality=70-85 --speed 11 IN.png -o OUT.png
```

と同じバイト列を出すことを確かめる。`commands.rs` のテスト `contract_matches_the_shotq_cli` が、
ここにある PNG を最適化し、出力の SHA-256 と結果を `expected.txt` と比べる。

## ファイル

| 入力 | 通る経路 | CLI の結果 |
|---|---|---|
| `ui.png` | 量子化、置き換え、縁の副パレット | 0 (optimized) |
| `ui-icc.png` | `ui.png` に sRGB の ICC プロファイル (qcms によるパレット変換) | 0 |
| `ui-large.png` | 1280×800。自前の PNG リーダーの波面並列、deflate の 16 チャンクへの分割とレベル規則 | 0 |
| `photo-alpha.png` | 半透明と透明を含むグラデーション | 0 |
| `flat-truecolor.png` | 256 色以下の可逆パレット化 | 0 |
| `tiny.png` | 1×1。小さくならない | 98 (not_smaller)、出力は入力と同じ |
| `noise.png` | 乱数。品質が下限 70 に届かない | 99 (quality_too_low)、出力は入力と同じ |

`expected.txt` の各行は `<出力の SHA-256> <結果> <入力>`。結果が 98 / 99 のときの SHA-256 は入力そのもの
(CLI は `-o` が入力と違えば入力のバイト列を書く)。

## 期待値の作り直し (shotq を複製し直したとき)

`crates/shotq/UPSTREAM.md` の commit でビルドした shotq の CLI で作る。

```sh
cd src-tauri/src/modules/pngopt/contract
: > expected.txt
for f in $(ls *.png | sort); do
  shotq --quality=70-85 --speed 11 "$f" -o "/tmp/out-$f"
  case $? in 0) s=optimized;; 98) s=not_smaller;; 99) s=quality_too_low;; *) echo "error: $f"; break;; esac
  echo "$(shasum -a 256 "/tmp/out-$f" | cut -d' ' -f1) $s $f" >> expected.txt
done
```

入力の PNG は小さな合成画像に限る。実際のスクリーンショットはコミットしない。
