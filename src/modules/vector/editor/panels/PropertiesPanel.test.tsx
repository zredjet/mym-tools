import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createText } from "../model/create";
import { deleteNodes, insertNode } from "../model/structure";
import { sampleDocument } from "../model/testing";
import { updateNodes } from "../model/transform";
import { getNode } from "../model/tree";
import type { CanvasNode, LinearGradientPaint } from "../model/types";
import { editorStore } from "../state/store";
import { DEFAULT_VIEW_OPTIONS } from "../state/types";
import { COLOR_PICK_SETTLE_MS } from "./fields/ColorField";
import { PropertiesPanel } from "./PropertiesPanel";

const state = () => editorStore.getState();
const node = (id: string) => getNode(state().doc, id) as CanvasNode & Record<string, unknown>;
const section = (name: string) => screen.getByRole("region", { name });
const sectionNames = () =>
  screen.queryAllByRole("region").map((el) => el.getAttribute("aria-label"));
const select = (...ids: string[]) => act(() => state().setSelection(ids));
const field = (name: string) => screen.getByRole("textbox", { name });
const type = (input: HTMLElement, value: string, key = "Enter") => {
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key });
};

beforeEach(() => {
  const doc = sampleDocument();
  state().load(
    insertNode(doc, createText({ id: "t1", text: "見出し", x: 5, y: 5 }), {
      kind: "page",
      id: "p1",
    }),
  );
  state().setView({ ...DEFAULT_VIEW_OPTIONS });
});

describe("節の出し分け", () => {
  it("何も選んでいなければページの設定 (履歴に積まない)", () => {
    render(<PropertiesPanel />);
    expect(sectionNames()).toEqual(["ページ"]);
    fireEvent.click(screen.getByRole("checkbox", { name: "グリッド" }));
    expect(state().view.grid).toBe(true);
    type(field("グリッドの間隔"), "16");
    expect(state().view.gridSize).toBe(16);
    type(field("グリッドの間隔"), "0");
    expect(state().view.gridSize).toBe(16);
    fireEvent.click(screen.getByRole("checkbox", { name: "グリッドにスナップ" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "ルーラー" }));
    expect(state().view).toMatchObject({ snapToGrid: true, rulers: false });
    expect(state().revision).toBe(0);
  });

  it("矩形は種別に合う節を出す。ページ直下の 1 個は整列を出さない", () => {
    render(<PropertiesPanel />);
    select("r0");
    expect(sectionNames()).toEqual(["位置と大きさ", "見た目", "塗り", "線", "影"]);
    expect(within(section("見た目")).getByRole("textbox", { name: "角丸" })).toBeInTheDocument();
  });

  it("frame の中の 1 個なら整列を出す。frame はフレームの節を出す", () => {
    render(<PropertiesPanel />);
    select("r1");
    expect(sectionNames()[0]).toBe("整列");
    select("f");
    expect(sectionNames()).toContain("フレーム");
  });

  it("線は始点と終点を出し、塗りと影と「線なし」を出さない", () => {
    render(<PropertiesPanel />);
    select("l1"); // frame f の中 (group grp の子) なので整列も出る
    expect(sectionNames()).toEqual(["整列", "位置と大きさ", "見た目", "線"]);
    expect(field("始点の X 座標")).toHaveValue("40");
    expect(within(section("線")).queryByRole("button", { name: "線なし" })).toBeNull();
    expect(within(section("見た目")).queryByRole("textbox", { name: "角丸" })).toBeNull();
  });

  it("group は外接矩形と不透明度だけ", () => {
    render(<PropertiesPanel />);
    select("grp");
    expect(sectionNames()).toEqual(["整列", "位置と大きさ", "見た目"]);
    expect(field("X 座標")).toHaveValue("40");
    expect(field("幅")).toHaveValue("40");
  });

  it("テキストは塗りと影を出す (文字の節は仮置き)", () => {
    render(<PropertiesPanel />);
    select("t1");
    expect(sectionNames()).toEqual(["位置と大きさ", "見た目", "塗り", "影"]);
  });
});

