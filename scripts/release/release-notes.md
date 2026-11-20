# MyMyTools

個人用ローカルツールの集合体 — 保存系ツールと、変換・解析・生成・通信の開発ツール。

## v0.1.0-alpha.26 の主な変更

ダイアグラムの SVG の書き出しの不具合を直しました。データベースと保存データの形式は変わりません。

### 修正

- **ダイアグラム**: draw.io のメニュー (ファイル > 形式を指定してエクスポート > SVG) から SVG を書き出すと、必ず失敗していたのを直しました。ツールバーの SVG ボタンからの書き出しは、これまでどおり使えます

### 更新時の注意

- データベースと保存データの形式は変わらないため、更新時のデータの変換はありません
- v0.1.0-alpha.24 以前から更新する場合は、[v0.1.0-alpha.25 のリリースノート](https://github.com/zredjet/mym-tools/releases/tag/v0.1.0-alpha.25) も読んでください。alpha.25 で Mermaid 12.3.0 と draw.io 32.7.4 に更新し、Mermaid の図の見た目が変わりました。macOS 12〜14 では Safari 17.4 相当の WebKit が要ります

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
