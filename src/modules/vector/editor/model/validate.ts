/**
 * payload v2 の検証 (§3.3〜3.6)。Rust の検証と同じ規則で、契約データ `fixtures/payload-v2.json` で
 * 両者の合否をそろえる。保存の前の確認と、読み込んだ payload の確認に使う。
 *
 * model の中で DOM に依存するのはここの SVG の検証 (`validateSvg` が DOMParser を使う) だけ。
 */
import policy from "../../../../../scripts/svgedit/policy.json";
import { validateSvg } from "../../../../../scripts/svgedit/svg-policy.js";
import { totalAssetBytes, utf8Length } from "./assets";
import { hasOwn } from "./ids";
import { CANVAS_LIMITS, HEX_COLOR_PATTERN, NODE_ID_PATTERN } from "./limits";
import { computeSearchText } from "./searchText";
import type { CanvasDocument, VectorPayloadV2 } from "./types";

const L = CANVAS_LIMITS;

class Invalid extends Error {}

function fail(path: string, message: string): never {
  throw new Invalid(`${path}: ${message}`);
}

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: unknown, path: string): Obj {
  if (!isObject(value)) fail(path, "オブジェクトではありません");
  return value;
}

/** フィールドがちょうど `keys` であること (欠落も未知のフィールドも拒否)。 */
function exactKeys(obj: Obj, keys: readonly string[], path: string): void {
  for (const key of keys) if (!hasOwn(obj, key)) fail(path, `必須のフィールド ${key} がありません`);
  for (const key of Object.keys(obj))
    if (!keys.includes(key)) fail(path, `未知のフィールド ${key} があります`);
}

function num(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "有限の数値ではありません");
  return value;
}

/** min ≤ v ≤ max。`minExclusive` なら min < v。 */
function range(value: unknown, path: string, min: number, max: number, minExclusive = false) {
  const v = num(value, path);
  if (minExclusive ? v <= min : v < min)
    fail(path, `${min} ${minExclusive ? "より大きく" : "以上に"}してください`);
  if (v > max) fail(path, `${max} 以下にしてください`);
  return v;
}

const abs = (value: unknown, path: string, max: number) => range(value, path, -max, max);
const opacity = (value: unknown, path: string) => range(value, path, 0, 1);

function str(value: unknown, path: string): string {
  if (typeof value !== "string") fail(path, "文字列ではありません");
  return value;
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "真偽値ではありません");
  return value;
}

function oneOf<T extends string>(value: unknown, path: string, options: readonly T[]): T {
  if (typeof value !== "string" || !(options as readonly string[]).includes(value))
    fail(path, `${options.join(" / ")} のどれかにしてください`);
  return value as T;
}

function id(value: unknown, path: string): string {
  const s = str(value, path);
  if (!NODE_ID_PATTERN.test(s)) fail(path, "ID の書式が違います");
  return s;
}

function color(value: unknown, path: string): void {
  if (!HEX_COLOR_PATTERN.test(str(value, path))) fail(path, "色は #RRGGBB にしてください");
}

/** Unicode のコードポイント数 (§3.5)。 */
function codePoints(value: string): number {
  let n = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    // サロゲートペアの後半は数えない
    if (code < 0xdc00 || code > 0xdfff || i === 0) n++;
    else {
      const prev = value.charCodeAt(i - 1);
      if (prev < 0xd800 || prev > 0xdbff) n++;
    }
  }
  return n;
}

function maxChars(value: unknown, path: string, max: number): string {
  const s = str(value, path);
  if (codePoints(s) > max) fail(path, `${max} 文字以下にしてください`);
  return s;
}

/** Rust の `char::is_control` (一般カテゴリ Cc) と同じ集合。 */
function hasControl(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, "配列ではありません");
  return value;
}

// ---------------------------------------------------------------------------
// 塗り・線・影
// ---------------------------------------------------------------------------

