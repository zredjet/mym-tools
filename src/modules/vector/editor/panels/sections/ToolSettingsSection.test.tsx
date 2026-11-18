import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { createEmptyDocument } from "../../model/create";
import { editorStore } from "../../state/store";
import {
  DEFAULT_SHAPE_TOOL_SETTINGS,
  getShapeToolSettings,
  setShapeToolSettings,
} from "../../tools/polygonTool";
import { PropertiesPanel } from "../PropertiesPanel";

const state = () => editorStore.getState();
const field = (name: string) => screen.getByRole("textbox", { name });
const type = (input: HTMLElement, value: string) => {
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: "Enter" });
};

beforeEach(() => {
  state().load(createEmptyDocument());
});

describe("ツールの設定の節", () => {
  it("多角形・星のツールを選んでいる間だけ出す", () => {
    render(<PropertiesPanel />);
    expect(screen.queryByRole("region", { name: "ツールの設定" })).toBeNull();
    act(() => state().setTool("polygon"));
    expect(screen.getByRole("region", { name: "ツールの設定" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "星の凹み" })).toBeNull();
    act(() => state().setTool("star"));
    expect(field("星の凹み")).toBeTruthy();
    act(() => state().setTool("pencil"));
    expect(screen.queryByRole("region", { name: "ツールの設定" })).toBeNull();
  });

  it("頂点の数と凹み (%) を変える。文書と履歴は変えない", () => {
    render(<PropertiesPanel />);
    act(() => state().setTool("polygon"));
    const doc = state().doc;
    expect((field("頂点の数") as HTMLInputElement).value).toBe("3");
    type(field("頂点の数"), "8");
    expect(getShapeToolSettings().polygonSides).toBe(8);
    expect((field("頂点の数") as HTMLInputElement).value).toBe("8");

    act(() => state().setTool("star"));
    expect((field("頂点の数") as HTMLInputElement).value).toBe("5");
    expect((field("星の凹み") as HTMLInputElement).value).toBe("38.2");
    type(field("頂点の数"), "12");
    type(field("星の凹み"), "50");
    expect(getShapeToolSettings()).toEqual({ polygonSides: 8, starPoints: 12, starRatio: 0.5 });
    // 範囲外は確定しない
    type(field("頂点の数"), "61");
    type(field("星の凹み"), "0.5");
    expect(getShapeToolSettings()).toEqual({ polygonSides: 8, starPoints: 12, starRatio: 0.5 });
    expect(state().doc).toBe(doc);
    expect(state().canUndo).toBe(false);
  });

  it("エディタを開くたび (パネルを置くたび) に既定へ戻す", () => {
    setShapeToolSettings({ polygonSides: 9 });
    render(<PropertiesPanel />);
    expect(getShapeToolSettings()).toEqual(DEFAULT_SHAPE_TOOL_SETTINGS);
  });
});

describe("打ちかけの値", () => {
  it("多角形で打ちかけたままツールバーで星にしたら、多角形に確定し、星の欄は星の値を出す", () => {
    render(<PropertiesPanel />);
    act(() => state().setTool("polygon"));
    const input = field("頂点の数");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "9" } });
    act(() => state().setTool("star"));
    expect((field("頂点の数") as HTMLInputElement).value).toBe("5");
    expect(getShapeToolSettings()).toMatchObject({ polygonSides: 9, starPoints: 5 });
    fireEvent.keyDown(field("頂点の数"), { key: "Enter" });
    expect(getShapeToolSettings()).toMatchObject({ polygonSides: 9, starPoints: 5 });
  });
});