describe("数値の入力欄", () => {
  it("入力中は文書を変えず、Enter で確定する (履歴 1 件)", () => {
    render(<PropertiesPanel />);
    select("r1");
    const x = field("X 座標");
    fireEvent.focus(x);
    fireEvent.change(x, { target: { value: "33" } });
    expect(node("r1").x).toBe(10);
    fireEvent.keyDown(x, { key: "Enter" });
    expect(node("r1").x).toBe(33);
    expect(state().revision).toBe(1);
  });

  it("フォーカスが外れたら確定し、Esc なら取り消す", () => {
    render(<PropertiesPanel />);
    select("r1");
    const y = field("Y 座標");
    type(y, "40", "Escape");
    expect(y).toHaveValue("10");
    expect(node("r1").y).toBe(10);
    fireEvent.focus(y);
    fireEvent.change(y, { target: { value: "41" } });
    fireEvent.blur(y);
    expect(node("r1").y).toBe(41);
  });

  it("範囲外と数値でない入力は元に戻す。小数は整数に丸める", () => {
    render(<PropertiesPanel />);
    select("r1");
    const w = field("幅");
    type(w, "-5");
    expect(w).toHaveValue("20");
    type(w, "abc");
    expect(w).toHaveValue("20");
    type(w, "200001");
    expect(node("r1").width).toBe(20);
    type(w, "24.6");
    expect(node("r1").width).toBe(25);
    expect(state().revision).toBe(1);
  });

  it("上下の矢印で ±1、Shift と一緒なら ±10", () => {
    render(<PropertiesPanel />);
    select("r1");
    const x = field("X 座標");
    fireEvent.keyDown(x, { key: "ArrowUp" });
    expect(node("r1").x).toBe(11);
    fireEvent.keyDown(x, { key: "ArrowDown", shiftKey: true });
    expect(node("r1").x).toBe(1);
  });

  it("値の違う欄は「混在」と出し、入力するとすべてに当てる", () => {
    render(<PropertiesPanel />);
    select("r1", "r3");
    const x = field("X 座標");
    expect(x).toHaveValue("");
    expect(x).toHaveAttribute("placeholder", "混在");
    expect(field("幅")).toHaveValue(""); // 20 と 10
    type(x, "5");
    expect(node("r1").x).toBe(5);
    expect(node("r3").x).toBe(5);
    expect(state().revision).toBe(1);
    act(() => state().undo());
    expect(node("r1").x).toBe(10);
    expect(node("r3").x).toBe(5);
  });

  it("不透明度は % で入れる", () => {
    render(<PropertiesPanel />);
    select("r0");
    const opacity = field("不透明度");
    expect(opacity).toHaveValue("100");
    type(opacity, "50");
    expect(node("r0").opacity).toBe(0.5);
    type(opacity, "101");
    expect(node("r0").opacity).toBe(0.5);
  });
});

