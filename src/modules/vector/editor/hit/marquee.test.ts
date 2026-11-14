import { describe, expect, it } from "vitest";
import { sampleDocument } from "../model/testing";
import { updateNode } from "../model/transform";
import {
  dropFrames,
  dropTargetAt,
  intersectRects,
  marqueeCandidates,
  marqueeSelect,
} from "./marquee";

// 座標は hitTest.test.ts の sampleDocument の説明を参照
const doc = sampleDocument();
const select = (
  rect: { x: number; y: number; width: number; height: number },
  scope: string | null = null,
  d = doc,
) => marqueeSelect(marqueeCandidates(d, "p1", scope), rect);

describe("intersectRects", () => {
  it("重なりを返し、重ならなければ null", () => {
    expect(
      intersectRects({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 }),
    ).toEqual({ x: 5, y: 5, width: 5, height: 5 });
    expect(
      intersectRects({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 0, width: 5, height: 5 }),
    ).toBeNull();
  });
});

describe("範囲選択", () => {
  it("ページ直下の frame は全体が囲まれたときだけ選ぶ", () => {
    expect(select({ x: -10, y: -10, width: 600, height: 400 })).toEqual(["f", "r0"]);
  });

  it("frame が囲まれていなければ、重なる子を選ぶ", () => {
    expect(select({ x: 105, y: 55, width: 50, height: 40 })).toEqual(["r1", "grp"]);
    expect(select({ x: -5, y: -5, width: 130, height: 70 })).toEqual(["r1", "r0"]);
  });

  it("入れ子の frame は重なれば全体を選ぶ (中の子ではなく)", () => {
    expect(select({ x: 390, y: 240, width: 50, height: 50 })).toEqual(["f2"]);
  });

  it("スコープがあればスコープの子だけ", () => {
    expect(select({ x: 0, y: 0, width: 1000, height: 1000 }, "grp")).toEqual(["r2", "l1"]);
    expect(select({ x: 300, y: 150, width: 20, height: 20 }, "f2")).toEqual(["r3"]);
  });

  it("非表示とロック中のノードは選ばない", () => {
    const hidden = updateNode(doc, "r1", { visible: false });
    expect(select({ x: 105, y: 55, width: 50, height: 40 }, null, hidden)).toEqual(["grp"]);
    const locked = updateNode(doc, "f", { locked: true });
    expect(select({ x: -10, y: -10, width: 600, height: 400 }, null, locked)).toEqual(["r0"]);
  });

  it("切り抜く frame の外にはみ出した子は、見えている部分だけで判定する", () => {
    const outside = updateNode(doc, "r1", { x: -50 }); // f の左の外 (50..70)
    expect(select({ x: 40, y: 55, width: 40, height: 40 }, null, outside)).toEqual([]);
    const noClip = updateNode(outside, "f", { clip: false });
    expect(select({ x: 40, y: 55, width: 40, height: 40 }, null, noClip)).toEqual(["r1"]);
  });
});

describe("ドロップ先", () => {
  it("点の下で最も前面の frame。なければ null", () => {
    const frames = dropFrames(doc, "p1", new Set());
    expect(frames.map((f) => f.id)).toEqual(["f", "f2"]);
    expect(dropTargetAt(frames, { x: 350, y: 200 })).toBe("f2");
    expect(dropTargetAt(frames, { x: 120, y: 70 })).toBe("f");
    expect(dropTargetAt(frames, { x: 600, y: 600 })).toBeNull();
  });

  it("動かしているノードとその中は除く", () => {
    const frames = dropFrames(doc, "p1", new Set(["f2"]));
    expect(dropTargetAt(frames, { x: 350, y: 200 })).toBe("f");
    expect(dropTargetAt(dropFrames(doc, "p1", new Set(["f"])), { x: 350, y: 200 })).toBeNull();
  });

  it("祖先の frame が切り抜く部分は除く。非表示・ロック中は除く", () => {
    const outside = updateNode(doc, "f2", { x: 380 }); // f の右へはみ出す (480..580)
    const frames = dropFrames(outside, "p1", new Set());
    expect(dropTargetAt(frames, { x: 490, y: 200 })).toBe("f2");
    expect(dropTargetAt(frames, { x: 550, y: 200 })).toBeNull();
    const locked = updateNode(doc, "f2", { locked: true });
    expect(dropTargetAt(dropFrames(locked, "p1", new Set()), { x: 350, y: 200 })).toBe("f");
  });
});
