import { describe, expect, it } from "vitest";
import { applyToPoint } from "../../geometry/matrix";
import { CANVAS_LIMITS } from "../../model/limits";
import { getNode } from "../../model/tree";
import type { PathNode, Subpath } from "../../model/types";
import {
  deletePoints,
  hitHandle,
  hitPoint,
  hitSegment,
  insertPoint,
  movePoints,
  pageGeometry,
  pageToLocalRounded,
  pageVectorToLocalRounded,
  pathWithinLimits,
  placePoints,
  pullHandles,
  round2,
  setHandle,
  setMirror,
  toggleSmooth,
  visibleHandles,
  withSubpaths,
} from "./ops";
import { corner, pathEditDocument, square } from "./testing";

const path = (doc: ReturnType<typeof pathEditDocument>, id: string) => getNode(doc, id) as PathNode;

const close = (a: { x: number; y: number }, b: { x: number; y: number }) => {
  expect(a.x).toBeCloseTo(b.x, 9);
  expect(a.y).toBeCloseTo(b.y, 9);
};

describe("座標", () => {
  it("round2 は小数第 2 位に丸め、-0 を 0 にする", () => {
    expect(round2(1.234)).toBe(1.23);
    expect(round2(-0.001)).toBe(0);
    expect(Object.is(round2(-0.001), 0)).toBe(true);
  });

  it("回転したパスのページ座標とノードの座標系を行き来する", () => {
    const doc = pathEditDocument();
    const g = pageGeometry(doc, "rot")!;
    close(g.points[0]![0]!.at, { x: 400, y: 100 });
    close(g.points[0]![1]!.at, { x: 400, y: 200 });
    close(pageToLocalRounded(g.space, { x: 400.004, y: 200.006 }), { x: 100.01, y: 0 });
    // ページの右向きは、90° 回したパスの座標系では上向き
    close(pageVectorToLocalRounded(g.space, { x: 10, y: 0 })!, { x: 0, y: -10 });
    expect(pageVectorToLocalRounded(g.space, { x: 0.001, y: 0 })).toBeNull();
  });

  it("回転した frame の中のパスも親の行列を掛ける", () => {
    const doc = pathEditDocument();
    const g = pageGeometry(doc, "inner")!;
    close(g.points[0]![0]!.at, { x: 250, y: 450 });
    close(applyToPoint(g.space.pageToLocal, { x: 250, y: 450 }), { x: 0, y: 0 });
  });
});

describe("当たり", () => {
  it("点、ハンドル、線分を画面 px の余裕で当てる", () => {
    const doc = pathEditDocument();
    const g = pageGeometry(doc, "rot")!;
    expect(hitPoint(g, { x: 403, y: 203 }, 1)).toEqual({ subpath: 0, index: 1 });
    expect(hitPoint(g, { x: 410, y: 210 }, 1)).toBeNull();
    // 倍率 2 では余裕が半分
    expect(hitPoint(g, { x: 404, y: 204 }, 2)).toBeNull();
    const seg = hitSegment(g, { x: 402, y: 150 }, 1)!;
    expect(seg).toMatchObject({ subpath: 0, segment: 0 });
    expect(seg.t).toBeCloseTo(0.5, 6);
    expect(hitSegment(g, { x: 350, y: 150 }, 1)).toBeNull();
  });

  it("出しているハンドルだけを当てる", () => {
    let doc = pathEditDocument();
    const node = path(doc, "sq");
    doc = withSubpaths(
      doc,
      "sq",
      pullHandles(node.subpaths, { subpath: 0, index: 1 }, { x: 0, y: 20 }),
    )!;
    const g = pageGeometry(doc, "sq")!;
    const handles = visibleHandles(g.node.subpaths, [{ subpath: 0, index: 1 }]);
    expect(handles).toEqual([
      { ref: { subpath: 0, index: 1 }, side: "in" },
      { ref: { subpath: 0, index: 1 }, side: "out" },
    ]);
    const outTip = g.points[0]![1]!.outTip!;
    expect(hitHandle(g, handles, outTip, 1)).toEqual({
      ref: { subpath: 0, index: 1 },
      side: "out",
    });
    expect(hitHandle(g, [], outTip, 1)).toBeNull();
  });

  it("前後の点のハンドルは、選んだ点へ向かうものだけを出す", () => {
    const smooth = (x: number, y: number) => ({
      x,
      y,
      in: { x: -5, y: 0 },
      out: { x: 5, y: 0 },
      mirror: "angle-length" as const,
    });
    const subpaths: Subpath[] = [
      { closed: false, points: [smooth(0, 0), smooth(50, 0), smooth(100, 0)] },
    ];
    expect(visibleHandles(subpaths, [{ subpath: 0, index: 0 }])).toEqual([
      { ref: { subpath: 0, index: 0 }, side: "in" },
      { ref: { subpath: 0, index: 0 }, side: "out" },
      { ref: { subpath: 0, index: 1 }, side: "in" },
    ]);
  });
});