describe("塗り", () => {
  it("種類を切り替え、停止点を足して消す", () => {
    render(<PropertiesPanel />);
    select("r0");
    const fill = section("塗り");
    fireEvent.click(within(fill).getByRole("button", { name: "線形" }));
    const paint = () => node("r0").fill as LinearGradientPaint;
    expect(paint().type).toBe("linear");
    expect(paint().stops).toHaveLength(2);
    expect(within(fill).getByRole("button", { name: "停止点 1 を削除" })).toBeDisabled();

    fireEvent.click(within(fill).getByRole("button", { name: "停止点を追加" }));
    expect(paint().stops.map((s) => s.offset)).toEqual([0, 0.5, 1]);

    type(within(fill).getByRole("textbox", { name: "停止点 2 の色" }), "00ff00");
    expect(paint().stops[1]?.color).toBe("#00FF00");
    type(within(fill).getByRole("textbox", { name: "停止点 2 の位置" }), "90");
    expect(paint().stops.map((s) => s.offset)).toEqual([0, 0.9, 1]);

    fireEvent.click(within(fill).getByRole("button", { name: "停止点 2 を削除" }));
    expect(paint().stops).toHaveLength(2);

    type(within(fill).getByRole("textbox", { name: "グラデーションの向き" }), "90");
    expect(paint().from).toEqual({ x: 0.5, y: 0 });

    fireEvent.click(within(fill).getByRole("button", { name: "円形" }));
    expect(node("r0").fill).toMatchObject({ type: "radial", radius: 0.5 });
    fireEvent.click(within(fill).getByRole("button", { name: "なし" }));
    expect(node("r0").fill).toBeNull();
  });

  it("単色の色は文字で入れられ、読めない色は元に戻す", () => {
    render(<PropertiesPanel />);
    select("r0");
    const color = field("塗りの色");
    expect(color).toHaveValue("#D9D9D9");
    type(color, "#12345");
    expect(color).toHaveValue("#D9D9D9");
    type(color, "#abc");
    expect(node("r0").fill).toEqual({ type: "solid", color: "#AABBCC", opacity: 1 });
  });

  it("塗りが違えば混在と出し、種類の切替はそれぞれに当てる", () => {
    act(() =>
      state().apply((doc) =>
        updateNodes(doc, ["r1"], { fill: { type: "solid", color: "#FF0000", opacity: 1 } }),
      ),
    );
    render(<PropertiesPanel />);
    select("r0", "r1");
    expect(field("塗りの色")).toHaveAttribute("placeholder", "混在");
    type(field("塗りの不透明度"), "40");
    expect(node("r0").fill).toMatchObject({ color: "#D9D9D9", opacity: 0.4 });
    expect(node("r1").fill).toMatchObject({ color: "#FF0000", opacity: 0.4 });
    fireEvent.click(within(section("塗り")).getByRole("button", { name: "線形" }));
    expect((node("r1").fill as LinearGradientPaint).stops[0]?.color).toBe("#FF0000");
  });
});

describe("線と影", () => {
  it("線を足し、線のノードを除いて線なしにする", () => {
    render(<PropertiesPanel />);
    select("r1", "l1");
    const stroke = section("線");
    fireEvent.click(within(stroke).getByRole("button", { name: "線を追加" }));
    expect(node("r1").stroke).toEqual({ color: "#000000", opacity: 1, width: 1 });
    type(within(stroke).getByRole("textbox", { name: "線の太さ" }), "3");
    expect(node("r1").stroke).toMatchObject({ width: 3 });
    expect(node("l1").stroke).toMatchObject({ width: 3 });
    type(within(stroke).getByRole("textbox", { name: "線の太さ" }), "0");
    expect(node("r1").stroke).toMatchObject({ width: 3 });
    fireEvent.click(within(stroke).getByRole("button", { name: "線なし" }));
    expect(node("r1").stroke).toBeNull();
    expect(node("l1").stroke).toMatchObject({ width: 3 });
  });

  it("影を入にすると既定の影、欄は影のあるノードに当てる", () => {
    render(<PropertiesPanel />);
    select("r0");
    fireEvent.click(screen.getByRole("checkbox", { name: "ドロップシャドウ" }));
    expect(node("r0").shadow).toEqual({ x: 0, y: 4, blur: 8, color: "#000000", opacity: 0.25 });
    type(field("影のぼかし"), "12");
    expect(node("r0").shadow).toMatchObject({ blur: 12 });
    fireEvent.click(screen.getByRole("checkbox", { name: "ドロップシャドウ" }));
    expect(node("r0").shadow).toBeNull();
  });
});

