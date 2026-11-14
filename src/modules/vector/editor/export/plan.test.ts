import { describe, expect, it } from "vitest";

import { renderBounds } from "../canvas/culling";
import { updateNodes } from "../model/transform";
import { deepFreeze } from "../model/testing";
import { fixedWidthMeasurer } from "../render/testing";
import { planExport, snapRectOutward } from "./plan";
import { exportDocument } from "./testing";
import type { ExportPlan } from "./types";

const measurer = fixedWidthMeasurer();

function targets(plan: ExportPlan) {
  if (!plan.ok) throw new Error(plan.reason);
  return plan.targets;
}

describe("snapRectOutward", () => {
  it("左上を切り下げ、右下を切り上げる", () => {
    expect(snapRectOutward({ x: -10.5, y: -20.25, width: 10, height: 10 })).toEqual({
      x: -11,
      y: -21,
      width: 11,
      height: 11,
    });
    expect(snapRectOutward({ x: 1, y: 2, width: 3, height: 4 })).toEqual({
      x: 1,
      y: 2,
      width: 3,
      height: 4,
    });
  });
});

describe("planExport", () => {
  it("選択がなければ、表示中のページのノードをすべて 1 ファイルにする", () => {
    const doc = deepFreeze(exportDocument());
    const plan = planExport(doc, "p1", [], measurer);
    expect(plan.kind).toBe("page");
    const [target] = targets(plan);
    expect(target?.nodeIds).toEqual(["fa", "fb", "g", "r0"]);
    expect(target?.name).toBe("ページ 1");
    // e1 の線の太さ (4) の半分だけ外へ広がる。r0 の端数は外へ丸める
    expect(target?.bounds).toEqual({ x: -11, y: -21, width: 511, height: 363 });
  });

  it("ページの名前が空なら既定の名前", () => {
    const doc = exportDocument();
    const plan = planExport(
      { ...doc, pages: [{ ...doc.pages[0]!, name: " " }] },
      "p1",
      [],
      measurer,
    );
    expect(targets(plan)[0]?.name).toBe("ページ");
  });

  it("表示中のノードがなければ理由を返す", () => {
    const doc = exportDocument();
    const hidden = updateNodes(doc, ["fa", "fb", "g", "r0"], { visible: false });
    expect(planExport(hidden, "p1", [], measurer)).toEqual({
      ok: false,
      kind: "page",
      reason: "ページに表示中のノードがありません。",
    });
  });

  it("frame だけの選択は frame ごとに 1 ファイル。範囲は frame の矩形 (ページ座標)", () => {
    const doc = exportDocument();
    const plan = planExport(doc, "p1", ["fb", "fn"], measurer);
    expect(plan.kind).toBe("frames");
    expect(targets(plan)).toEqual([
      { nodeIds: ["fn"], bounds: { x: 150, y: 70, width: 40, height: 30 }, name: "中" },
      { nodeIds: ["fb"], bounds: { x: 400, y: 50, width: 100, height: 100 }, name: "表紙" },
    ]);
  });

  it("frame の範囲は、はみ出した子や影を含めない", () => {
    const doc = updateNodes(exportDocument(), ["fa"], {
      clip: false,
      shadow: { x: 10, y: 10, blur: 20, color: "#000000", opacity: 0.5 },
    });
    const withChild = updateNodes(doc, ["ra"], { x: -50 });
    expect(targets(planExport(withChild, "p1", ["fa"], measurer))[0]?.bounds).toEqual({
      x: 100,
      y: 50,
      width: 200,
      height: 100,
    });
  });

  it("祖先も選ばれている frame は祖先だけを書き出す", () => {
    const plan = planExport(exportDocument(), "p1", ["fn", "fa"], measurer);
    expect(targets(plan).map((target) => target.nodeIds)).toEqual([["fa"]]);
  });

  it("frame でないノードを含む選択は、選択全体を 1 ファイルにする。範囲は描く範囲の和", () => {
    const doc = exportDocument();
    const plan = planExport(doc, "p1", ["e1", "fb"], measurer);
    expect(plan.kind).toBe("selection");
    const [target] = targets(plan);
    expect(target?.nodeIds).toEqual(["fb", "e1"]); // 重なり順
    expect(target?.name).toBe("選択範囲");
    const e1 = renderBounds(doc, "e1", measurer);
    expect(e1).toEqual({ x: -2, y: 298, width: 54, height: 44 });
    expect(target?.bounds).toEqual({ x: -2, y: 50, width: 502, height: 292 });
  });

  it("1 個だけの選択はそのノードの名前。名前が空なら種別の既定の名前", () => {
    const doc = exportDocument();
    expect(targets(planExport(doc, "p1", ["ra"], measurer))[0]).toEqual({
      nodeIds: ["ra"],
      bounds: { x: 110, y: 60, width: 20, height: 20 },
      name: "矩形",
    });
    const named = updateNodes(doc, ["g"], { name: "まとめ" });
    expect(targets(planExport(named, "p1", ["g"], measurer))[0]?.name).toBe("まとめ");
  });

  it("非表示のノード (祖先が非表示のものを含む) は書き出さない", () => {
    const doc = updateNodes(exportDocument(), ["fa"], { visible: false });
    expect(targets(planExport(doc, "p1", ["rn", "r0"], measurer))[0]?.nodeIds).toEqual(["r0"]);
    expect(planExport(doc, "p1", ["rn", "hid"], measurer)).toEqual({
      ok: false,
      kind: "selection",
      reason: "選択したノードはすべて非表示です。",
    });
    expect(targets(planExport(doc, "p1", ["fa", "fb"], measurer)).map((t) => t.nodeIds)).toEqual([
      ["fb"],
    ]);
  });

  it("大きさが 0 の frame は理由を返す", () => {
    const doc = updateNodes(exportDocument(), ["fb"], { width: 0 });
    expect(planExport(doc, "p1", ["fa", "fb"], measurer)).toEqual({
      ok: false,
      kind: "frames",
      reason: "フレーム「表紙」の大きさが 0 です。",
    });
  });
});
