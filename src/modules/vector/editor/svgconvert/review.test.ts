/**
 * レビューで見つかった入力 (#193) の試験: 信頼しない SVG の仕事の量の上限と、テキストの位置、書式の検証、
 * 反転したテキスト、畳んだ group の名前。
 */
import { describe, expect, it } from "vitest";

import { applyToPoint, nodeMatrix } from "../geometry/matrix";
import type { CanvasNode, RectNode, TextNode } from "../model/types";
import { baselineOffset } from "../text/layout";
import { validateSvg } from "../../policy/svg-policy.js";
import policy from "../../policy/policy.json";
import { convertSvg, type SvgConvertResult } from "./convert";
import { convertOk, droppedCounts, measurer, svgOf } from "./testing";

const options = { width: 100, height: 100, assetWidth: 100, assetHeight: 100, measurer };

/** ポリシーを通ることを確かめてから変換し、かかった時間 (ms) を返す。 */
function timed(svg: string): { result: SvgConvertResult; ms: number } {
  validateSvg(svg, policy);
  const start = performance.now();
  const result = convertSvg(svg, options);
  return { result, ms: performance.now() - start };
}

/** `l0` を倍々に展開する `use` の連鎖 (2^levels 回)。 */
function chain(base: string, levels: number): string {
  let s = `<defs>${base}`;
  for (let i = 1; i <= levels; i++)
    s += `<g id="l${i}"><use href="#l${i - 1}"/><use href="#l${i - 1}"/></g>`;
  return `${s}</defs><use href="#l${levels}"/>`;
}

describe("信頼しない SVG の仕事の量", () => {
  it("塗りの代わりの値の連鎖 (url() を 13 万個) で再帰せず、すぐ終わる", () => {
    const fill = `${"url(#x) ".repeat(130_000)}red`;
    const { result, ms } = timed(svgOf(`<path d="M0 0H10V10Z" fill="${fill}"/>`));
    // 長すぎる・読めない値は宣言がないものとして扱う (初期値の黒)
    expect(result.ok).toBe(true);
    if (result.ok) {
      const node = Object.values(result.fragment.nodes).find((n) => n.type === "path");
      expect(node && "fill" in node ? node.fill : null).toEqual({
        type: "solid",
        color: "#000000",
        opacity: 1,
      });
    }
    expect(ms).toBeLessThan(2000);
  });

  it("代わりの値は none か色だけで、再帰しない", () => {
    const { leaves } = convertOk(
      svgOf(
        '<rect width="1" height="1" fill="url(#none) url(#none) red"/><rect width="1" height="1" fill="url(#none) #00ff00"/>',
      ),
    );
    expect(leaves.map((n) => (n as RectNode).fill)).toEqual([
      { type: "solid", color: "#000000", opacity: 1 },
      { type: "solid", color: "#00FF00", opacity: 1 },
    ]);
  });

  it("tspan 5,000 個のテキストを use で 256 回展開しても、すぐ終わるか断る", () => {
    const text = `<text id="l0" fill="none">${"<tspan>a</tspan>".repeat(5000)}</text>`;
    const { result, ms } = timed(svgOf(chain(text, 8)));
    expect(result.ok ? "ok" : result.reason).toMatch(/^(empty|tooLarge)$/);
    expect(ms).toBeLessThan(3000);
  });

  it("書式の違う use で展開して読み直しが要るテキストは、仕事の量の上限で断る", () => {
    let s = `<defs><text id="l0" y="10">${"<tspan>a</tspan>".repeat(5000)}</text>`;
    for (let i = 1; i <= 8; i++)
      s += `<g id="l${i}"><use href="#l${i - 1}" fill="#ff0000"/><use href="#l${i - 1}" fill="#00ff00"/></g>`;
    const { result, ms } = timed(svgOf(`${s}</defs><use href="#l8"/>`));
    expect(result.ok ? "ok" : result.reason).toBe("tooLarge");
    expect(ms).toBeLessThan(3000);
  });

  it("塗りも線もない長いパスは、展開しても形を読まない", () => {
    const d = `M0 0${" L1 1 L2 2".repeat(20_000)}`;
    const { result, ms } = timed(svgOf(chain(`<path id="l0" fill="none" d="${d}"/>`, 8)));
    expect(result.ok ? "ok" : result.reason).toBe("empty");
    expect(ms).toBeLessThan(1500);
  });

  it("塗りのある長いパスを展開すると、パスの点の上限で早めに断る", () => {
    const d = `M0 0${" L1 1 L2 2".repeat(20_000)}`;
    const { result, ms } = timed(svgOf(chain(`<path id="l0" d="${d}"/>`, 8)));
    expect(result.ok ? "ok" : result.reason).toBe("tooLarge");
    expect(ms).toBeLessThan(3000);
  });

  it("use の爆弾 (2^30) は上限で断る", () => {
    const { result, ms } = timed(
      svgOf(chain('<rect id="l0" width="1" height="1" fill="red"/>', 30)),
    );
    expect(result.ok ? "ok" : result.reason).toBe("tooLarge");
    expect(ms).toBeLessThan(3000);
  });

  it("深い入れ子 (g 2,000 段) はスタックを使い切らずに断る", () => {
    const svg = svgOf(`${"<g>".repeat(2000)}<rect width="10" height="10"/>${"</g>".repeat(2000)}`);
    const { result } = timed(svg);
    expect(result).toEqual({ ok: false, reason: "tooLarge", detail: null });
  });
});

