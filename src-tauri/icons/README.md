# アプリアイコン

元の絵は `source/` の 2 つの SVG。このフォルダの画像はすべてここから作る。

| 元 | 作るもの | 使われる所 |
|----|----------|------------|
| `source/mymytools-icon-macos.svg` (角丸と余白あり) | `icon.icns` | macOS の `.app` |
| `source/mymytools-icon-square.svg` (正方形いっぱい) | `icon.ico` / `*.png` | Windows の `.exe`、ウィンドウアイコン |

## 作り直し方

`tauri icon` は Android / iOS 用の画像も作るので、一時フォルダへ書き出してから、デスクトップで使う分だけを上書きする。

```bash
npx tauri icon src-tauri/icons/source/mymytools-icon-square.svg -o .generated/icons/square
```

```bash
npx tauri icon src-tauri/icons/source/mymytools-icon-macos.svg -o .generated/icons/macos
```

```bash
(cd src-tauri/icons && for f in *.png icon.ico; do cp "../../.generated/icons/square/$f" "$f"; done && cp ../../.generated/icons/macos/icon.icns icon.icns)
```
