/**
 * DOM のイベントをツールの契約 (`tools/types.ts`) の形に直す (純関数)。
 */
import type { Point } from "../model/types";
import type { Viewport } from "../state/types";
import type { CanvasKeyEvent, CanvasPointerEvent } from "../tools/types";
import { screenToPage } from "./viewport";

/** macOS か (Cmd を mod として扱う)。それ以外は Ctrl。 */
export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    "";
  return /mac|iphone|ipad/i.test(platform) || /Mac OS X/.test(navigator.userAgent);
}

export const IS_MAC = isMacPlatform();

interface ModifierInput {
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}

/** macOS は Cmd、Windows は Ctrl。 */
export function isModPressed(
  event: Pick<ModifierInput, "metaKey" | "ctrlKey">,
  mac = IS_MAC,
): boolean {
  return mac ? event.metaKey : event.ctrlKey;
}

export interface PointerInput extends ModifierInput {
  clientX: number;
  clientY: number;
}

/**
 * ポインターのイベントを `CanvasPointerEvent` にする。
 * `origin` はキャンバス要素の左上のクライアント座標。`button` と `clickCount` は呼び出し側が決める
 * (ボタンを押していない間の移動は button 0、clickCount 0)。
 */
export function toCanvasPointerEvent(
  event: PointerInput,
  origin: Point,
  viewport: Viewport,
  button: number,
  clickCount: number,
  mac = IS_MAC,
): CanvasPointerEvent {
  const screen = { x: event.clientX - origin.x, y: event.clientY - origin.y };
  return {
    page: screenToPage(viewport, screen),
    screen,
    button,
    clickCount,
    shift: event.shiftKey,
    alt: event.altKey,
    mod: isModPressed(event, mac),
  };
}

export interface KeyInput extends ModifierInput {
  key: string;
  code: string;
  repeat: boolean;
}

export function toCanvasKeyEvent(event: KeyInput, mac = IS_MAC): CanvasKeyEvent {
  return {
    key: event.key,
    shift: event.shiftKey,
    alt: event.altKey,
    mod: isModPressed(event, mac),
    repeat: event.repeat,
  };
}

/** 文字の入力を受ける要素か (input / textarea / select / contenteditable)。ここにフォーカスがある間はショートカットを効かせない。 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== "function") return false;
  const element = target as HTMLElement;
  if (element.isContentEditable) return true;
  const tag = element.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (element as HTMLInputElement).type;
    // チェックボックスやボタンは文字を受けない
    return !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes(
      type,
    );
  }
  return element.closest("[contenteditable=''], [contenteditable='true']") !== null;
}

/** 日本語入力の変換中か。`keyCode === 229` は古い WebKit での変換中の印。 */
export function isComposing(event: { isComposing?: boolean; keyCode?: number }): boolean {
  return event.isComposing === true || event.keyCode === 229;
}

// ---------------------------------------------------------------------------
// クリックの回数
// ---------------------------------------------------------------------------

/** 続けて押したとみなす間隔 (ms) と距離 (画面 px)。 */
export const MULTI_CLICK_MS = 500;
export const MULTI_CLICK_DISTANCE = 4;

export interface ClickRecord {
  time: number;
  x: number;
  y: number;
  button: number;
  count: number;
}

/**
 * 押した回数を数える (PointerEvent の `detail` は環境によって 0 になるため自前で数える)。
 * 契約は 1 か 2 なので、ダブルクリックの次は 1 に戻る。
 */
export function nextClick(
  previous: ClickRecord | null,
  press: { time: number; x: number; y: number; button: number },
): ClickRecord {
  const continued =
    previous !== null &&
    previous.button === press.button &&
    previous.count === 1 &&
    press.time - previous.time <= MULTI_CLICK_MS &&
    Math.hypot(press.x - previous.x, press.y - previous.y) <= MULTI_CLICK_DISTANCE;
  return { ...press, count: continued ? 2 : 1 };
}
