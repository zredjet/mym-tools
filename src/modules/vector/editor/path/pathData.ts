/**
 * SVG の path の `d` の書き出しと読み込み (`docs/canvas-editor-design.md` §4.3、§4.12、§4.17)。
 *
 * 書き出し `subpathsToPathData(subpaths, offset)`:
 * - 輪郭ごとに `M`、点と点の間は、前の点の `out` と次の点の `in` がどちらも null なら `L`、そうでなければ `C`
 *   (null の側は点そのものを制御点にする)。閉じた輪郭は最後の点から先頭の点への `L` / `C` を書いてから `Z`
 * - 点が 1 個の輪郭は書かない (描かれない、§4.3)。書く輪郭がなければ空文字
 * - 点には `offset` (箱の `x` `y`) だけを足す。回転は呼び出し側が `transform` で付ける
 * - 数値は `formatPathNumber` (小数第 4 位で丸め、末尾の 0 を落とす。`-0` は `0`)。区切りは空白 1 個
 *   (例 `M0 0 L10 0 C10 5.5 4.4 10 0 10 Z`)
 *
 * 読み込み `parsePathData(d)`:
 * - SVG 2 の path の文法をすべて受ける: `M L H V C S Q T A Z` と小文字 (相対)、命令の暗黙の繰り返し
 *   (`M` の後の組は `L`、`m` の後は `l`)、数値の詰めた書き方 (`10-5`、`.5.5`、`1e-3`、円弧のフラグの `0 01`)、
 *   空白とカンマの区切り
 * - `Q` / `T` は同じ形の 3 次ベジェに上げる (厳密)。`A` は `arcToCubics` で 3 次ベジェに近似する
 *   (誤差は半径の 2.7e-4 倍以内)。`S` / `T` の反射は、直前の命令が `C` / `S` (`Q` / `T`) のときだけ
 * - 結果は点の形 (`segmentsToSubpath` の規則。閉じた輪郭の最後の点が始点と同じなら重ねて持たない)。
 *   点が 1 個だけの輪郭 (`M` だけ、`M x y Z` など) は描かれないので落とす
 * - 誤りがあれば、SVG の規則どおり誤りの手前までに読めた命令 (組) の形と、`error` (誤りの位置 = `d` の
 *   文字の添字、種類、説明) を返す。途中までの組は使わない。例外は投げない
 *
 * 前提: 純関数。数値は JavaScript の `Number` で読む (有限でない値は誤り)。
 */
import type { Segment } from "../geometry/bezier";
import { quadraticToCubic } from "../geometry/bezier";
import type { Point, Subpath } from "../model/types";
import { arcToCubics } from "./arc";
import { segmentsToSubpath } from "./segments";

// ---------------------------------------------------------------------------
// 書き出し
// ---------------------------------------------------------------------------

/** `d` などの第 2 段階の属性の数値 (§4.3): 小数第 4 位で丸め、末尾の 0 を落とす。`-0` は `0`。 */
export function formatPathNumber(value: number): string {
  const r = Math.round(value * 1e4) / 1e4;
  return r === 0 ? "0" : String(r);
}

