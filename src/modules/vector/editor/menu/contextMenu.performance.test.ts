/**
 * 右クリックのメニューを開く速さ (§5.8)。使えるかを決めるのに、文書を丸ごと作り直す試しをしない。
 */
import { describe, expect, it } from "vitest";

import { createRect } from "../model/create";
import type { CanvasDocument, CanvasNode } from "../model/types";
import { EditorClipboard } from "../state/clipboard";
import { editorStore } from "../state/store";
import { contextMenuEntries } from "./contextMenuItems";

/** 目安 (ms)。CI の共有のマシンでは緩める。 */
const BUDGET_MS = process.env["CI"] ? 200 : 40;

function manyRects(count: number): { doc: CanvasDocument; ids: string[] } {
  const nodes: CanvasNode[] = [];
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = `n${i}`;
    ids.push(id);
    nodes.push(
      createRect({ id, x: (i % 100) * 30, y: Math.floor(i / 100) * 30, width: 20, height: 20 }),
    );
  }
  return {
    doc: {
      pages: [{ id: "p1", name: "ページ 1", children: ids, guides: [] }],
      nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
      assets: {},
    },
    ids,
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

function timeEntries(clipboard: EditorClipboard): number {
  const samples: number[] = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    contextMenuEntries(editorStore, clipboard);
    samples.push(performance.now() - start);
  }
  return median(samples);
}

describe("右クリックのメニューを開く速さ", () => {
  it(`矩形 8,000 個を選んでコピーした状態で、中央値 ${BUDGET_MS} ms 以内`, () => {
    const { doc, ids } = manyRects(8000);
    editorStore.getState().load(doc);
    editorStore.getState().setSelection(ids);
    const clipboard = new EditorClipboard();
    clipboard.copy(editorStore.getState().doc, ids);
    const ms = timeEntries(clipboard);
    expect(ms).toBeLessThan(BUDGET_MS);

    // 何もない所のメニュー (クリップボードは大きいまま)
    editorStore.getState().setSelection([]);
    expect(timeEntries(clipboard)).toBeLessThan(BUDGET_MS);
  }, 30_000);
});
