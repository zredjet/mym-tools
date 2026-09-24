// Shared browser boundary: checked before SVG enters the editor or PNG renderer.
// Rust applies the same policy on every persistent/file boundary.
export const MAX_SVG_BYTES = 20 * 1024 * 1024;
export const MAX_TEXT_BYTES = 1024 * 1024;
export const MAX_PNG_SIDE = 16_384;
export const MAX_PNG_PIXELS = 16_777_216;
export const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
export const utf8Size = (value) => new TextEncoder().encode(value).length;

export async function decodeImage(data) {
  const img = new Image();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      img.src = "";
      reject(new Error("画像の読み込みがタイムアウトしました。"));
    }, 30_000);
    img.onload = () => {
      clearTimeout(timer);
      resolve();
    };
    img.onerror = () => {
      clearTimeout(timer);
      reject(new Error("画像を読み込めません。"));
    };
    img.src = data;
  });
  return img;
}

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

export function validateSvg(svg, policy) {
  if (typeof svg !== "string" || !svg.trim() || utf8Size(svg) > MAX_SVG_BYTES)
    throw new Error("SVGは空でなく20MiB以下にしてください。");
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

export async function renderPng(svg, policy) {
  validateSvg(svg, policy);
  const root = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
  const box = root
    .getAttribute("viewBox")
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  const length = (name, fallback) => {
    const value = root.getAttribute(name);
    if (value && /^\d+(?:\.\d+)?(?:px)?$/.test(value)) return Number.parseFloat(value);
    return fallback;
  };
  const width = Math.ceil(length("width", box?.[2]));
  const height = Math.ceil(length("height", box?.[3]));
  if (
    ![width, height].every((n) => Number.isFinite(n) && n > 0 && n <= MAX_PNG_SIDE) ||
    width * height > MAX_PNG_PIXELS
  )
    throw new Error("PNGの寸法が上限を超えています。");
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const img = await decodeImage(url);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("PNG描画を初期化できません。");
    ctx.drawImage(img, 0, 0, width, height);
    const blob = await new Promise((resolve, reject) =>
      canvas.toBlob(
        (value) => (value ? resolve(value) : reject(new Error("PNG生成に失敗しました。"))),
        "image/png",
      ),
    );
    if (blob.size > MAX_SVG_BYTES) throw new Error("PNGは20MiB以下にしてください。");
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