export function subpathsToPathData(
  subpaths: readonly Subpath[],
  offset: Point = { x: 0, y: 0 },
): string {
  const f = formatPathNumber;
  const pt = (x: number, y: number) => `${f(x + offset.x)} ${f(y + offset.y)}`;
  const parts: string[] = [];
  for (const sub of subpaths) {
    const pts = sub.points;
    if (pts.length < 2) continue;
    const first = pts[0]!;
    parts.push(`M${pt(first.x, first.y)}`);
    const n = pts.length;
    const edges = sub.closed ? n : n - 1;
    for (let i = 0; i < edges; i++) {
      const p = pts[i]!;
      const q = pts[(i + 1) % n]!;
      if (p.out === null && q.in === null) {
        parts.push(`L${pt(q.x, q.y)}`);
      } else {
        const c1 = p.out ? pt(p.x + p.out.x, p.y + p.out.y) : pt(p.x, p.y);
        const c2 = q.in ? pt(q.x + q.in.x, q.y + q.in.y) : pt(q.x, q.y);
        parts.push(`C${c1} ${c2} ${pt(q.x, q.y)}`);
      }
    }
    if (sub.closed) parts.push("Z");
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// 読み込み
// ---------------------------------------------------------------------------

export type PathDataErrorCode =
  | "expected-moveto"
  | "expected-command"
  | "expected-number"
  | "expected-flag"
  | "invalid-number";

export interface PathDataError {
  /** 誤りの位置 (`d` の文字の添字) */
  index: number;
  code: PathDataErrorCode;
  message: string;
}

export interface ParsedPathData {
  /** 誤りの手前までに読めた形 */
  subpaths: Subpath[];
  error: PathDataError | null;
}

const MESSAGES: Record<PathDataErrorCode, string> = {
  "expected-moveto": "最初の命令が M / m ではない",
  "expected-command": "命令の文字がない",
  "expected-number": "数値がない",
  "expected-flag": "円弧のフラグ (0 か 1) がない",
  "invalid-number": "数値が大きすぎる",
};

/** 命令ごとの引数の数。 */
const ARITY: Record<string, number> = {
  M: 2,
  L: 2,
  H: 1,
  V: 1,
  C: 6,
  S: 4,
  Q: 4,
  T: 2,
  A: 7,
  Z: 0,
};

class ParseError {
  constructor(
    readonly index: number,
    readonly code: PathDataErrorCode,
  ) {}
}

export function parsePathData(d: string): ParsedPathData {
  const builder = new PathBuilder();
  const reader = new Reader(d);
  let error: PathDataError | null = null;
  try {
    reader.skipWsp();
    if (reader.done()) return { subpaths: [], error: null };
    let command = "";
    let first = true;
    while (true) {
      reader.skipWsp();
      if (reader.done()) break;
      const ch = d[reader.pos]!;
      if (isCommand(ch)) {
        reader.pos++;
        command = ch;
        if (first && command !== "M" && command !== "m") {
          throw new ParseError(reader.pos - 1, "expected-moveto");
        }
        first = false;
        if (command === "Z" || command === "z") {
          builder.close();
          continue;
        }
        builder.apply(command, reader.readArgs(command));
      } else {
        // 暗黙の繰り返し: 直前の命令が引数を取り、ここが数値で始まる
        if (first) throw new ParseError(reader.pos, "expected-moveto");
        if (command === "" || command === "Z" || command === "z" || !isNumberStart(ch)) {
          throw new ParseError(reader.pos, "expected-command");
        }
        const repeated = command === "M" ? "L" : command === "m" ? "l" : command;
        builder.apply(repeated, reader.readArgs(repeated));
        command = repeated;
      }
      reader.skipArgsSeparator();
    }
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    error = { index: e.index, code: e.code, message: MESSAGES[e.code] };
  }
  return { subpaths: builder.finish(), error };
}

function isCommand(ch: string): boolean {
  return "MmLlHhVvCcSsQqTtAaZz".includes(ch);
}

function isNumberStart(ch: string): boolean {
  return (ch >= "0" && ch <= "9") || ch === "-" || ch === "+" || ch === ".";
}

function isWsp(code: number): boolean {
  // 空白、タブ、改行、復帰、改ページ (SVG 2 の wsp)
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x0c;
}

class Reader {
  pos = 0;
  constructor(private readonly s: string) {}

  done(): boolean {
    return this.pos >= this.s.length;
  }

  skipWsp(): void {
    while (this.pos < this.s.length && isWsp(this.s.charCodeAt(this.pos))) this.pos++;
  }

  /** 空白、または 1 個のカンマとその前後の空白。 */
  skipCommaWsp(): void {
    this.skipWsp();
    if (this.s[this.pos] === ",") {
      this.pos++;
      this.skipWsp();
    }
  }

  /** 組の後の区切り。カンマがあれば、その後は次の組の数値でなければならない。 */
  skipArgsSeparator(): void {
    this.skipWsp();
    if (this.s[this.pos] !== ",") return;
    this.pos++;
    this.skipWsp();
    if (this.done() || !isNumberStart(this.s[this.pos]!)) {
      throw new ParseError(this.pos, "expected-number");
    }
  }

  /** 1 組の引数。読めなければ ParseError (途中まで読んだ引数は捨てる)。 */
  readArgs(command: string): number[] {
    const upper = command.toUpperCase();
    const count = ARITY[upper]!;
    const args: number[] = [];
    for (let i = 0; i < count; i++) {
      if (i > 0) this.skipCommaWsp();
      else this.skipWsp();
      if (upper === "A" && (i === 3 || i === 4)) args.push(this.readFlag());
      else args.push(this.readNumber());
    }
    return args;
  }

  readFlag(): number {
    const ch = this.s[this.pos];
    if (ch === "0" || ch === "1") {
      this.pos++;
      return ch === "1" ? 1 : 0;
    }
    throw new ParseError(this.pos, "expected-flag");
  }

  readNumber(): number {
    const s = this.s;
    const start = this.pos;
    let i = this.pos;
    if (s[i] === "+" || s[i] === "-") i++;
    let digits = 0;
    while (i < s.length && s[i]! >= "0" && s[i]! <= "9") {
      i++;
      digits++;
    }
    if (s[i] === ".") {
      i++;
      while (i < s.length && s[i]! >= "0" && s[i]! <= "9") {
        i++;
        digits++;
      }
    }
    if (digits === 0) throw new ParseError(start, "expected-number");
    if (s[i] === "e" || s[i] === "E") {
      let j = i + 1;
      if (s[j] === "+" || s[j] === "-") j++;
      let expDigits = 0;
      while (j < s.length && s[j]! >= "0" && s[j]! <= "9") {
        j++;
        expDigits++;
      }
      // 指数の数字がなければ `e` は数値の一部ではない
      if (expDigits > 0) i = j;
    }
    const value = Number(s.slice(start, i));
    if (!Number.isFinite(value)) throw new ParseError(start, "invalid-number");
    this.pos = i;
    return value;
  }
}

interface OpenSubpath {
  start: Point;
  segments: Segment[];
}

class PathBuilder {
  private readonly done: Subpath[] = [];
  private current: OpenSubpath | null = null;
  private point: Point = { x: 0, y: 0 };
  /** 直前の命令が C / S なら 2 番目の制御点、Q / T なら 2 次の制御点 */
  private lastCubic: Point | null = null;
  private lastQuad: Point | null = null;

  apply(command: string, args: number[]): void {
    const rel = command === command.toLowerCase();
    const upper = command.toUpperCase();
    const cur = this.point;
    const abs = (x: number, y: number): Point => (rel ? { x: cur.x + x, y: cur.y + y } : { x, y });
    let lastCubic: Point | null = null;
    let lastQuad: Point | null = null;
    switch (upper) {
      case "M": {
        this.flush();
        const p = abs(args[0]!, args[1]!);
        this.current = { start: p, segments: [] };
        this.point = p;
        break;
      }
      case "L":
        this.line(abs(args[0]!, args[1]!));
        break;
      case "H":
        this.line({ x: rel ? cur.x + args[0]! : args[0]!, y: cur.y });
        break;
      case "V":
        this.line({ x: cur.x, y: rel ? cur.y + args[0]! : args[0]! });
        break;
      case "C": {
        const c1 = abs(args[0]!, args[1]!);
        const c2 = abs(args[2]!, args[3]!);
        this.cubic(c1, c2, abs(args[4]!, args[5]!));
        lastCubic = c2;
        break;
      }
      case "S": {
        const c1 = this.lastCubic
          ? { x: 2 * cur.x - this.lastCubic.x, y: 2 * cur.y - this.lastCubic.y }
          : cur;
        const c2 = abs(args[0]!, args[1]!);
        this.cubic(c1, c2, abs(args[2]!, args[3]!));
        lastCubic = c2;
        break;
      }
      case "Q": {
        const q = abs(args[0]!, args[1]!);
        this.quad(q, abs(args[2]!, args[3]!));
        lastQuad = q;
        break;
      }
      case "T": {
        const q = this.lastQuad
          ? { x: 2 * cur.x - this.lastQuad.x, y: 2 * cur.y - this.lastQuad.y }
          : cur;
        this.quad(q, abs(args[0]!, args[1]!));
        lastQuad = q;
        break;
      }
      case "A": {
        const to = abs(args[5]!, args[6]!);
        for (const seg of arcToCubics(
          cur,
          args[0]!,
          args[1]!,
          args[2]!,
          args[3] === 1,
          args[4] === 1,
          to,
        )) {
          this.push(seg);
        }
        this.point = to;
        break;
      }
    }
    this.lastCubic = lastCubic;
    this.lastQuad = lastQuad;
  }

  close(): void {
    const sub = this.ensureCurrent();
    this.finishSubpath(sub, true);
    // 閉じた後の点は輪郭の始点。続く命令が M でなければ、同じ始点から新しい輪郭を始める
    this.current = null;
    this.point = sub.start;
    this.lastCubic = null;
    this.lastQuad = null;
  }

  finish(): Subpath[] {
    this.flush();
    return this.done;
  }

  private line(to: Point): void {
    this.push({ kind: "line", from: { ...this.point }, to });
    this.point = to;
  }

  private cubic(c1: Point, c2: Point, to: Point): void {
    this.push({ kind: "cubic", from: { ...this.point }, c1: { ...c1 }, c2: { ...c2 }, to });
    this.point = to;
  }

  private quad(q: Point, to: Point): void {
    this.push(quadraticToCubic(this.point, q, to));
    this.point = to;
  }

  private push(seg: Segment): void {
    this.ensureCurrent().segments.push(seg);
  }

  private ensureCurrent(): OpenSubpath {
    if (!this.current) this.current = { start: { ...this.point }, segments: [] };
    return this.current;
  }

  private flush(): void {
    if (this.current) this.finishSubpath(this.current, false);
    this.current = null;
  }

  private finishSubpath(sub: OpenSubpath, closed: boolean): void {
    if (sub.segments.length === 0) return;
    this.done.push(segmentsToSubpath(sub.segments, closed));
  }
}
