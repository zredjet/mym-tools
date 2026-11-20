# MyMyTools

個人用ローカルツールの集合体 — 保存系ツールと、変換・解析・生成・通信の開発ツール。

## v0.1.0-alpha.25 の主な変更

同梱の Mermaid と draw.io を新しい版に更新し、JavaScript のライブラリの脆弱性を直しました。データベースと保存データの形式は変わりません。Mermaid の図は、次に開いたときから新しい並びと見た目で描かれます (下の「更新時の注意」を読んでください)。

### 追加・変更

- **Mermaid を 12.3.0 に更新**: 図の並び方と見た目が新しくなります
  - flowchart / state / class / ER / requirement の図は、新しいレイアウト (ELK) で並び、辺は直角に曲がります
  - 図形に影が付くなど、見た目 (neo) が変わります。ひし形などの図形の大きさや、ラベルの折返しも変わります
  - PNG / SVG の書き出しも同じ見た目になります
  - 11 系にはもう修正が出ないため、12 系に移りました
- **draw.io を 32.7.4 に更新**
  - 細工した図を開くと、ダイアグラムの画面 (macOS ではアプリの画面全体) が応答しなくなる脆弱性 (GHSA-55cm-f4p8-xq88) を直しました。内蔵の HTML 無害化部品 (DOMPurify) も 3.4.18 に更新しました
  - 何も選択していないときにページを移動するキーが、Ctrl (macOS は ⌘) + Shift + ← / → に変わりました。Shift + ← / → だけではページは動きません
  - 図形の資産の持ち方が変わり、配布する ZIP が約 7.5 MB 小さくなりました (Mermaid の更新で増えた分を含みます)
- JavaScript のライブラリの脆弱性を直しました。配布物に入るものでは、Mermaid が使う DOMPurify を 3.4.18 に更新しました。ほかは開発・ビルドだけに使うものです

### 更新時の注意

- Mermaid の図は、記述を変えないまま、次に開いたときから新しい並びと見た目で描かれます。前の並びと見た目に戻したい図は、記述の先頭に次の行を足してください

  ```text
  ---
  config:
    layout: dagre
    look: classic
  ---
  ```

- 辺の ID に `[ ] ( ) { } |` を含む Mermaid の図は、構文エラーになり保存できません (まれです)。ID の文字を変えてください。ラベルの中の `</br>` は改行として扱われます
- macOS 12 / 13 では Safari を 17.4 以降に、macOS 14 では macOS を 14.4 以降に更新してください。アプリは OS の WebKit で画面を描き、Mermaid 12 はこの版の WebKit を前提にしています
- データベースと保存データの形式は変わらないため、更新時のデータの変換はありません

### 既知の制限

- キャンバスでは、テキストのアウトライン化、コンポーネント、オートレイアウトにはまだ対応していません
- キャンバスで作った作品を別の PC で開くと、その PC にフォントがなければ、別のフォントで表示されます
- Mermaid / ダイアグラム / キャンバスのアイテムは、まだ別のプロジェクトへ移動できません
- ダイアグラムで、ページのタブをドラッグして並べ替えることはできません。タブの右クリックメニューの「移動」か、何も選択していない状態での Ctrl (macOS は ⌘) + Shift + ← / → で並べ替えてください

## 含まれるportable ZIP

- **macOS**: `MyMyTools_*_macos_aarch64.zip` (Apple Silicon専用 / Intel Mac非対応)
- **Windows**: `MyMyTools_*_windows_x64.zip` (x64)

## インストール / 更新

1. このページのAssetsから自分のOSのZIPをダウンロード
2. **macOS**: ZIPを展開し、`MyMyTools.app`をApplicationsへ移動または既存版と差し替え
3. **Windows**: ZIP内の`MyMyTools.exe`と`nrbf-decoder.exe`を同じ任意フォルダへ展開し、`MyMyTools.exe`を起動または2ファイルとも既存版と差し替え

ユーザーデータはアプリ本体と別の場所に保存されるため、アプリを差し替えても維持されます。

## OS警告 / 起動エラー対処 (Phase 1はコード署名なし)

### Windows

SmartScreenの「不明な発行元」警告が表示された場合は、「詳細情報 > 実行」を選択してください。

### macOS

「MyMyToolsは壊れているため、起動できません」と表示される場合、ターミナルで以下を実行してquarantine属性を外します。

```bash
xattr -dr com.apple.quarantine /Applications/MyMyTools.app
```

実行後、通常どおり`MyMyTools.app`を起動してください。

## データの保存場所

- macOS: `~/Library/Application Support/com.zredjet.mymtools/`
- Windows: `%APPDATA%\com.zredjet.mymtools\`

バックアップは上記の`backups/`配下に保存されます。設定画面からリストアできます。

## 自動更新について

自動更新は提供しません。新版は同じReleasesページから手動でダウンロードし、アプリを差し替えてください。

## バグ報告 / フィードバック

[GitHub Issues](https://github.com/zredjet/mym-tools/issues)へお願いします。
