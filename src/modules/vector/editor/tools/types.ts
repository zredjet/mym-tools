/**
 * ツールの契約 (`docs/canvas-editor-design.md` §4.4)。
 *
 * キャンバス (`canvas/CanvasView.tsx`) が DOM のイベントをここの形に直し、
 * `tools/registry.ts` から引いた現在のツールへ渡す。ツールは store だけを通して文書を変える。
 */
import type { ComponentType } from "react";
import type { StoreApi } from "zustand";
import type { Point } from "../model/types";
import type { TextMeasurer } from "../render/types";
import type { EditorStore, ToolId } from "../state/types";

export interface CanvasPointerEvent {
  /** ページ座標 */
  page: Point;
  /** キャンバス要素の左上を原点とした画面座標 (px) */
  screen: Point;
  /** 0 = 主ボタン、1 = 中ボタン、2 = 副ボタン */
  button: number;
  /** 1 = クリック、2 = ダブルクリック */
  clickCount: number;
  shift: boolean;
  alt: boolean;
  /** macOS は Cmd、Windows は Ctrl */
  mod: boolean;
}

export interface CanvasKeyEvent {
  /** `KeyboardEvent.key` */
  key: string;
  shift: boolean;
  alt: boolean;
  /** macOS は Cmd、Windows は Ctrl */
  mod: boolean;
  repeat: boolean;
}

export interface ToolContext {
  store: StoreApi<EditorStore>;
  measurer: TextMeasurer;
}

export interface Tool {
  id: ToolId;
  /** キャンバスに付ける CSS の cursor */
  cursor: string;
  onPointerDown?(event: CanvasPointerEvent, ctx: ToolContext): void;
  /** ボタンを押していない間の移動でも呼ばれる */
  onPointerMove?(event: CanvasPointerEvent, ctx: ToolContext): void;
  onPointerUp?(event: CanvasPointerEvent, ctx: ToolContext): void;
  /** 処理したら true を返す。false ならキャンバス共通のショートカットへ回る */
  onKeyDown?(event: CanvasKeyEvent, ctx: ToolContext): boolean;
  /** Esc、ツールの切替、ウィンドウからのフォーカス喪失で呼ばれる。途中の操作を捨てる */
  onCancel?(ctx: ToolContext): void;
  /**
   * 操作中の補助表示 (作成中の枠、範囲選択の矩形など)。
   * キャンバスの重ね描き用 SVG の中に、ページ座標で描く。
   */
  Overlay?: ComponentType;
}