describe("整列", () => {
  it("frame の中の 1 個は整列だけ、3 個以上で等間隔も有効", () => {
    render(<PropertiesPanel />);
    select("r1");
    const align = section("整列");
    expect(within(align).getByRole("button", { name: "左揃え" })).toBeEnabled();
    expect(within(align).getByRole("button", { name: "横に等間隔" })).toBeDisabled();
    fireEvent.click(within(align).getByRole("button", { name: "右揃え" }));
    expect(node("r1").x).toBe(380); // frame の幅 400 - 20
    select("r1", "grp", "f2");
    expect(within(section("整列")).getByRole("button", { name: "縦に等間隔" })).toBeEnabled();
  });

  it("祖先と子孫だけを選んだときは整列できない", () => {
    render(<PropertiesPanel />);
    select("r0", "r0");
    expect(screen.queryByRole("region", { name: "整列" })).toBeNull();
    select("f", "r1");
    // 2 個選んでいるので節は出すが、実質 1 個 (ページ直下の f) なのでボタンは無効
    expect(within(section("整列")).getByRole("button", { name: "左揃え" })).toBeDisabled();
  });
});

describe("フレーム", () => {
  it("プリセットで大きさを変え、切り抜きを切り替える", () => {
    render(<PropertiesPanel />);
    select("f");
    const preset = screen.getByRole("combobox", { name: "フレームのプリセット" });
    expect(preset).toHaveValue("custom");
    fireEvent.change(preset, { target: { value: "ogp" } });
    expect(node("f")).toMatchObject({ x: 100, y: 50, width: 1200, height: 630 });
    expect(preset).toHaveValue("ogp");
    fireEvent.click(screen.getByRole("checkbox", { name: "はみ出しを切り抜く" }));
    expect(node("f").clip).toBe(false);
  });

  it("frame ごとに値が違えば混在", () => {
    render(<PropertiesPanel />);
    select("f", "f2");
    expect(screen.getByRole("combobox", { name: "フレームのプリセット" })).toHaveValue("");
  });
});

describe("確定の対象 (§5.3 入力欄の確定の規則)", () => {
  it("何も打たずに選択が変わってフォーカスが外れても、新しい選択に書き込まない", () => {
    render(<PropertiesPanel />);
    select("r1");
    const x = field("X 座標");
    fireEvent.focus(x);
    select("r3");
    fireEvent.blur(x);
    expect(node("r3").x).toBe(5);
    expect(state().revision).toBe(0);
  });

  it("打ってから選択が変わっても、入力を始めた時点のノードに当てる", () => {
    render(<PropertiesPanel />);
    select("r1");
    const x = field("X 座標");
    fireEvent.focus(x);
    fireEvent.change(x, { target: { value: "33" } });
    select("r3");
    fireEvent.blur(x);
    expect(node("r1").x).toBe(33);
    expect(node("r3").x).toBe(5);
    expect(state().revision).toBe(1);
  });

  it("フォーカス中の Undo で値が変わっても、打っていなければ書き戻さない (Redo が残る)", () => {
    render(<PropertiesPanel />);
    select("r1");
    type(field("X 座標"), "33");
    const x = field("X 座標");
    fireEvent.focus(x);
    act(() => state().undo());
    expect(x).toHaveValue("10");
    fireEvent.blur(x);
    expect(node("r1").x).toBe(10);
    expect(state().canRedo).toBe(true);
  });

  it("対象のノードがなくなっていたら捨てる", () => {
    render(<PropertiesPanel />);
    select("r1", "r3");
    const x = field("X 座標");
    fireEvent.focus(x);
    fireEvent.change(x, { target: { value: "70" } });
    act(() => state().apply((doc) => deleteNodes(doc, ["r1", "r3"])));
    expect(state().revision).toBe(1);
    expect(getNode(state().doc, "r1")).toBeUndefined();
  });

  it("一部が消えていたら、残っているノードにだけ当てる", () => {
    render(<PropertiesPanel />);
    select("r1", "r3");
    const x = field("X 座標");
    fireEvent.focus(x);
    fireEvent.change(x, { target: { value: "70" } });
    act(() => state().apply((doc) => deleteNodes(doc, ["r1"])));
    fireEvent.blur(screen.getByRole("textbox", { name: "X 座標" }));
    expect(node("r3").x).toBe(70);
  });

  it("打ったまま選択が空になって節が外れたら、元の対象へ確定する", () => {
    render(<PropertiesPanel />);
    select("r1");
    const opacity = field("不透明度");
    fireEvent.focus(opacity);
    fireEvent.change(opacity, { target: { value: "40" } });
    select();
    expect(sectionNames()).toEqual(["ページ"]);
    expect(node("r1").opacity).toBe(0.4);
  });

  it("色の文字欄も入力を始めた時点のノードに当て、打っていなければ何もしない", () => {
    render(<PropertiesPanel />);
    select("r0");
    let color = field("塗りの色");
    fireEvent.focus(color);
    select("r1");
    fireEvent.blur(color);
    expect(state().revision).toBe(0);

    select("r0");
    color = field("塗りの色");
    fireEvent.focus(color);
    fireEvent.change(color, { target: { value: "#00ff00" } });
    select("r1");
    fireEvent.blur(color);
    expect(node("r0").fill).toMatchObject({ color: "#00FF00" });
    expect(node("r1").fill).toMatchObject({ color: "#D9D9D9" });

    color = field("塗りの色");
    fireEvent.focus(color);
    act(() => state().undo());
    fireEvent.blur(color);
    expect(node("r0").fill).toMatchObject({ color: "#D9D9D9" });
    expect(state().canRedo).toBe(true);
  });
});

