import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { sampleDocument } from "../../model/testing";
import type { FrameNode } from "../../model/types";
import { FrameSection } from "../../panels/sections/FrameSection";
import { editorStore } from "../../state/store";
import { getLastFrameSize, resetLastFrameSize } from "./frameSize";

beforeEach(() => {
  resetLastFrameSize();
  editorStore.getState().load(sampleDocument());
});

describe("フレームツールのクリックの大きさ", () => {
  it("初回は iPhone、プロパティパネルでプリセットを選ぶとその大きさを覚える", () => {
    expect(getLastFrameSize()).toEqual({ width: 393, height: 852 });
    const frame = editorStore.getState().doc.nodes.f as FrameNode;
    render(<FrameSection frames={[frame]} />);
    fireEvent.change(screen.getByRole("combobox", { name: "フレームのプリセット" }), {
      target: { value: "ogp" },
    });
    expect(getLastFrameSize()).toEqual({ width: 1200, height: 630 });
    resetLastFrameSize();
    expect(getLastFrameSize()).toEqual({ width: 393, height: 852 });
  });
});
