// SVG ポリシーのブラウザ側の判定 (キャンバスの埋め込み SVG と SVG ファイルの取込)。
// Rust (`src-tauri/src/modules/vector/validation.rs`) が同じ policy.json で同じ判定を行い、
// 抽出した検索用テキストが一致することを validation-fixtures.json で確かめる。
export const MAX_SVG_BYTES = 20 * 1024 * 1024;
export const MAX_TEXT_BYTES = 1024 * 1024;
export const MAX_PNG_SIDE = 16_384;
export const MAX_PNG_PIXELS = 16_777_216;
export const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
export const utf8Size = (value) => new TextEncoder().encode(value).length;

export function validateCss(value) {
  if (/[\\@<>]/.test(value) || value.includes("/*"))
    throw new Error("外部CSS・エスケープ・コメントは使用できません。");
  const rest = value.replace(/url\s*\(\s*(['"]?)(#[\w.:-]+)\1\s*\)/gi, "");
  if (/url\s*\(|(?:https?|file|data|javascript):|\/\//i.test(rest))
    throw new Error("外部参照は使用できません。");
}

export function validateImageData(value) {
  if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value))
    throw new Error("画像は埋め込みPNG/JPEG/WebPにしてください。");
  const [header, encoded] = value.split(",");
  const bytes = atob(encoded);
  if (btoa(bytes) !== encoded) throw new Error("画像のbase64が不正です。");
  const valid = header.includes("/png")
    ? bytes.length >= 24 && bytes.startsWith("\x89PNG\r\n\x1a\n")
    : header.includes("/jpeg")
      ? bytes.length >= 4 && bytes.startsWith("\xff\xd8\xff")
      : bytes.length >= 12 && bytes.startsWith("RIFF") && bytes.slice(8, 12) === "WEBP";
  if (!valid) throw new Error("画像の形式と内容が一致しません。");
  if (bytes.length > MAX_SVG_BYTES) throw new Error("画像は20MiB以下にしてください。");
  if (header.includes("/png")) {
    const view = new DataView(Uint8Array.from(bytes, (c) => c.charCodeAt(0)).buffer);
    const w = view.getUint32(16),
      h = view.getUint32(20);
    if (!w || !h || w > MAX_PNG_SIDE || h > MAX_PNG_SIDE || w * h > MAX_PNG_PIXELS)
      throw new Error("画像の寸法が上限を超えています。");
  }
}

/** XML 1.0 の Char か (コードポイント)。 */
const isXmlChar = (code) =>
  code === 0x9 ||
  code === 0xa ||
  code === 0xd ||
  (code >= 0x20 && code <= 0xd7ff) ||
  (code >= 0xe000 && code <= 0xfffd) ||
  (code >= 0x10000 && code <= 0x10ffff);

/**
 * SVG の文字を確かめる (Rust の `validation.rs` の `check_characters` と同じ規則)。XML 1.0 の Char にない
 * 文字は、そのまま書いたものも文字参照も拒否する。U+0085 をそのまま書いたものは、Rust の XML の読み方が
 * 改行にして抽出が合わないので拒否する (文字参照 `&#x85;` は許す)。文字参照は文字列のまま探す。
 */
export function checkCharacters(svg) {
  for (const char of svg) {
    const code = char.codePointAt(0);
    // 対になっていないサロゲートは 1 つのコード単位で来て、Char にない
    if (!isXmlChar(code) || (char.length === 1 && code >= 0xd800 && code <= 0xdfff))
      throw new Error(
        `SVGに使えない文字 (U+${code.toString(16).toUpperCase().padStart(4, "0")}) が含まれています。`,
      );
  }
  if (svg.includes("\u0085"))
    throw new Error(
      "U+0085 (NEL) をそのまま含むSVGは使用できません。文字参照 (&#x85;) で書いてください。",
    );
  for (const match of svg.matchAll(/&#(x[0-9a-fA-F]+|[0-9]+);/g)) {
    const body = match[1];
    const code = body.startsWith("x")
      ? Number.parseInt(body.slice(1), 16)
      : Number.parseInt(body, 10);
    if (!isXmlChar(code))
      throw new Error(`SVGに使えない文字の参照 (&#${body};) が含まれています。`);
  }
}

export function validateSvg(svg, policy) {
  if (typeof svg !== "string" || !svg.trim() || utf8Size(svg) > MAX_SVG_BYTES)
    throw new Error("SVGは空でなく20MiB以下にしてください。");
  checkCharacters(svg);
  if (/<!DOCTYPE|<!ENTITY|<\?(?!xml\s)/i.test(svg))
    throw new Error("DTD・実体宣言・処理命令は使用できません。");
  const encoding = svg.match(/<\?xml\s[^?]*encoding\s*=\s*['"]([^'"]+)['"]/i)?.[1];
  if (encoding && encoding.toLowerCase() !== "utf-8") throw new Error("SVGはUTF-8にしてください。");
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (
    doc.querySelector("parsererror") ||
    doc.documentElement.localName !== "svg" ||
    doc.documentElement.namespaceURI !== SVG_NS
  )
    throw new Error("SVGのXMLまたは名前空間が不正です。");
  for (const element of doc.getElementsByTagName("*")) {
    if (element.namespaceURI !== SVG_NS || !policy.elements.includes(element.localName))
      throw new Error(`未対応のSVG要素です: ${element.tagName}`);
    for (const attr of element.attributes) {
      const name = attr.localName.toLowerCase();
      const value = attr.value.trim();
      if (attr.name === "xmlns" || attr.prefix === "xmlns") continue;
      if (name.startsWith("on") || ["src", "base"].includes(name))
        throw new Error(`使用できない属性です: ${attr.name}`);
      if (name === "href") {
        if (attr.namespaceURI && attr.namespaceURI !== XLINK_NS)
          throw new Error("hrefの名前空間が不正です。");
        if (!/^#[\w.:-]+$/.test(value)) {
          if (!["image", "feImage"].includes(element.localName))
            throw new Error("外部参照は使用できません。");
          validateImageData(value);
        }
      } else if (name === "style") {
        for (const declaration of value.split(";").filter((part) => part.trim())) {
          const split = declaration.indexOf(":");
          const property = declaration.slice(0, split).trim().toLowerCase();
          if (split < 0 || !policy.cssProperties.includes(property))
            throw new Error(`未対応のCSS属性です: ${property}`);
          validateCss(declaration.slice(split + 1));
        }
      } else if (policy.cssProperties.includes(name)) validateCss(value);
    }
  }
  const parts = [];
  const walker = doc.createTreeWalker(
    doc.documentElement,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_CDATA_SECTION,
  );
  while (walker.nextNode()) {
    const node = walker.currentNode;
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      if (["text", "title", "desc"].includes(parent.localName)) {
        parts.push(node.nodeValue);
        break;
      }
    }
  }
  const text = parts.join(" ").replace(/\s+/g, " ").trim();
  if (utf8Size(text) > MAX_TEXT_BYTES) throw new Error("検索用テキストは1MiB以下にしてください。");
  return { svg, text };
}
