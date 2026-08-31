export type MermaidTheme = "default" | "dark";

let renderSequence = 0;
let renderQueue: Promise<void> = Promise.resolve();

/** Mermaid のグローバル設定と render queue を1箇所で直列化する。 */
export function renderMermaid(source: string, theme: MermaidTheme): Promise<string> {
  const task = renderQueue.then(async () => {
    const { default: mermaid } = await import("mermaid");
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme,
      htmlLabels: false,
      flowchart: { htmlLabels: false },
    });
    await mermaid.parse(source);
    const id = `mym-mermaid-${++renderSequence}`;
    const { svg } = await mermaid.render(id, source);
    return sanitizeRenderedSvg(svg);
  });
  renderQueue = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

/** strict mode に加え、DOMへ挿入する直前にも能動コンテンツと外部参照を除去する。 */
export function sanitizeRenderedSvg(svg: string): string {
  const document = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (document.querySelector("parsererror") != null) throw new Error("SVGの生成に失敗しました。");
  document
    .querySelectorAll("script, foreignObject, iframe, object")
    .forEach((node) => node.remove());
  document.querySelectorAll("a").forEach((anchor) => anchor.replaceWith(...anchor.childNodes));
  document.querySelectorAll("style").forEach((style) => {
    if (containsExternalCssReference(style.textContent ?? "")) style.remove();
  });
  document.querySelectorAll("*").forEach((element) => {
    for (const attribute of [...element.attributes]) {
      if (/^on/i.test(attribute.name)) element.removeAttribute(attribute.name);
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (name === "src" || (["href", "xlink:href"].includes(name) && !value.startsWith("#"))) {
        element.removeAttribute(attribute.name);
      }
      if (name === "style" && containsExternalCssReference(value)) {
        element.removeAttribute(attribute.name);
      }
    }
  });
  return new XMLSerializer().serializeToString(document.documentElement);
}

function containsExternalCssReference(value: string): boolean {
  return /@import|url\s*\(\s*["']?(?:https?:|\/\/)/i.test(value);
}

export function readableMermaidError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.split("\n")[0]?.trim() || "Mermaid記法を確認してください。";
}