describe("テキストの dx / dy", () => {
  it("x と dy で書いた複数行 (d3 や Mermaid のラベル) は行ごとに下がる", () => {
    const { leaves } = convertOk(
      svgOf(
        `<text x="10" y="20" font-size="10"><tspan x="10" dy="0">Line1</tspan><tspan x="10" dy="1.2em">Line2</tspan><tspan x="10" dy="1.2em">Line3</tspan></text>`,
      ),
    );
    const texts = leaves as TextNode[];
    expect(texts.map((t) => t.text)).toEqual(["Line1", "Line2", "Line3"]);
    texts.forEach((t, i) => {
      expect(t.x).toBeCloseTo(10, 9);
      expect(t.y + baselineOffset(t, measurer)).toBeCloseTo(20 + 12 * i, 9);
    });
  });

  it("text の dx / dy と、位置を持たない tspan の dy は次の行の位置に効く", () => {
    const { leaves } = convertOk(
      svgOf(
        `<text x="10" y="20" dx="5" dy="5" font-size="10">A<tspan dy="10">B</tspan><tspan x="10">C</tspan></text>`,
      ),
    );
    const [ab, c] = leaves as [TextNode, TextNode];
    expect(ab.text).toBe("AB");
    expect(ab.x).toBeCloseTo(15, 9);
    expect(ab.y + baselineOffset(ab, measurer)).toBeCloseTo(25, 9);
    expect(c.y + baselineOffset(c, measurer)).toBeCloseTo(35, 9);
  });
});

describe("読めない値と、反転したテキストと、名前", () => {
  it("読めない値は宣言がないものとして扱い、継承した値を使う", () => {
    const { leaves } = convertOk(
      svgOf(
        `<g fill="red"><rect width="1" height="1" fill="#ff000"/><rect width="1" height="1" style="fill:#12345"/><rect width="1" height="1" style="fill:#12345" fill="#00f"/></g>`,
      ),
    );
    expect(leaves.map((n) => (n as RectNode).fill)).toEqual([
      { type: "solid", color: "#FF0000", opacity: 1 },
      { type: "solid", color: "#FF0000", opacity: 1 },
      { type: "solid", color: "#0000FF", opacity: 1 },
    ]);
  });

  it("左右反転したテキストは正立した文字にする (回転 0)、上下反転は 180°", () => {
    const flipped = convertOk(
      svgOf('<text transform="translate(80 0) scale(-1 1)" x="10" y="20">A</text>'),
    ).leaves[0] as TextNode;
    expect(flipped.rotation).toBe(0);
    const upside = convertOk(
      svgOf('<text transform="translate(0 80) scale(1 -1)" x="10" y="20">A</text>'),
    ).leaves[0] as TextNode;
    expect(upside.rotation).toBe(180);
    // 基準点は行列で写した位置に来る
    const m = nodeMatrix(flipped.x, flipped.y, flipped.width, flipped.height, flipped.rotation);
    const anchor = applyToPoint(m, { x: 0, y: baselineOffset(flipped, measurer) });
    expect(anchor.x).toBeCloseTo(70, 9);
    expect(anchor.y).toBeCloseTo(20, 9);
  });

  it("子が 1 個で畳んだ g の title は、子に名前がなければ子に渡す", () => {
    const { leaves, dropped } = convertOk(
      svgOf(
        `<g><title>ロゴの丸</title><circle cx="50" cy="50" r="10"/></g>
         <g><title>外</title><rect width="1" height="1"><title>中</title></rect></g>`,
      ),
    );
    expect(leaves.map((n: CanvasNode) => n.name)).toEqual(["ロゴの丸", "中"]);
    expect(droppedCounts(dropped)).toEqual({});
  });
});
