/**
 * 表示の操作 (ズームイン / アウト、100%、全体を表示、選択範囲を表示)。
 * ショートカット (`shortcuts.ts`) とツールバーの倍率のメニューから呼ぶ。
 *
 * キャンバスの大きさは `CanvasView` が `setCanvasViewSize` で知らせる (エディタは同時に 1 つだけ)。
 */
import type { StoreApi } from "zustand";
import { getSelectionBounds } from "../model/geometry";
import type { TextMeasurer } from "../render/types";
import type { EditorStore } from "../state/types";
import { pageContentBounds } from "./culling";
import { fitRect, stepZoom, zoomAt, type Size } from "./viewport";

let canvasViewSize: Size = { width: 0, height: 0 };

/** キャンバスの大きさ (画面 px)。`CanvasView` が大きさの変わるたびに呼ぶ。 */
export function setCanvasViewSize(size: Size): void {
  canvasViewSize = size;
}

export function getCanvasViewSize(): Size {
  return canvasViewSize;
}

export interface ViewCommandEnv {
  store: StoreApi<EditorStore>;
  size: Size;
  measurer: TextMeasurer;
}

export type ViewCommand = "zoomIn" | "zoomOut" | "zoomTo100" | "zoomToFit" | "zoomToSelection";

function center(size: Size) {
  return { x: size.width / 2, y: size.height / 2 };
}

/** 全体を表示の余白 (画面 px) */
const FIT_PADDING = 48;

/**
 * 表示中のページの内容が収まるように表示する。内容がなければ何もしない。
 * `maxZoom` を渡すと、それより大きくしない (開いたときは 100% まで)。
 */
export function zoomToFit(env: ViewCommandEnv, maxZoom?: number): boolean {
  const state = env.store.getState();
  const bounds = pageContentBounds(state.doc, state.pageId, env.measurer);
  if (!bounds || env.size.width <= 0 || env.size.height <= 0) return false;
  state.setViewport(
    fitRect(
      bounds,
      env.size,
      maxZoom === undefined ? { padding: FIT_PADDING } : { padding: FIT_PADDING, maxZoom },
    ),
  );
  return true;
}

export function runViewCommand(command: ViewCommand, env: ViewCommandEnv): void {
  const state = env.store.getState();
  const { viewport } = state;
  switch (command) {
    case "zoomIn":
      state.setViewport(zoomAt(viewport, center(env.size), stepZoom(viewport.zoom, 1)));
      return;
    case "zoomOut":
      state.setViewport(zoomAt(viewport, center(env.size), stepZoom(viewport.zoom, -1)));
      return;
    case "zoomTo100":
      state.setViewport(zoomAt(viewport, center(env.size), 1));
      return;
    case "zoomToFit":
      zoomToFit(env);
      return;
    case "zoomToSelection": {
      const bounds = getSelectionBounds(state.doc, state.selection);
      if (!bounds || env.size.width <= 0) return;
      state.setViewport(fitRect(bounds, env.size, { padding: FIT_PADDING }));
      return;
    }
  }
}
