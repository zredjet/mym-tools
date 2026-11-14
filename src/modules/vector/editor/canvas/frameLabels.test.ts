import { describe, expect, it } from "vitest";
import { createFrame } from "../model/create";
import { sampleDocument } from "../model/testing";
import type { CanvasDocument } from "../model/types";
import { fixedWidthMeasurer } from "../render/testing";
import {
  FRAME_LABEL_GAP,
  FRAME_LABEL_HEIGHT,
  frameLabel,
  frameLabelRect,
  labeledFrames,
  truncateLabel,
} from "./frameLabels";

// ラベルは 11 px なので 1 文字 5.5 画面 px
const measurer = fixedWidthMeasurer(0.5);

function withFrame(name: string, width = 400): CanvasDocument {
  const doc = sampleDocument();
  return { ...doc, nodes: { ...doc.nodes, f: { ...doc.nodes["f"]!, name, width } as never } };
}

describe("frame のラベル", () => {
  it("frame の左上の外側に、倍率に関係なく同じ画面上の大きさで置く", () => {
    const doc = withFrame("ABCD");
    // f は (100, 50)。4 文字 × 5.5 = 22 画面 px
    expect(frameLabelRect(doc, "f", 1, measurer)).toEqual({
      x: 100,
      y: 50 - FRAME_LABEL_HEIGHT - FRAME_LABEL_GAP,
      width: 22,
      height: FRAME_LABEL_HEIGHT,
    });
    expect(frameLabelRect(doc, "f", 2, measurer)).toEqual({
      x: 100,
      y: 50 - (FRAME_LABEL_HEIGHT + FRAME_LABEL_GAP) / 2,
      width: 11,
      height: FRAME_LABEL_HEIGHT / 2,
    });
  });

  it("frame の画面上の幅を超える名前は「…」で切る", () => {
    const doc = withFrame("ABCDEFGHIJ", 30);
    const label = frameLabel(doc, "f", 1, measurer);
    expect(label?.text).toBe("ABCD…");
    expect(label?.rect.width).toBe(27.5);
  });

  it("名前が空なら種別の既定の名前", () => {
    expect(frameLabel(withFrame(" "), "f", 1, measurer)?.text).toBe("フレーム");
  });

  it("ページ直下の表示中の frame だけ", () => {
    const doc = sampleDocument();
    expect(frameLabelRect(doc, "f2", 1, measurer)).toBeNull(); // 入れ子の frame
    expect(frameLabelRect(doc, "r0", 1, measurer)).toBeNull();
    const hidden = {
      ...doc,
      nodes: { ...doc.nodes, f: createFrame({ ...doc.nodes["f"]!, visible: false } as never) },
    };
    expect(frameLabelRect(hidden, "f", 1, measurer)).toBeNull();
    expect(labeledFrames(doc, "p1").map((frame) => frame.id)).toEqual(["f"]);
    expect(labeledFrames(hidden, "p1")).toEqual([]);
  });

  it("truncateLabel: 1 文字も入らなければ空", () => {
    expect(truncateLabel("ABC", 5, measurer)).toBe("");
    expect(truncateLabel("ABC", 100, measurer)).toBe("ABC");
  });
});