function checkStops(value: unknown, path: string): void {
  const stops = array(value, path);
  if (stops.length < L.minGradientStops || stops.length > L.maxGradientStops)
    fail(path, `停止点は ${L.minGradientStops}〜${L.maxGradientStops} 個にしてください`);
  let previous = -Infinity;
  stops.forEach((item, i) => {
    const p = `${path}[${i}]`;
    const stop = object(item, p);
    exactKeys(stop, ["offset", "color", "opacity"], p);
    const offset = range(stop["offset"], `${p}.offset`, 0, 1);
    if (offset < previous) fail(`${p}.offset`, "停止点は offset の昇順にしてください");
    previous = offset;
    color(stop["color"], `${p}.color`);
    opacity(stop["opacity"], `${p}.opacity`);
  });
}

function checkGradientPoint(value: unknown, path: string): void {
  const point = object(value, path);
  exactKeys(point, ["x", "y"], path);
  abs(point["x"], `${path}.x`, 100);
  abs(point["y"], `${path}.y`, 100);
}

function checkPaint(value: unknown, path: string): void {
  if (value === null) return;
  const paint = object(value, path);
  const type = oneOf(paint["type"], `${path}.type`, ["solid", "linear", "radial"] as const);
  switch (type) {
    case "solid":
      exactKeys(paint, ["type", "color", "opacity"], path);
      color(paint["color"], `${path}.color`);
      opacity(paint["opacity"], `${path}.opacity`);
      return;
    case "linear":
      exactKeys(paint, ["type", "stops", "from", "to"], path);
      checkStops(paint["stops"], `${path}.stops`);
      checkGradientPoint(paint["from"], `${path}.from`);
      checkGradientPoint(paint["to"], `${path}.to`);
      return;
    case "radial":
      exactKeys(paint, ["type", "stops", "center", "radius"], path);
      checkStops(paint["stops"], `${path}.stops`);
      checkGradientPoint(paint["center"], `${path}.center`);
      range(paint["radius"], `${path}.radius`, 0, 100, true);
      return;
  }
}

function checkStroke(value: unknown, path: string, nullable: boolean): void {
  if (value === null && nullable) return;
  const stroke = object(value, path);
  exactKeys(stroke, ["color", "opacity", "width"], path);
  color(stroke["color"], `${path}.color`);
  opacity(stroke["opacity"], `${path}.opacity`);
  range(stroke["width"], `${path}.width`, 0, L.maxStrokeWidth, true);
}

function checkShadow(value: unknown, path: string): void {
  if (value === null) return;
  const shadow = object(value, path);
  exactKeys(shadow, ["x", "y", "blur", "color", "opacity"], path);
  abs(shadow["x"], `${path}.x`, L.maxShadowOffset);
  abs(shadow["y"], `${path}.y`, L.maxShadowOffset);
  range(shadow["blur"], `${path}.blur`, 0, L.maxShadowBlur);
  color(shadow["color"], `${path}.color`);
  opacity(shadow["opacity"], `${path}.opacity`);
}

// ---------------------------------------------------------------------------
// ノード
// ---------------------------------------------------------------------------

const COMMON = ["id", "name", "visible", "locked", "opacity", "type"] as const;
const BOX = ["x", "y", "width", "height"] as const;
const NODE_KEYS = {
  frame: [...COMMON, ...BOX, "children", "clip", "fill", "stroke", "radius", "shadow"],
  group: [...COMMON, "children"],
  rect: [...COMMON, ...BOX, "fill", "stroke", "radius", "shadow"],
  ellipse: [...COMMON, ...BOX, "fill", "stroke", "shadow"],
  line: [...COMMON, "x1", "y1", "x2", "y2", "stroke"],
  text: [
    ...COMMON,
    ...BOX,
    "text",
    "fontFamily",
    "fontSize",
    "fontWeight",
    "italic",
    "lineHeight",
    "letterSpacing",
    "align",
    "sizing",
    "fill",
    "shadow",
  ],
  image: [...COMMON, ...BOX, "assetId", "radius", "shadow"],
  svg: [...COMMON, ...BOX, "assetId"],
} as const;
type NodeTypeName = keyof typeof NODE_KEYS;
const NODE_TYPES = Object.keys(NODE_KEYS) as NodeTypeName[];

