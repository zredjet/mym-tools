// draw.io の実ブラウザ検証 (browser-smoke.mjs) が使う副作用のない補助関数。
// CSP と MIME は src-tauri/src/modules/diagram/protocol.rs を唯一の正典として読み取る。
import { Buffer } from "node:buffer";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const MAX_DIAGRAM_BYTES = 1024 * 1024;

/** 31.5.3 の resources/dia_ja.txt にある訳語。31.4.1 には orthogonalEnds が無い。 */
export const EXPECTED_JA = { save: "保存", orthogonalEnds: "直角の端点" };

/**
 * 同梱版ごとに、実行時に確かめる期待値。
 * 版を上げたら行を足し、古い行は基準の再実行のために残す。
 */
export const RUNTIME_EXPECTATIONS = {
  "31.4.1": {
    exportUrlIsNull: false,
    orthogonalEnds: false,
    atlassian2: false,
    strayCellAdopted: false,
  },
  "31.5.3": {
    exportUrlIsNull: true,
    orthogonalEnds: true,
    atlassian2: true,
    strayCellAdopted: true,
  },
};

export function runtimeExpectations(version) {
  const expectations = RUNTIME_EXPECTATIONS[version];
  if (expectations == null) {
    throw new Error(`draw.io ${version} の実行時期待値が browser-support.mjs にありません。`);
  }
  return expectations;
}

/** protocol.rs から release / debug の EDITOR_CSP と debug 用 MIME 表を取り出す。 */
export function editorAssetContract(protocolSource) {
  const csp = (cfg) => {
    const match = protocolSource.match(
      new RegExp(`#\\[cfg\\(${cfg}\\)\\]\\s*const EDITOR_CSP: &str = "([^"]+)";`),
    );
    if (match == null)
      throw new Error(`protocol.rs に #[cfg(${cfg})] の EDITOR_CSP がありません。`);
    return match[1];
  };
  const body = protocolSource.match(
    /fn content_type_for\(path: &str\) -> &'static str \{([\s\S]*?)\n\}/,
  );
  if (body == null) throw new Error("protocol.rs に content_type_for がありません。");
  const contentTypes = {};
  for (const arm of body[1].matchAll(/((?:"[a-z0-9]+"\s*\|\s*)*"[a-z0-9]+")\s*=>\s*"([^"]+)"/g)) {
    for (const extension of arm[1].matchAll(/"([a-z0-9]+)"/g)) {
      contentTypes[extension[1]] = arm[2];
    }
  }
  const fallback = body[1].match(/_\s*=>\s*"([^"]+)"/);
  if (fallback == null) throw new Error("content_type_for に既定の MIME がありません。");
  return {
    releaseCsp: csp("not\\(debug_assertions\\)"),
    debugCsp: csp("debug_assertions"),
    contentTypes,
    fallbackContentType: fallback[1],
  };
}

export function contentTypeFor(contract, path) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  return contract.contentTypes[extension] ?? contract.fallbackContentType;
}

/** protocol.rs の write_response と同じ応答ヘッダ。 */
export function editorResponseHeaders(csp, contentType) {
  return {
    "Content-Type": contentType,
    "Content-Security-Policy": csp,
    "Cache-Control": "no-store",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    Connection: "close",
  };
}

/** protocol.rs の safe_asset_path と同じ判定。不正なパスは null (応答は 400)。 */
export function safeAssetPath(uriPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(uriPath);
  } catch {
    return null;
  }
  if (decoded.startsWith("//")) return null;
  const relative = decoded.replace(/^\//, "") || "index.html";
  // Rust の Path::components と同じく、先頭の "." と ".." を含むパスを拒否する。
  const segments = relative.split("/");
  if (segments[0] === "." || segments.includes("..")) return null;
  return relative;
}

function cell(id, attributes, geometry) {
  const attrs = Object.entries(attributes)
    .map(([key, value]) => ` ${key}="${value}"`)
    .join("");
  return `<mxCell id="${id}"${attrs}>${geometry}</mxCell>`;
}

function vertex(id, value, style, parent, [x, y, width, height]) {
  return cell(
    id,
    { value, style, vertex: "1", parent },
    `<mxGeometry x="${x}" y="${y}" width="${width}" height="${height}" as="geometry"/>`,
  );
}

function edge(id, value, style, parent, source, target) {
  return cell(
    id,
    { value, style, edge: "1", parent, source, target },
    '<mxGeometry relative="1" as="geometry"/>',
  );
}

function model(cells, { math = false } = {}) {
  return (
    `<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="${math ? 1 : 0}" shadow="0">` +
    `<root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells.join("")}</root></mxGraphModel>`
  );
}

function mxfile(pages) {
  const diagrams = pages
    .map(({ id, name, xml }) => `<diagram id="${id}" name="${name}">${xml}</diagram>`)
    .join("");
  return `<mxfile host="127.0.0.1" agent="MyMyTools smoke" version="31.4.x">${diagrams}</mxfile>`;
}

/**
 * 旧版で保存した想定の 2 ページの図。1 ページ目は
 * src-tauri/src/modules/vector/fixtures/drawio-export.svg と同じ図、
 * 2 ページ目は swimlane の中と外をつなぐ edge と数式を持つ。
 */
