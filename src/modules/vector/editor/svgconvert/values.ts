/**
 * SVG の属性の値の読み取り (埋め込み SVG の変換、§4.17)。純関数で、読めない値は null を返す (例外は投げない)。
 *
 * - `parseNumber` / `parseNumberList`: SVG の数値 (`1e-3`、`.5`、`-1` を受ける)
 * - `parseLength(value, context)`: 長さ。単位は px・なし・pt・pc・mm・cm・in・em・ex・%。% は向き (`x` は
 *   viewport の幅、`y` は高さ、`other` は対角線 / √2) で決める
 * - `parseColor(value)`: `#rgb` `#rgba` `#rrggbb` `#rrggbbaa`、`rgb()` `rgba()` `hsl()` `hsla()` (カンマ区切りも
 *   空白区切りも)、色の名前、`transparent`。`{ color: "#RRGGBB", alpha }`
 * - `parseOpacity(value)`: 数値か %。0〜1 に収める
 * - `parseTransformList(value)`: `matrix` `translate` `scale` `rotate` `skewX` `skewY` の並び。文法の誤りがあれば
 *   null (SVG の規則どおり、属性全体を無いものとして扱う)
 * - `parseViewBox(value)`: 4 つの数値で幅と高さが正のもの
 * - `viewBoxTransform(viewBox, width, height, preserveAspectRatio)`: viewBox から viewport への変換
 */
import { IDENTITY, type Matrix, multiply, rotate, scale, translate } from "../geometry/matrix";

// ---------------------------------------------------------------------------
// 数値
// ---------------------------------------------------------------------------

/**
 * 1 つの値 (数値・長さ・色・不透明度・viewBox) として読む文字列の長さの上限。これより長いものは読めない値として
 * 扱う (信頼しない入力の巨大な属性を、要素を展開するたびに読み直さないように)。
 */
export const MAX_SCALAR_LENGTH = 256;

// 整数部と小数部の \d が重ならない形にする (読めない長い数字の並びで、正規表現の後戻りが増えないように)
const NUMBER_SOURCE = String.raw`[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?`;
const NUMBER = new RegExp(`^${NUMBER_SOURCE}$`);