interface NodeInfo {
  type: NodeTypeName;
  children: string[] | null;
  assetId: string | null;
}

function checkNode(key: string, value: unknown): NodeInfo {
  const path = `nodes.${key}`;
  const node = object(value, path);
  const type = oneOf(node["type"], `${path}.type`, NODE_TYPES);
  exactKeys(node, NODE_KEYS[type], path);
  if (id(node["id"], `${path}.id`) !== key) fail(`${path}.id`, "nodes のキーと一致しません");
  maxChars(node["name"], `${path}.name`, L.maxNameLength);
  bool(node["visible"], `${path}.visible`);
  bool(node["locked"], `${path}.locked`);
  opacity(node["opacity"], `${path}.opacity`);

  if (type !== "group" && type !== "line") {
    abs(node["x"], `${path}.x`, L.maxCoordinate);
    abs(node["y"], `${path}.y`, L.maxCoordinate);
    range(node["width"], `${path}.width`, 0, L.maxSize);
    range(node["height"], `${path}.height`, 0, L.maxSize);
  }
  if (hasOwn(node, "radius")) range(node["radius"], `${path}.radius`, 0, L.maxRadius);
  if (hasOwn(node, "fill")) checkPaint(node["fill"], `${path}.fill`);
  if (hasOwn(node, "shadow")) checkShadow(node["shadow"], `${path}.shadow`);
  if (hasOwn(node, "stroke")) checkStroke(node["stroke"], `${path}.stroke`, type !== "line");

  let children: string[] | null = null;
  let assetId: string | null = null;
  switch (type) {
    case "frame":
    case "group": {
      children = array(node["children"], `${path}.children`).map((child, i) =>
        str(child, `${path}.children[${i}]`),
      );
      if (type === "group" && children.length === 0)
        fail(`${path}.children`, "group の子は 1 個以上にしてください");
      if (type === "frame") bool(node["clip"], `${path}.clip`);
      break;
    }
    case "line":
      for (const k of ["x1", "y1", "x2", "y2"]) abs(node[k], `${path}.${k}`, L.maxCoordinate);
      break;
    case "text": {
      maxChars(node["text"], `${path}.text`, L.maxTextLength);
      const family = maxChars(node["fontFamily"], `${path}.fontFamily`, L.maxFontFamilyLength);
      if (family.length === 0) fail(`${path}.fontFamily`, "空にはできません");
      if (hasControl(family)) fail(`${path}.fontFamily`, "制御文字を含められません");
      range(node["fontSize"], `${path}.fontSize`, L.minFontSize, L.maxFontSize);
      const weight = range(node["fontWeight"], `${path}.fontWeight`, 100, 900);
      if (weight % 100 !== 0) fail(`${path}.fontWeight`, "100 刻みにしてください");
      bool(node["italic"], `${path}.italic`);
      if (node["lineHeight"] !== null)
        range(node["lineHeight"], `${path}.lineHeight`, 0, L.maxLineHeight, true);
      abs(node["letterSpacing"], `${path}.letterSpacing`, L.maxLetterSpacing);
      oneOf(node["align"], `${path}.align`, ["left", "center", "right"] as const);
      oneOf(node["sizing"], `${path}.sizing`, ["auto-width", "auto-height", "fixed"] as const);
      break;
    }
    case "image":
    case "svg":
      assetId = id(node["assetId"], `${path}.assetId`);
      break;
    default:
      break;
  }
  return { type, children, assetId };
}

// ---------------------------------------------------------------------------
// アセット
// ---------------------------------------------------------------------------

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Rust の `base64::engine::general_purpose::STANDARD` (0.22) と同じ合否にする。
 * 標準の字母で、パディングは必須かつ正規の形、最後の文字の使わないビットは 0
 * (`QR==` や `QUJ=` は `atob` では読めるが Rust は拒否する)。
 */