export function smokeDiagramXml() {
  return mxfile([
    {
      id: "page-1",
      name: "フロー",
      xml: model([
        vertex(
          "2",
          "開始",
          "rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;",
          "1",
          [0, 0, 120, 60],
        ),
        vertex(
          "3",
          "処理&lt;b&gt;太字&lt;/b&gt;",
          "shape=process;whiteSpace=wrap;html=1;",
          "1",
          [200, 0, 120, 60],
        ),
        edge("4", "", "edgeStyle=none;html=1;", "1", "2", "3"),
        vertex("5", "plain", "text;html=0;align=left;verticalAlign=middle;", "1", [0, 100, 80, 30]),
      ]),
    },
    {
      id: "page-2",
      name: "コンテナ",
      xml: model(
        [
          vertex("lane", "レーン", "swimlane;whiteSpace=wrap;html=1;", "1", [0, 0, 400, 300]),
          vertex("a", "子A", "rounded=0;whiteSpace=wrap;html=1;", "lane", [40, 60, 100, 40]),
          vertex("b", "子B", "rounded=0;whiteSpace=wrap;html=1;", "lane", [240, 200, 100, 40]),
          edge("inner", "inner", "edgeStyle=orthogonalEdgeStyle;html=1;", "lane", "a", "b"),
          vertex("outside", "外部", "rounded=0;whiteSpace=wrap;html=1;", "1", [480, 120, 100, 40]),
          edge("cross", "cross", "edgeStyle=orthogonalEdgeStyle;html=1;", "1", "b", "outside"),
          vertex("math", "$$\\sqrt{x^2+1}$$", "text;html=1;", "1", [480, 20, 120, 40]),
        ],
        { math: true },
      ),
    },
  ]);
}

/** 31.5 系で追加された Atlassian 2025 の icon を 1 つ置いた図。 */
export function atlassian2DiagramXml() {
  return mxfile([
    {
      id: "atlassian2",
      name: "Atlassian",
      xml: model([
        vertex(
          "icon",
          "admin",
          "shape=mxgraph.atlassian2.icon;atlassian2Icon=mxgraph.atlassian2.admin;html=1;",
          "1",
          [40, 40, 48, 48],
        ),
      ]),
    },
  ]);
}

/** 親を持たない cell が 1 つ混ざった図。31.4.1 ではこの cell が root を奪ってページが空になる。 */
export function strayCellXml() {
  return mxfile([
    {
      id: "stray",
      name: "迷子",
      xml:
        '<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0"><root>' +
        '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
        vertex("kept", "正常セル", "rounded=0;whiteSpace=wrap;html=1;", "1", [40, 40, 120, 60]) +
        cell(
          "stray",
          { value: "迷子セル", style: "rounded=0;whiteSpace=wrap;html=1;", vertex: "1" },
          '<mxGeometry x="240" y="40" width="120" height="60" as="geometry"/>',
        ) +
        "</root></mxGraphModel>",
    },
  ]);
}

/** 1 MiB 上限付近の性能を見るための大きな図 (UTF-8 で targetBytes 以下)。 */
export function largeDiagramXml(targetBytes) {
  const cells = [];
  let size = Buffer.byteLength(mxfile([{ id: "large", name: "大きな図", xml: model([]) }]));
  for (let index = 0; ; index += 1) {
    const x = (index % 80) * 140;
    const y = Math.floor(index / 80) * 80;
    const next = [
      vertex(`n${index}`, `ノード${index}`, "rounded=0;whiteSpace=wrap;html=1;", "1", [
        x,
        y,
        120,
        40,
      ]),
    ];
    if (index % 10 === 9) {
      next.push(edge(`e${index}`, "", "edgeStyle=none;html=1;", "1", `n${index - 1}`, `n${index}`));
    }
    const added = next.reduce((total, text) => total + Buffer.byteLength(text), 0);
    if (size + added > targetBytes) break;
    cells.push(...next);
    size += added;
  }
  return mxfile([{ id: "large", name: "大きな図", xml: model(cells) }]);
}

/**
 * 保存のたびに変わる属性を除き、属性の並び順をそろえて、同じ図かどうかを比べられるようにする。
 * draw.io は同じ内容でも編集の経路によって属性を違う順で書き出す。
 */
export function normalizeDrawioFile(xml) {
  return xml
    .replace(/<mxfile\b[^>]*>/, (tag) =>
      tag.replace(/\s(?:host|agent|version|modified|etag)="[^"]*"/g, ""),
    )
    .replace(/<mxGraphModel\b[^>]*>/g, (tag) => tag.replace(/\s(?:dx|dy)="[^"]*"/g, ""))
    .replace(
      /<([A-Za-z][\w:.-]*)((?:\s+[^\s=/>]+="[^"]*")*)(\s*\/?)>/g,
      (_, name, attributes, end) =>
        `<${name}${[...attributes.matchAll(/\s+([^\s=]+)="([^"]*)"/g)]
          .map(([, key, value]) => ` ${key}="${value}"`)
          .sort()
          .join("")}${end.trim()}>`,
    );
}

/** PNG の署名と IHDR を確かめ、幅と高さを返す。 */
export function pngSize(buffer) {
  if (
    buffer.length < 24 ||
    !buffer.subarray(0, 8).equals(PNG_SIGNATURE) ||
    buffer.toString("latin1", 12, 16) !== "IHDR"
  ) {
    throw new Error("PNG ではありません。");
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}
