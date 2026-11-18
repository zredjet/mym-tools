import { describe, expect, it } from "vitest";
import { deleteNodes } from "../../model/structure";
import type { PenDrawing } from "../../path/editSession";
import { constrainPoint45, constrainVector45, resolvePen } from "./pen";
import { PAGE_ID, pathEditDocument } from "./testing";

const drawing = (patch: Partial<PenDrawing>): PenDrawing => ({
  pathId: null,
  parent: { kind: "page", id: PAGE_ID },
  subpath: 0,
  end: "end",
  origin: { x: 1, y: 2, out: null },
  created: "path",
  baseCount: 0,
  subpathCount: 0,
  commits: [],
  fromEdit: false,
  pointer: null,
  ...patch,
});

describe("45° 刻み", () => {
  it("近い 45° の向きへ射影する。軸の向きは成分を 0 にそろえる", () => {
    expect(constrainVector45({ x: 10, y: 1 })).toEqual({ x: 10, y: 0 });
    expect(constrainVector45({ x: 1, y: -10 })).toEqual({ x: 0, y: -10 });
    const diagonal = constrainVector45({ x: 10, y: 8 });
    expect(diagonal.x).toBeCloseTo(9, 9);
    expect(diagonal.y).toBeCloseTo(9, 9);
    expect(constrainVector45({ x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
    expect(constrainPoint45({ x: 5, y: 5 }, { x: 15, y: 6 })).toEqual({ x: 15, y: 5 });
  });
});

describe("resolvePen", () => {
  const doc = pathEditDocument();

  it("最初の点だけなら pending。親が消えたら終える", () => {
    expect(resolvePen(doc, drawing({}), null)).toEqual({
      kind: "pending",
      origin: { x: 1, y: 2, out: null },
    });
    expect(resolvePen(doc, drawing({ parent: { kind: "node", id: "gone" } }), null)).toBeNull();
  });

  it("作ったパスが消えたら pending (ID は残すので、戻ればまた drawing)。続けていたパスが消えたら終える", () => {
    expect(resolvePen(doc, drawing({ pathId: "gone" }), null)).toMatchObject({ kind: "pending" });
    expect(resolvePen(doc, drawing({ pathId: "open" }), null)).toMatchObject({ kind: "drawing" });
    expect(resolvePen(doc, drawing({ pathId: "gone", created: null }), null)).toBeNull();
  });

  it("開いた輪郭なら drawing、閉じていたら終える。足す前の輪郭は pending", () => {
    const continued = { pathId: "open", created: null, subpathCount: 1, baseCount: 3 } as const;
    expect(resolvePen(doc, drawing(continued), null)).toMatchObject({
      kind: "drawing",
      subpath: 0,
    });
    expect(
      resolvePen(doc, drawing({ pathId: "sq", created: null, subpathCount: 1 }), null),
    ).toBeNull();
    const added = { pathId: "sq", subpath: 1, created: "subpath", subpathCount: 1 } as const;
    expect(resolvePen(doc, drawing(added), null)).toMatchObject({ kind: "pending" });
    expect(resolvePen(deleteNodes(doc, ["sq"]), drawing(added), null)).toBeNull();
  });

  it("点の編集の中から描いていたのに、編集が終わったかほかのパスに移ったら終える", () => {
    const fromEdit = {
      pathId: "open",
      created: null,
      subpathCount: 1,
      baseCount: 3,
      fromEdit: true,
    } as const;
    expect(resolvePen(doc, drawing(fromEdit), "open")).toMatchObject({ kind: "drawing" });
    expect(resolvePen(doc, drawing(fromEdit), null)).toBeNull();
    expect(resolvePen(doc, drawing(fromEdit), "sq")).toBeNull();
  });

  it("輪郭の数が描き始めと合わない、続けた輪郭の点が描き始めより減ったら終える (添字がほかの輪郭を指しうる)", () => {
    const base = { pathId: "open", created: null, baseCount: 3 } as const;
    expect(resolvePen(doc, drawing({ ...base, subpathCount: 2 }), null)).toBeNull();
    expect(resolvePen(doc, drawing({ ...base, subpathCount: 1, baseCount: 4 }), null)).toBeNull();
    // 足した輪郭: 輪郭の数が描き始め + 1 のときだけ drawing
    const added = { pathId: "open", subpath: 1, created: "subpath" } as const;
    expect(resolvePen(doc, drawing({ ...added, subpathCount: 1 }), null)).toMatchObject({
      kind: "pending",
    });
    expect(resolvePen(doc, drawing({ ...added, subpathCount: 0 }), null)).toBeNull();
  });
});