function isCanonicalBase64(data: string): boolean {
  if (!BASE64.test(data)) return false;
  if (data.endsWith("=="))
    return (BASE64_ALPHABET.indexOf(data.charAt(data.length - 3)) & 0x0f) === 0;
  if (data.endsWith("="))
    return (BASE64_ALPHABET.indexOf(data.charAt(data.length - 2)) & 0x03) === 0;
  return true;
}

/** base64 の先頭 `bytes` バイトだけを復号する。 */
function decodeHead(data: string, bytes: number): Uint8Array {
  const chars = Math.min(data.length, Math.ceil(bytes / 3) * 4);
  const binary = atob(data.slice(0, chars));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function startsWith(bytes: Uint8Array, prefix: readonly number[], at = 0): boolean {
  return prefix.every((b, i) => bytes[at + i] === b);
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

function checkImageData(mime: string, data: string, path: string): void {
  if (!isCanonicalBase64(data)) fail(path, "base64 が不正です");
  const head = decodeHead(data, 24);
  if (mime === "image/png") {
    if (head.length < 24 || !startsWith(head, PNG_SIGNATURE))
      fail(path, "mime と画像の中身が一致しません");
    const view = new DataView(head.buffer);
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    if (width === 0 || height === 0 || width > L.maxImageSide || height > L.maxImageSide)
      fail(path, `PNG の 1 辺は 1〜${L.maxImageSide} px にしてください`);
    if (width * height > L.maxImagePixels)
      fail(path, `PNG の画素数は ${L.maxImagePixels} 以下にしてください`);
  } else if (mime === "image/jpeg") {
    if (head.length < 4 || !startsWith(head, [0xff, 0xd8, 0xff]))
      fail(path, "mime と画像の中身が一致しません");
  } else if (
    head.length < 12 ||
    !startsWith(head, ascii("RIFF")) ||
    !startsWith(head, ascii("WEBP"), 8)
  )
    fail(path, "mime と画像の中身が一致しません");
}

function checkAsset(key: string, value: unknown): "image" | "svg" {
  const path = `assets.${key}`;
  id(key, path);
  const asset = object(value, path);
  const kind = oneOf(asset["kind"], `${path}.kind`, ["image", "svg"] as const);
  if (kind === "image") {
    exactKeys(asset, ["kind", "mime", "data", "width", "height"], path);
    const mime = oneOf(asset["mime"], `${path}.mime`, ["image/png", "image/jpeg", "image/webp"]);
    checkImageData(mime, str(asset["data"], `${path}.data`), `${path}.data`);
  } else {
    exactKeys(asset, ["kind", "svg", "text", "width", "height"], path);
    const svg = str(asset["svg"], `${path}.svg`);
    const text = str(asset["text"], `${path}.text`);
    let extracted: string;
    try {
      extracted = validateSvg(svg, policy).text;
    } catch (error) {
      fail(
        `${path}.svg`,
        `SVG ポリシーに反します (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    if (extracted !== text) fail(`${path}.text`, "SVG から抽出した文字と一致しません");
  }
  // §3.5 に規則がないので、Rust の検証 (PR #165) と同じ 0 以上 maxSize 以下にそろえる
  range(asset["width"], `${path}.width`, 0, L.maxSize);
  range(asset["height"], `${path}.height`, 0, L.maxSize);
  return kind;
}

// ---------------------------------------------------------------------------
// 全体
// ---------------------------------------------------------------------------

function checkPayload(value: unknown): void {
  const payload = object(value, "payload");
  exactKeys(payload, ["pages", "nodes", "assets", "text"], "payload");

  // ページ
  const pages = array(payload["pages"], "pages");
  if (pages.length < 1 || pages.length > L.maxPages)
    fail("pages", `ページは 1〜${L.maxPages} 個にしてください`);
  const pageIds = new Set<string>();
  const pageChildren: { path: string; children: string[] }[] = [];
  pages.forEach((item, i) => {
    const path = `pages[${i}]`;
    const page = object(item, path);
    exactKeys(page, ["id", "name", "children", "guides"], path);
    const pageId = id(page["id"], `${path}.id`);
    if (pageIds.has(pageId)) fail(`${path}.id`, "ページ ID が重複しています");
    pageIds.add(pageId);
    maxChars(page["name"], `${path}.name`, L.maxNameLength);
    const children = array(page["children"], `${path}.children`).map((child, j) =>
      str(child, `${path}.children[${j}]`),
    );
    pageChildren.push({ path: `${path}.children`, children });
    const guides = array(page["guides"], `${path}.guides`);
    if (guides.length > L.maxGuidesPerPage)
      fail(`${path}.guides`, `ガイド線は ${L.maxGuidesPerPage} 本以下にしてください`);
    guides.forEach((g, j) => {
      const gp = `${path}.guides[${j}]`;
      const guide = object(g, gp);
      exactKeys(guide, ["axis", "position"], gp);
      oneOf(guide["axis"], `${gp}.axis`, ["x", "y"] as const);
      abs(guide["position"], `${gp}.position`, L.maxCoordinate);
    });
  });

  // ノード
  const nodes = object(payload["nodes"], "nodes");
  const nodeKeys = Object.keys(nodes);
  if (nodeKeys.length > L.maxNodes) fail("nodes", `ノードは ${L.maxNodes} 個以下にしてください`);
  const infos = new Map<string, NodeInfo>();
  for (const key of nodeKeys) infos.set(key, checkNode(key, nodes[key]));

  // 木: どのノードもちょうど 1 回、ページから届き、深さは maxDepth 以下
  const seen = new Set<string>();
  const walk = (children: string[], path: string, depth: number) => {
    children.forEach((child, i) => {
      const p = `${path}[${i}]`;
      const info = infos.get(child);
      if (!info) fail(p, `存在しないノード ${child} を指しています`);
      if (seen.has(child)) fail(p, `ノード ${child} が 2 回以上現れます`);
      seen.add(child);
      if (depth > L.maxDepth) fail(p, `深さは ${L.maxDepth} 以下にしてください`);
      if (info.children) walk(info.children, `nodes.${child}.children`, depth + 1);
    });
  };
  for (const { path, children } of pageChildren) walk(children, path, 1);
  for (const key of nodeKeys)
    if (!seen.has(key)) fail(`nodes.${key}`, "どの親からも参照されていません");

  // アセット
  const assets = object(payload["assets"], "assets");
  const kinds = new Map<string, "image" | "svg">();
  for (const key of Object.keys(assets)) kinds.set(key, checkAsset(key, assets[key]));
  const referenced = new Set<string>();
  for (const [key, info] of infos) {
    if (info.assetId === null) continue;
    const kind = kinds.get(info.assetId);
    if (!kind) fail(`nodes.${key}.assetId`, `存在しないアセット ${info.assetId} を指しています`);
    if (kind !== info.type) fail(`nodes.${key}.assetId`, `${info.type} のアセットではありません`);
    referenced.add(info.assetId);
  }
  for (const key of kinds.keys())
    if (!referenced.has(key)) fail(`assets.${key}`, "どのノードからも参照されていません");
  const doc = payload as unknown as CanvasDocument;
  if (totalAssetBytes(doc.assets) > L.payloadBytes)
    fail("assets", `アセットの合計は ${L.payloadBytes} バイト以下にしてください`);

  // 検索用テキスト
  const text = str(payload["text"], "text");
  if (utf8Length(text) > L.textBytes)
    fail("text", `検索用テキストは UTF-8 で ${L.textBytes} バイト以下にしてください`);
  if (text !== computeSearchText(doc)) fail("text", "文書から求めた検索用テキストと一致しません");
}

/**
 * payload v2 を検証し、規則に反する最初の理由 (`"nodes.rect1.opacity: 1 以下にしてください"` の形) を返す。
 * 通れば null。
 */
export function validatePayload(value: unknown): string | null {
  try {
    checkPayload(value);
    return null;
  } catch (error) {
    if (error instanceof Invalid) return error.message;
    throw error;
  }
}

/** 検証を通った payload の型ガード版。 */
export function isValidPayload(value: unknown): value is VectorPayloadV2 {
  return validatePayload(value) === null;
}
