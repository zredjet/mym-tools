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
    expect(resolvePen(doc, drawing({}))).toEqual({
      kind: "pending",
      origin: { x: 1, y: 2, out: null },
    });
    expect(resolvePen(doc, drawing({ parent: { kind: "node", id: "gone" } }))).toBeNull();
  });

  it("作ったパスが消えたら pending に戻り、続けていたパスが消えたら終える", () => {
    expect(resolvePen(doc, drawing({ pathId: "gone" }))).toMatchObject({ kind: "pending" });
    expect(resolvePen(doc, drawing({ pathId: "gone", created: null }))).toBeNull();
  });

  it("開いた輪郭なら drawing、閉じていたら終える。足す前の輪郭は pending", () => {
    expect(resolvePen(doc, drawing({ pathId: "open", created: null }))).toMatchObject({
      kind: "drawing",
      subpath: 0,
    });
    expect(resolvePen(doc, drawing({ pathId: "sq", created: null }))).toBeNull();
    expect(
      resolvePen(doc, drawing({ pathId: "sq", subpath: 1, created: "subpath" })),
    ).toMatchObject({
      kind: "pending",
    });
    expect(
      resolvePen(
        deleteNodes(doc, ["sq"]),
        drawing({ pathId: "sq", subpath: 1, created: "subpath" }),
      ),
    ).toBeNull();
  });
});