describe("形の変更", () => {
  it("点を動かすと、動かした点だけが変わり、位置は親の座標系で丸める", () => {
    const doc = pathEditDocument();
    const node = path(doc, "sq");
    const space = pageGeometry(doc, "sq")!.space;
    const next = movePoints(
      node.subpaths,
      [{ subpath: 0, index: 2 }],
      space,
      { x: 10.333, y: -5 },
      "position",
    );
    close(next[0]!.points[2]!, { x: 110.33, y: 95 });
    expect(next[0]!.points[0]).toBe(node.subpaths[0]!.points[0]);
    expect(
      movePoints(node.subpaths, [{ subpath: 0, index: 2 }], space, { x: 0, y: 0 }, "position"),
    ).toBe(node.subpaths);
  });

  it("回転したパスの点はページの向きに動く", () => {
    const doc = pathEditDocument();
    const node = path(doc, "rot");
    const g = pageGeometry(doc, "rot")!;
    const next = movePoints(
      node.subpaths,
      [{ subpath: 0, index: 1 }],
      g.space,
      { x: 10, y: 0 },
      "position",
    );
    const moved = applyToPoint(g.space.localToPage, next[0]!.points[1]!);
    close(moved, { x: 410, y: 200 });
  });

  it("矢印 (丸めない) は、丸めていない位置の点もずれの分だけ動かす", () => {
    const doc = pathEditDocument();
    const space = pageGeometry(doc, "sq")!.space;
    const subpaths: Subpath[] = [{ closed: false, points: [corner(0.123, 0), corner(50, 50)] }];
    const next = movePoints(subpaths, [{ subpath: 0, index: 0 }], space, { x: 1, y: 0 }, "none");
    expect(next[0]!.points[0]!.x).toBeCloseTo(1.123, 9);
  });

  it("placePoints は親の座標系の位置へ置く", () => {
    const doc = pathEditDocument();
    const g = pageGeometry(doc, "rot")!;
    const next = placePoints(g.node.subpaths, [{ subpath: 0, index: 0 }], g.space, "x", 420);
    close(applyToPoint(g.space.localToPage, next[0]!.points[0]!), { x: 420, y: 100 });
  });

  it("ハンドル: angle-length は反対をそろえ、angle は長さを保ち、Alt は連動を切る", () => {
    const point = {
      x: 50,
      y: 50,
      in: { x: -10, y: 0 },
      out: { x: 20, y: 0 },
      mirror: "angle" as const,
    };
    const subpaths: Subpath[] = [{ closed: false, points: [corner(0, 0), point, corner(100, 0)] }];
    const ref = { subpath: 0, index: 1 };
    const angle = setHandle(subpaths, ref, "out", { x: 0, y: 30 }, false)[0]!.points[1]!;
    expect(angle).toMatchObject({ out: { x: 0, y: 30 }, mirror: "angle" });
    close(angle.in!, { x: 0, y: -10 });
    const lengthPoint = setHandle(
      [{ closed: false, points: [corner(0, 0), { ...point, mirror: "angle-length" }] }],
      ref,
      "in",
      { x: 3, y: 4 },
      false,
    )[0]!.points[1]!;
    expect(lengthPoint).toMatchObject({ in: { x: 3, y: 4 }, out: { x: -3, y: -4 } });
    const broken = setHandle(subpaths, ref, "out", { x: 0, y: 30 }, true)[0]!.points[1]!;
    expect(broken).toMatchObject({ in: { x: -10, y: 0 }, out: { x: 0, y: 30 }, mirror: "none" });
    const collapsed = setHandle(subpaths, ref, "out", null, false)[0]!.points[1]!;
    expect(collapsed).toMatchObject({ out: null, in: { x: -10, y: 0 }, mirror: "none" });
  });

  it("角と滑らかの切替: 前後の点から向きと長さを決める", () => {
    const subpaths: Subpath[] = [
      { closed: false, points: [corner(0, 0), corner(30, 0), corner(30, 60)] },
    ];
    const smooth = toggleSmooth(subpaths, { subpath: 0, index: 1 })[0]!.points[1]!;
    // 向きは (0,0) → (30,60)、長さは (30 + 60) / 6 = 15
    const len = Math.hypot(30, 60);
    close(smooth.out!, { x: (30 / len) * 15, y: (60 / len) * 15 });
    close(smooth.in!, { x: (-30 / len) * 15, y: (-60 / len) * 15 });
    expect(smooth.mirror).toBe("angle-length");
    // 端の点は隣の点だけから
    const end = toggleSmooth(subpaths, { subpath: 0, index: 0 })[0]!.points[0]!;
    close(end.out!, { x: 10, y: 0 });
    // 戻すと角
    const back = toggleSmooth([{ closed: false, points: [corner(0, 0), smooth] }], {
      subpath: 0,
      index: 1,
    })[0]!.points[1]!;
    expect(back).toMatchObject({ in: null, out: null, mirror: "none" });
    // 点 1 個の輪郭は何もしない
    const single: Subpath[] = [{ closed: false, points: [corner(0, 0)] }];
    expect(toggleSmooth(single, { subpath: 0, index: 0 })).toBe(single);
  });

  it("点を消して前後をつなぐ。空の輪郭は消し、1 点になった輪郭は閉じない", () => {
    const subpaths: Subpath[] = [square(), { closed: true, points: [corner(0, 0), corner(5, 5)] }];
    const next = deletePoints(subpaths, [
      { subpath: 0, index: 1 },
      { subpath: 1, index: 0 },
    ]);
    expect(next).toHaveLength(2);
    expect(next[0]).toMatchObject({ closed: true });
    expect(next[0]!.points.map((p) => [p.x, p.y])).toEqual([
      [0, 0],
      [100, 100],
      [0, 100],
    ]);
    expect(next[1]).toEqual({ closed: false, points: [corner(5, 5)] });
    expect(
      deletePoints(subpaths, [
        { subpath: 1, index: 0 },
        { subpath: 1, index: 1 },
      ]),
    ).toHaveLength(1);
  });

  it("線分に点を足す。閉じる辺に足した点は最後に入る", () => {
    const inserted = insertPoint([square()], { subpath: 0, segment: 1, t: 0.5 })!;
    expect(inserted.ref).toEqual({ subpath: 0, index: 2 });
    expect(inserted.subpaths[0]!.points[2]).toMatchObject({ x: 100, y: 50 });
    const closing = insertPoint([square()], { subpath: 0, segment: 3, t: 0.5 })!;
    expect(closing.ref).toEqual({ subpath: 0, index: 4 });
    expect(closing.subpaths[0]!.points[4]).toMatchObject({ x: 0, y: 50 });
    expect(insertPoint([square()], { subpath: 0, segment: 0, t: 0 })).toBeNull();
  });

  it("連動の種類を変えると反対のハンドルをそろえる", () => {
    const point = {
      x: 0,
      y: 0,
      in: { x: -10, y: 0 },
      out: { x: 0, y: 20 },
      mirror: "none" as const,
    };
    const ref = { subpath: 0, index: 0 };
    const sub = [{ closed: false, points: [point] }];
    expect(setMirror(sub, [ref], "angle")[0]!.points[0]).toMatchObject({
      in: { x: -10, y: 0 },
      out: { x: 20, y: 0 },
      mirror: "angle",
    });
    expect(setMirror(sub, [ref], "angle-length")[0]!.points[0]).toMatchObject({
      out: { x: 10, y: 0 },
      mirror: "angle-length",
    });
    const onlyOut = [{ closed: false, points: [{ ...point, in: null }] }];
    expect(setMirror(onlyOut, [ref], "angle-length")[0]!.points[0]).toMatchObject({
      in: { x: 0, y: -20 },
      out: { x: 0, y: 20 },
    });
    const plain = [{ closed: false, points: [corner(0, 0)] }];
    expect(setMirror(plain, [ref], "angle")[0]!.points[0]).toEqual({
      ...corner(0, 0),
      mirror: "angle",
    });
  });
});