describe("色の選択", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const pick = (input: HTMLElement, value: string, type: "input" | "change" = "input") =>
    act(() => {
      (input as HTMLInputElement).value = value;
      input.dispatchEvent(new Event(type, { bubbles: true }));
    });

  it("続けて動かした分を、最後の入力から時間がたったら履歴 1 件にまとめる (change では確定しない)", () => {
    render(<PropertiesPanel />);
    select("r0");
    const picker = screen.getByLabelText("塗りの色を選ぶ");
    pick(picker, "#ff0000");
    pick(picker, "#ff0000", "change");
    pick(picker, "#ee0000");
    pick(picker, "#ee0000", "change");
    expect(state().revision).toBe(0);
    expect(state().gestureActive).toBe(true);
    expect(node("r0").fill).toMatchObject({ color: "#EE0000" });
    act(() => vi.advanceTimersByTime(COLOR_PICK_SETTLE_MS - 1));
    expect(state().revision).toBe(0);
    act(() => vi.advanceTimersByTime(1));
    expect(state().revision).toBe(1);
    expect(state().gestureActive).toBe(false);
    act(() => state().undo());
    expect(node("r0").fill).toMatchObject({ color: "#D9D9D9" });
  });

  it("フォーカスが外れたらすぐに確定する", () => {
    render(<PropertiesPanel />);
    select("r0");
    const picker = screen.getByLabelText("塗りの色を選ぶ");
    pick(picker, "#123456");
    act(() => picker.dispatchEvent(new Event("blur")));
    expect(state().revision).toBe(1);
  });

  it("途中でほかの操作がジェスチャーを終えても、次の色を捨てない", () => {
    render(<PropertiesPanel />);
    select("r0");
    const picker = screen.getByLabelText("塗りの色を選ぶ");
    pick(picker, "#ff0000");
    act(() => state().apply((doc) => updateNodes(doc, ["r1"], { name: "別" })));
    expect(state().gestureActive).toBe(false);
    pick(picker, "#0000ff");
    expect(node("r0").fill).toMatchObject({ color: "#0000FF" });
    act(() => vi.advanceTimersByTime(COLOR_PICK_SETTLE_MS));
    expect(state().gestureActive).toBe(false);
    expect(node("r0").fill).toMatchObject({ color: "#0000FF" });
  });

  it("Undo がジェスチャーを取り消したら、次の色から新しいジェスチャーにする", () => {
    render(<PropertiesPanel />);
    select("r0");
    const picker = screen.getByLabelText("塗りの色を選ぶ");
    pick(picker, "#ff0000");
    act(() => state().undo());
    expect(node("r0").fill).toMatchObject({ color: "#D9D9D9" });
    pick(picker, "#00ff00");
    act(() => vi.advanceTimersByTime(COLOR_PICK_SETTLE_MS));
    expect(node("r0").fill).toMatchObject({ color: "#00FF00" });
    expect(state().revision).toBe(1);
  });
});

