/** 開発用の画面で読み込む文書と、検証用に window へ出す口。 */
import { getCanvasViewSize, zoomToFit } from "../canvas/viewCommands";
import { createFrame, createRect, createText, solidPaint } from "../model/create";
import { fixtureDocument, sampleDocument } from "../model/testing";
import type { CanvasDocument, CanvasNode } from "../model/types";
import { canvasTextMeasurer } from "../render/measureText";
import { editorStore } from "../state/store";

const PALETTE = [
  "#2563EB",
  "#7C3AED",
  "#DB2777",
  "#EA580C",
  "#CA8A04",
  "#16A34A",
  "#0891B2",
  "#475569",
];

/** 多数のノードを持つ文書 (描画の重さを見る)。frame `frames` 個に、矩形とテキストを `perFrame` 個ずつ。 */
export function stressDocument(frames = 40, perFrame = 50): CanvasDocument {
  const nodes: CanvasNode[] = [];
  const top: string[] = [];
  const columns = Math.ceil(Math.sqrt(frames));
  for (let f = 0; f < frames; f++) {
    const children: string[] = [];
    for (let i = 0; i < perFrame; i++) {
      const id = `r${f}_${i}`;
      const color = PALETTE[(f + i) % PALETTE.length] ?? "#2563EB";
      nodes.push(
        i % 5 === 0
          ? createText({
              id,
              x: 8 + (i % 10) * 36,
              y: 8 + Math.floor(i / 10) * 36,
              text: `T${i}`,
              fontSize: 12,
            })
          : createRect({
              id,
              x: 8 + (i % 10) * 36,
              y: 8 + Math.floor(i / 10) * 36,
              width: 28,
              height: 28,
              radius: 4,
              fill: solidPaint(color),
            }),
      );
      children.push(id);
    }
    const id = `f${f}`;
    nodes.push(
      createFrame({
        id,
        name: `フレーム ${f + 1}`,
        x: (f % columns) * 420,
        y: Math.floor(f / columns) * 260,
        width: 376,
        height: 200,
        clip: true,
        children,
      }),
    );
    top.push(id);
  }
  return {
    pages: [{ id: "page1", name: "ページ 1", children: top, guides: [{ axis: "x", position: 0 }] }],
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    assets: {},
  };
}

export const HARNESS_DOCUMENTS = {
  full: () => fixtureDocument("full"),
  empty: () => fixtureDocument("empty"),
  sample: () => sampleDocument(),
  stress: () => stressDocument(),
} as const;

export type HarnessDocumentName = keyof typeof HARNESS_DOCUMENTS;

export type Theme = "light" | "dark";

export function applyTheme(theme: Theme) {
  if (theme === "dark") document.documentElement.setAttribute("data-theme", "dark");
  else document.documentElement.removeAttribute("data-theme");
}

export function loadDocument(name: HarnessDocumentName) {
  editorStore.getState().load(HARNESS_DOCUMENTS[name]());
  const size = getCanvasViewSize();
  if (size.width > 0) zoomToFit({ store: editorStore, size, measurer: canvasTextMeasurer }, 1);
}

declare global {
  interface Window {
    __canvasHarness?: {
      store: typeof editorStore;
      load(name: HarnessDocumentName): void;
      setTheme(theme: Theme): void;
      documents: typeof HARNESS_DOCUMENTS;
    };
  }
}

/** 検証用に store を window から触れるようにする (開発用の画面の中だけで呼ぶ)。 */
export function exposeHarness() {
  window.__canvasHarness = {
    store: editorStore,
    load: loadDocument,
    setTheme: applyTheme,
    documents: HARNESS_DOCUMENTS,
  };
}

export function initialTheme(): Theme {
  const param = new URLSearchParams(window.location.search).get("theme");
  if (param === "dark" || param === "light") return param;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function initialDocument(): HarnessDocumentName {
  const param = new URLSearchParams(window.location.search).get("doc");
  return param !== null && param in HARNESS_DOCUMENTS ? (param as HarnessDocumentName) : "full";
}