describe("文書への反映と上限", () => {
  it("形を変えたら箱を合わせ直し、見た目の位置を保つ", () => {
    const doc = pathEditDocument();
    const node = path(doc, "sq");
    const space = pageGeometry(doc, "sq")!.space;
    const moved = movePoints(
      node.subpaths,
      [{ subpath: 0, index: 0 }],
      space,
      { x: -20, y: -10 },
      "position",
    );
    const next = withSubpaths(doc, "sq", moved)!;
    const after = path(next, "sq");
    expect(after).toMatchObject({ x: 80, y: 90, width: 120, height: 110 });
    expect(after.subpaths[0]!.points[0]).toMatchObject({ x: 0, y: 0 });
    expect(after.subpaths[0]!.points[2]).toMatchObject({ x: 120, y: 110 });
    expect(withSubpaths(doc, "sq", node.subpaths)).toBe(doc);
  });

  it("輪郭がなくなればノードごと消す", () => {
    const doc = pathEditDocument();
    const next = withSubpaths(doc, "sq", [])!;
    expect(getNode(next, "sq")).toBeUndefined();
  });

  it("座標と点の数の上限を超えるなら null", () => {
    const doc = pathEditDocument();
    const far = [
      { closed: false, points: [corner(0, 0), corner(CANVAS_LIMITS.maxCoordinate + 1, 0)] },
    ];
    expect(withSubpaths(doc, "sq", far)).toBeNull();
    const many = [
      {
        closed: false,
        points: Array.from({ length: CANVAS_LIMITS.maxPathPoints + 1 }, (_, i) =>
          corner(i % 50, 0),
        ),
      },
    ];
    expect(withSubpaths(doc, "sq", many)).toBeNull();
    const handle = [
      {
        closed: false,
        points: [
          { ...corner(0, 0), out: { x: CANVAS_LIMITS.maxCoordinate * 2, y: 0 } },
          corner(10, 10),
        ],
      },
    ];
    expect(withSubpaths(doc, "sq", handle)).toBeNull();
    expect(pathWithinLimits(doc, "sq", true)).toBe(true);
    expect(pathWithinLimits(doc, "r", true)).toBe(false);
  });
});