describe("停止点の削除", () => {
  it("位置を打ったまま同じ行の削除を押しても、別の停止点を消さない", () => {
    render(<PropertiesPanel />);
    select("r0");
    const fill = section("塗り");
    fireEvent.click(within(fill).getByRole("button", { name: "線形" }));
    fireEvent.click(within(fill).getByRole("button", { name: "停止点を追加" }));
    const offsets = () => (node("r0").fill as LinearGradientPaint).stops.map((s) => s.offset);
    expect(offsets()).toEqual([0, 0.5, 1]);

    const position = within(fill).getByRole("textbox", { name: "停止点 3 の位置" });
    const remove = within(fill).getByRole("button", { name: "停止点 3 を削除" });
    fireEvent.focus(position);
    fireEvent.change(position, { target: { value: "10" } });
    fireEvent.pointerDown(remove);
    fireEvent.blur(position); // 位置が確定して並びが [0, 0.1, 0.5] になる
    fireEvent.click(remove);
    expect(offsets()).toEqual([0, 0.1, 0.5]);

    // 打っていなければ、押した行の停止点を消す
    fireEvent.pointerDown(within(fill).getByRole("button", { name: "停止点 3 を削除" }));
    fireEvent.click(within(fill).getByRole("button", { name: "停止点 3 を削除" }));
    expect(offsets()).toEqual([0, 0.1]);
  });
});

describe("整列の範囲", () => {
  it("親の座標系が違うノードをそろえて上限を超えるなら当てない", () => {
    act(() =>
      state().apply((doc) =>
        updateNodes(updateNodes(doc, ["f"], { x: 900000 }), ["r0"], { x: -900000 }),
      ),
    );
    render(<PropertiesPanel />);
    select("r1", "r0");
    const before = state().revision;
    fireEvent.click(within(section("整列")).getByRole("button", { name: "左揃え" }));
    expect(state().revision).toBe(before);
    expect(node("r1").x).toBe(10);
  });
});

describe("PropertiesPanel を StrictMode で描く (アプリと同じ)", () => {
  const strict = () =>
    render(
      <StrictMode>
        <PropertiesPanel />
      </StrictMode>,
    );

  it("数値と色の文字欄で、確定・取消・確定の対象の規則が変わらない", () => {
    strict();
    select("r1");
    type(field("X 座標"), "33");
    expect(node("r1").x).toBe(33);
    type(field("Y 座標"), "40", "Escape");
    expect(node("r1").y).toBe(10);
    const color = field("塗りの色");
    fireEvent.focus(color);
    fireEvent.change(color, { target: { value: "#00ff00" } });
    select("r3");
    fireEvent.blur(color);
    expect(node("r1").fill).toMatchObject({ color: "#00FF00" });
    expect(node("r3").fill).toMatchObject({ color: "#D9D9D9" });
    expect(state().revision).toBe(2);
  });

  it("色の選択がジェスチャーとして動き、時間がたったら履歴 1 件", () => {
    vi.useFakeTimers();
    try {
      strict();
      select("r0");
      const picker = screen.getByLabelText("塗りの色を選ぶ") as HTMLInputElement;
      act(() => {
        picker.value = "#ff0000";
        picker.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(state().gestureActive).toBe(true);
      act(() => vi.advanceTimersByTime(COLOR_PICK_SETTLE_MS));
      expect(state().revision).toBe(1);
      expect(node("r0").fill).toMatchObject({ color: "#FF0000" });
    } finally {
      vi.useRealTimers();
    }
  });
});
