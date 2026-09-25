# shotq (vendored)

「PNG最適化」モジュール (`pngopt`) が使う shotq のライブラリ部分の複製です (ADR-0023)。
shotq のリポジトリは private のため、git 依存ではなくソースを複製して固定しています。

## 複製元

| 項目 | 値 |
|---|---|
| リポジトリ | `zredjet/shotq` (private) |
| バージョン | 0.23.2 + ライブラリ化 (shotq `docs/HANDOFF.md` P49) |
| commit | `673e98a40b1a4939e004f13d58cfab8299b6af16` (ブランチ `feat/library-api`、親は `a90ba53`) |
| 複製した日 | 2026-09-25 |

## 複製したもの

- `src/{lib,cm,color,deflate,quant,subpal}.rs` — 上流のまま。**このリポジトリでは編集しない**
- `LICENSE-MIT` / `LICENSE-APACHE` / `LICENSES/` / `THIRD_PARTY_NOTICES.md` — 上流のまま
- `Cargo.toml` — 上流から次の点だけ変えている
  - GPL の `liq` feature と `imagequant` 依存を削除 (ソース中の `cfg(feature = "liq")` は常に無効になる)
  - `[profile.release]` を削除 (依存として使うときはアプリのプロファイルに従う。アプリ側は `src-tauri/Cargo.toml` の `[profile.release.package.shotq]`)
  - 上流で既知の dead code 警告を抑止し、`liq` の cfg を既知として宣言

CLI (`src/main.rs`)、テスト用画像、`research/`、`tools/`、`docs/` は複製していません。

## 依存の版

出力のバイト列が shotq の CLI と一致するよう、`src-tauri/Cargo.lock` の次の crate を shotq の `Cargo.lock` と同じ版に揃えています。

| crate | 版 |
|---|---|
| zlib-rs | 0.6.8 |
| flate2 | 1.1.10 |
| png | 0.18.1 |
| qcms | 0.3.0 |
| fdeflate | 0.3.7 |
| libdeflater / libdeflate-sys | 1.26.1 |
| crc32fast | 1.5.2 |
| simd-adler32 | 0.3.10 |
| rayon / rayon-core | 1.12.0 / 1.13.0 |

## 更新の手順

1. shotq 側で変更してコミットする (ここでは直さない)
2. 上の「複製したもの」を複製し直し、`Cargo.toml` の差分を当て直す
3. `src-tauri/Cargo.lock` の依存の版を shotq の `Cargo.lock` に揃え、上の表を更新する
4. 契約テストの期待値を作り直す (`src-tauri/src/modules/pngopt/contract/README.md`)
5. この表の commit、バージョン、日付を更新する
6. `THIRD_PARTY_NOTICES.md` (リポジトリ直下) と `third_party/shotq-NOTICES.txt`、About の表記、portable ZIP のサイズ増分を確認する