/** SVG の数値。前後の空白は許す。有限でなければ null。 */
export function parseNumber(value: string | null | undefined): number | null {
  if (value == null || value.length > MAX_SCALAR_LENGTH) return null;
  const trimmed = value.trim();
  if (!NUMBER.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

const NUMBER_STICKY = new RegExp(NUMBER_SOURCE, "y");

/**
 * 数値の並びを先頭から読む。区切りは空白か、前後に空白を置けるカンマ 1 個 (区切りのない `1-2` や `.5.5` も
 * 読む)。`complete` は文字列の終わりまで正しく読めたか (読めない文字、余分なカンマがない)。
 */
function scanNumbers(text: string): { numbers: number[]; complete: boolean } {
  const numbers: number[] = [];
  let index = 0;
  /** 区切りを読み飛ばし、カンマの数を返す */
  const separator = () => {
    let commas = 0;
    while (index < text.length) {
      const c = text[index] as string;
      if (c === ",") commas++;
      else if (!/\s/.test(c)) break;
      index++;
    }
    return commas;
  };
  if (separator() > 0) return { numbers, complete: false };
  while (index < text.length) {
    NUMBER_STICKY.lastIndex = index;
    const match = NUMBER_STICKY.exec(text);
    const n = match ? Number(match[0]) : Number.NaN;
    if (!match || !Number.isFinite(n)) return { numbers, complete: false };
    numbers.push(n);
    index += match[0].length;
    const commas = separator();
    if (commas > 1 || (commas === 1 && index >= text.length)) return { numbers, complete: false };
  }
  return { numbers, complete: true };
}

/**
 * 空白かカンマで区切った数値の並び。数値でない文字があれば、その手前までを返す (`points` の SVG の規則と
 * 同じく、読めたところまで使う)。
 */
export function parseNumberList(value: string | null | undefined): number[] {
  if (value == null) return [];
  return scanNumbers(value).numbers;
}

/**
 * 行列の計算の誤差 (1e-9 の格子から 1e-12 以内のずれ) を落とす。`-0` は 0。
 * 回転の中心のまわりの計算で `159.99999999999997` のようになった値を、元の桁に戻す。
 */
export function cleanNumber(v: number): number {
  const rounded = Math.round(v * 1e9) / 1e9;
  const result = Math.abs(v - rounded) < 1e-12 * Math.max(1, Math.abs(v)) ? rounded : v;
  return result === 0 ? 0 : result;
}

// ---------------------------------------------------------------------------
// 長さ
// ---------------------------------------------------------------------------

export interface LengthContext {
  /** % の基準になる viewport の大きさ (利用者の単位) */
  viewport: { width: number; height: number };
  /** em の基準 (px) */
  fontSize: number;
}

export type LengthAxis = "x" | "y" | "other";

const UNIT_PX: Readonly<Record<string, number>> = {
  "": 1,
  px: 1,
  pt: 4 / 3,
  pc: 16,
  mm: 96 / 25.4,
  cm: 96 / 2.54,
  in: 96,
  q: 96 / 101.6,
};

const LENGTH = new RegExp(`^(${NUMBER_SOURCE})(px|pt|pc|mm|cm|in|q|em|ex|%)?$`, "i");

/** 長さ (利用者の単位)。読めなければ null。 */
export function parseLength(
  value: string | null | undefined,
  context: LengthContext,
  axis: LengthAxis = "other",
): number | null {
  if (value == null || value.length > MAX_SCALAR_LENGTH) return null;
  const match = LENGTH.exec(value.trim());
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return null;
  const unit = (match[2] ?? "").toLowerCase();
  let result: number;
  if (unit === "%") {
    const { width, height } = context.viewport;
    const base =
      axis === "x" ? width : axis === "y" ? height : Math.hypot(width, height) / Math.SQRT2;
    result = (n / 100) * base;
  } else if (unit === "em") result = n * context.fontSize;
  else if (unit === "ex") result = n * context.fontSize * 0.5;
  else result = n * (UNIT_PX[unit] ?? 1);
  return Number.isFinite(result) ? result : null;
}

// ---------------------------------------------------------------------------
// 色
// ---------------------------------------------------------------------------

export interface ParsedColor {
  /** `#RRGGBB` (大文字) */
  color: string;
  /** 0〜1 */
  alpha: number;
}

/** CSS の色の名前 (CSS Color 4)。`rebeccapurple` を含む。 */
const NAMED_COLORS_SOURCE =
  "aliceblue:f0f8ff,antiquewhite:faebd7,aqua:00ffff,aquamarine:7fffd4,azure:f0ffff,beige:f5f5dc," +
  "bisque:ffe4c4,black:000000,blanchedalmond:ffebcd,blue:0000ff,blueviolet:8a2be2,brown:a52a2a," +
  "burlywood:deb887,cadetblue:5f9ea0,chartreuse:7fff00,chocolate:d2691e,coral:ff7f50," +
  "cornflowerblue:6495ed,cornsilk:fff8dc,crimson:dc143c,cyan:00ffff,darkblue:00008b,darkcyan:008b8b," +
  "darkgoldenrod:b8860b,darkgray:a9a9a9,darkgreen:006400,darkgrey:a9a9a9,darkkhaki:bdb76b," +
  "darkmagenta:8b008b,darkolivegreen:556b2f,darkorange:ff8c00,darkorchid:9932cc,darkred:8b0000," +
  "darksalmon:e9967a,darkseagreen:8fbc8f,darkslateblue:483d8b,darkslategray:2f4f4f," +
  "darkslategrey:2f4f4f,darkturquoise:00ced1,darkviolet:9400d3,deeppink:ff1493,deepskyblue:00bfff," +
  "dimgray:696969,dimgrey:696969,dodgerblue:1e90ff,firebrick:b22222,floralwhite:fffaf0," +
  "forestgreen:228b22,fuchsia:ff00ff,gainsboro:dcdcdc,ghostwhite:f8f8ff,gold:ffd700," +
  "goldenrod:daa520,gray:808080,green:008000,greenyellow:adff2f,grey:808080,honeydew:f0fff0," +
  "hotpink:ff69b4,indianred:cd5c5c,indigo:4b0082,ivory:fffff0,khaki:f0e68c,lavender:e6e6fa," +
  "lavenderblush:fff0f5,lawngreen:7cfc00,lemonchiffon:fffacd,lightblue:add8e6,lightcoral:f08080," +
  "lightcyan:e0ffff,lightgoldenrodyellow:fafad2,lightgray:d3d3d3,lightgreen:90ee90,lightgrey:d3d3d3," +
  "lightpink:ffb6c1,lightsalmon:ffa07a,lightseagreen:20b2aa,lightskyblue:87cefa," +
  "lightslategray:778899,lightslategrey:778899,lightsteelblue:b0c4de,lightyellow:ffffe0,lime:00ff00," +
  "limegreen:32cd32,linen:faf0e6,magenta:ff00ff,maroon:800000,mediumaquamarine:66cdaa," +
  "mediumblue:0000cd,mediumorchid:ba55d3,mediumpurple:9370db,mediumseagreen:3cb371," +
  "mediumslateblue:7b68ee,mediumspringgreen:00fa9a,mediumturquoise:48d1cc,mediumvioletred:c71585," +
  "midnightblue:191970,mintcream:f5fffa,mistyrose:ffe4e1,moccasin:ffe4b5,navajowhite:ffdead," +
  "navy:000080,oldlace:fdf5e6,olive:808000,olivedrab:6b8e23,orange:ffa500,orangered:ff4500," +
  "orchid:da70d6,palegoldenrod:eee8aa,palegreen:98fb98,paleturquoise:afeeee,palevioletred:db7093," +
  "papayawhip:ffefd5,peachpuff:ffdab9,peru:cd853f,pink:ffc0cb,plum:dda0dd,powderblue:b0e0e6," +
  "purple:800080,rebeccapurple:663399,red:ff0000,rosybrown:bc8f8f,royalblue:4169e1," +
  "saddlebrown:8b4513,salmon:fa8072,sandybrown:f4a460,seagreen:2e8b57,seashell:fff5ee," +
  "sienna:a0522d,silver:c0c0c0,skyblue:87ceeb,slateblue:6a5acd,slategray:708090,slategrey:708090," +
  "snow:fffafa,springgreen:00ff7f,steelblue:4682b4,tan:d2b48c,teal:008080,thistle:d8bfd8," +
  "tomato:ff6347,turquoise:40e0d0,violet:ee82ee,wheat:f5deb3,white:ffffff,whitesmoke:f5f5f5," +
  "yellow:ffff00,yellowgreen:9acd32";

const NAMED_COLORS: ReadonlyMap<string, string> = new Map(
  NAMED_COLORS_SOURCE.split(",").map((entry) => {
    const [name, hex] = entry.split(":") as [string, string];
    return [name, `#${hex.toUpperCase()}`];
  }),
);

const hex2 = (n: number) =>
  Math.round(Math.min(255, Math.max(0, n)))
    .toString(16)
    .toUpperCase()
    .padStart(2, "0");

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** 0〜255 の成分 (数値か %)。 */
function channel(value: string): number | null {
  const v = value.trim();
  if (v.endsWith("%")) {
    const n = parseNumber(v.slice(0, -1));
    return n === null ? null : (n / 100) * 255;
  }
  return parseNumber(v);
}

/** 不透明度の成分 (数値か %)。 */
function alphaChannel(value: string | undefined): number | null {
  if (value === undefined) return 1;
  const v = value.trim();
  if (v.endsWith("%")) {
    const n = parseNumber(v.slice(0, -1));
    return n === null ? null : clamp01(n / 100);
  }
  const n = parseNumber(v);
  return n === null ? null : clamp01(n);
}

/** `rgb(1, 2, 3)` / `rgb(1 2 3 / 50%)` の中身を成分に分ける。 */
function functionArgs(body: string): { values: string[]; alpha: string | undefined } | null {
  if (body.includes(",")) {
    const parts = body.split(",").map((part) => part.trim());
    if (parts.length !== 3 && parts.length !== 4) return null;
    return { values: parts.slice(0, 3), alpha: parts[3] };
  }
  const [main, alpha, extra] = body.split("/");
  if (main === undefined || extra !== undefined) return null;
  const values = main.trim().split(/\s+/);
  if (values.length !== 3) return null;
  return { values, alpha: alpha?.trim() };
}

function hueToRgb(p: number, q: number, t: number): number {
  let h = t;
  if (h < 0) h += 1;
  if (h > 1) h -= 1;
  if (h < 1 / 6) return p + (q - p) * 6 * h;
  if (h < 1 / 2) return q;
  if (h < 2 / 3) return p + (q - p) * (2 / 3 - h) * 6;
  return p;
}

/** CSS の色。読めなければ null (`none`、`currentColor`、`url(...)` も null。呼び出し側が先に見る)。 */
export function parseColor(value: string | null | undefined): ParsedColor | null {
  if (value == null || value.length > MAX_SCALAR_LENGTH) return null;
  const v = value.trim().toLowerCase();
  if (v === "transparent") return { color: "#000000", alpha: 0 };
  const named = NAMED_COLORS.get(v);
  if (named) return { color: named, alpha: 1 };
  if (v.startsWith("#")) {
    const hex = v.slice(1);
    if (!/^[0-9a-f]+$/.test(hex)) return null;
    if (hex.length === 3 || hex.length === 4) {
      const [r, g, b, a] = [...hex].map((c) => c + c);
      return {
        color: `#${r}${g}${b}`.toUpperCase(),
        alpha: a === undefined ? 1 : Number.parseInt(a, 16) / 255,
      };
    }
    if (hex.length === 6 || hex.length === 8)
      return {
        color: `#${hex.slice(0, 6)}`.toUpperCase(),
        alpha: hex.length === 8 ? Number.parseInt(hex.slice(6), 16) / 255 : 1,
      };
    return null;
  }
  const fn = /^(rgba?|hsla?)\(([^()]*)\)$/.exec(v);
  if (!fn) return null;
  const args = functionArgs(fn[2] as string);
  if (!args) return null;
  const alpha = alphaChannel(args.alpha);
  if (alpha === null) return null;
  if ((fn[1] as string).startsWith("rgb")) {
    const rgb = args.values.map(channel);
    if (rgb.some((c) => c === null)) return null;
    const [r, g, b] = rgb as [number, number, number];
    return { color: `#${hex2(r)}${hex2(g)}${hex2(b)}`, alpha };
  }
  const hue = parseNumber(args.values[0]?.replace(/deg$/, ""));
  const sat = args.values[1]?.endsWith("%") ? parseNumber(args.values[1].slice(0, -1)) : null;
  const light = args.values[2]?.endsWith("%") ? parseNumber(args.values[2].slice(0, -1)) : null;
  if (hue === null || sat === null || light === null) return null;
  const h = (((hue % 360) + 360) % 360) / 360;
  const s = clamp01(sat / 100);
  const l = clamp01(light / 100);
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const [r, g, b] = [h + 1 / 3, h, h - 1 / 3].map((t) => hueToRgb(p, q, t) * 255) as [
    number,
    number,
    number,
  ];
  return { color: `#${hex2(r)}${hex2(g)}${hex2(b)}`, alpha };
}

/** 不透明度 (`opacity`、`fill-opacity` など)。数値か %。0〜1 に収める。読めなければ null。 */
export function parseOpacity(value: string | null | undefined): number | null {
  if (value == null || value.length > MAX_SCALAR_LENGTH) return null;
  return alphaChannel(value.trim());
}

// ---------------------------------------------------------------------------
// transform
// ---------------------------------------------------------------------------

const TRANSFORM_ARITY: Readonly<Record<string, readonly number[]>> = {
  matrix: [6],
  translate: [1, 2],
  scale: [1, 2],
  rotate: [1, 3],
  skewx: [1],
  skewy: [1],
};

function skewXMatrix(degrees: number): Matrix {
  return { a: 1, b: 0, c: Math.tan((degrees * Math.PI) / 180), d: 1, e: 0, f: 0 };
}

function skewYMatrix(degrees: number): Matrix {
  return { a: 1, b: Math.tan((degrees * Math.PI) / 180), c: 0, d: 1, e: 0, f: 0 };
}

/**
 * `transform` 属性 (変換の並び) を 1 つの行列にする。空なら恒等。文法の誤りがあれば null
 * (SVG の規則どおり、呼び出し側は属性が無いものとして恒等を使う)。
 */
export function parseTransformList(value: string | null | undefined): Matrix | null {
  if (value == null) return IDENTITY;
  const text = value.trim();
  let index = 0;
  let result = IDENTITY;
  // 先頭から 1 つずつ読む (文字列を切り出し直さない。長い属性でも読む量が増えないように)
  const item = /([a-zA-Z]+)\s*\(([^()]*)\)\s*,?\s*/y;
  while (index < text.length) {
    item.lastIndex = index;
    const match = item.exec(text);
    if (!match) return null;
    const name = (match[1] as string).toLowerCase();
    const arity = TRANSFORM_ARITY[name];
    const args = (match[2] as string).trim();
    const { numbers, complete } = scanNumbers(args);
    if (!arity || !complete || !arity.includes(numbers.length)) return null;
    const [n0 = 0, n1, n2, n3 = 0, n4 = 0, n5 = 0] = numbers;
    let m: Matrix;
    switch (name) {
      case "matrix":
        m = { a: n0, b: n1 ?? 0, c: n2 ?? 0, d: n3, e: n4, f: n5 };
        break;
      case "translate":
        m = translate(n0, n1 ?? 0);
        break;
      case "scale":
        m = scale(n0, n1 ?? n0);
        break;
      case "rotate":
        m = rotate(n0, n1 ?? 0, n2 ?? 0);
        break;
      case "skewx":
        m = skewXMatrix(n0);
        break;
      default:
        m = skewYMatrix(n0);
    }
    result = multiply(result, m);
    index += match[0].length;
  }
  return result;
}

// ---------------------------------------------------------------------------
// viewBox
// ---------------------------------------------------------------------------

export interface ViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** `viewBox`。4 つの数値で幅と高さが正のものだけ (ほかは無いものとして扱う)。 */
export function parseViewBox(value: string | null | undefined): ViewBox | null {
  if (value == null || value.length > MAX_SCALAR_LENGTH * 4) return null;
  const numbers = parseNumberList(value);
  if (numbers.length !== 4) return null;
  const [x, y, width, height] = numbers as [number, number, number, number];
  if (!(width > 0 && height > 0)) return null;
  return { x, y, width, height };
}

/**
 * viewBox (利用者の座標) から、`width` × `height` の viewport (原点が左上) への変換。
 * `preserveAspectRatio` の既定は `xMidYMid meet`。`none` は縦横を別々に引き伸ばす。
 */
export function viewBoxTransform(
  viewBox: ViewBox,
  width: number,
  height: number,
  preserveAspectRatio: string | null,
): Matrix {
  const sx = width / viewBox.width;
  const sy = height / viewBox.height;
  const parts = (preserveAspectRatio ?? "").trim().split(/\s+/);
  const align = parts[0] === "defer" ? (parts[1] ?? "") : (parts[0] ?? "");
  const meetOrSlice = parts[0] === "defer" ? parts[2] : parts[1];
  if (align === "none") return multiply(scale(sx, sy), translate(-viewBox.x, -viewBox.y));
  const s = meetOrSlice === "slice" ? Math.max(sx, sy) : Math.min(sx, sy);
  const a = /^x(Min|Mid|Max)Y(Min|Mid|Max)$/.exec(align);
  const ax = a?.[1] ?? "Mid";
  const ay = a?.[2] ?? "Mid";
  const free = (kind: string, room: number) =>
    kind === "Min" ? 0 : kind === "Max" ? room : room / 2;
  const tx = free(ax, width - viewBox.width * s);
  const ty = free(ay, height - viewBox.height * s);
  return multiply(translate(tx, ty), multiply(scale(s, s), translate(-viewBox.x, -viewBox.y)));
}
