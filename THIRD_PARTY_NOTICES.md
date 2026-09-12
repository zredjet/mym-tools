# Third-party notices

MyMyTools includes the following third-party components in its distributed binary.

- Mermaid 11.17.2 — MIT License — <https://github.com/mermaid-js/mermaid/tree/v11.17.2>
- draw.io 31.4.1, commit `fea5e877f3e6f849331ad09894f7edb9771708fa` — Apache License 2.0 — <https://github.com/jgraph/drawio/tree/fea5e877f3e6f849331ad09894f7edb9771708fa>
- lopdf 0.44.0 — MIT License — <https://github.com/J-F-Liu/lopdf/tree/v0.44.0>
- System.Formats.Nrbf 10.0.11 / .NET NativeAOT runtime — MIT License — <https://github.com/dotnet/runtime/tree/v10.0.11>

The complete license texts are embedded in the application assets at
`licenses/mermaid-LICENSE.txt`, `licenses/drawio-LICENSE.txt`,
`licenses/lopdf-LICENSE.txt`, and `licenses/system-formats-nrbf-LICENSE.txt`.
MyMyTools does not use the official Mermaid or draw.io logos.

## SVG-Edit 7.4.2

SVG-Editおよび内包svgcanvasのES Module配布物を固定して同梱します。主なライセンスはMIT、Apache-2.0、BSD系、Zlibです。DOMPurifyはApache-2.0、rgbcolorはMITの選択肢を使用します。配布物に含まれる現行jsPDF関連ライブラリも、PDFの操作を公開しないこととは別にライセンス対象です。

- [固定上流ソース](https://github.com/SVG-Edit/svgedit/tree/v7.4.2)
- ライセンス全文と著作権表示: [svgedit-NOTICES.txt](third_party/svgedit-NOTICES.txt)
- 内包部品の監査記録: [license-audit.json](scripts/svgedit/license-audit.json)
- 実行資産から除外: 旧LGPL svgToPdfプラグイン、旧X11 jsPDF、IIFE、テスト・サンプル・source map、ブラウザ保存拡張

MyMyToolsのAboutと生成配布資産`licenses/svgedit`にも表記を含めます。Editor.js本体は上流のまま、host adapter・検証・日本語の補足資源を別ファイルとして追加しています。
