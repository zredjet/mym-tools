import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { showImportNotice, getImportStatus } from "../assets/status";
import {
  createBoolean,
  createEllipse,
  createLine,
  createPath,
  createRect,
  createStroke,
  createText,
  solidPaint,
} from "../model/create";
import { checkSavable } from "../model/payload";
import { getNode } from "../model/tree";
import type { CanvasDocument, CanvasNode } from "../model/types";
import { ellipseSubpaths } from "../path/shapes";
import { editorStore } from "../state/store";
import { DEFAULT_VIEW_OPTIONS } from "../state/types";
import { PropertiesPanel } from "./PropertiesPanel";

const state = () => editorStore.getState();
const node = (id: string) => getNode(state().doc, id) as CanvasNode & Record<string, unknown>;
const section = (name: string) => screen.getByRole("region", { name });
const sectionNames = () =>
  screen
    .queryAllByRole("region")
    .map((el) => el.getAttribute("aria-label"))
    .filter((name) => name !== "書き出し");
const select = (...ids: string[]) => act(() => state().setSelection(ids));
const field = (name: string) => screen.getByRole("textbox", { name });
const type = (input: HTMLElement, value: string, key = "Enter") => {
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key });
};

function docOf(children: string[], nodes: CanvasNode[]): CanvasDocument {
  return {
    pages: [{ id: "p1", name: "ページ 1", children, guides: [] }],
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    assets: {},
  };
}

beforeEach(() => {
  showImportNotice(null);
  state().load(
    docOf(
      ["a", "b", "t", "p", "l", "u"],
      [
        createRect({ id: "a", width: 20, height: 20, rotation: 30, fill: solidPaint("#FF0000") }),
        createEllipse({ id: "b", x: 10, width: 20, height: 20, rotation: 30 }),
        createText({ id: "t", text: "文字" }),
        createPath(ellipseSubpaths(10, 10), { id: "p", x: 50 }),
        createLine({ id: "l", x1: 0, y1: 50, x2: 40, y2: 50 }),
        createBoolean("subtract", ["c1", "c2"], { id: "u" }),
        createRect({ id: "c1", x: 100, width: 30, height: 30 }),
        createEllipse({ id: "c2", x: 110, y: 10, width: 10, height: 10 }),
      ],
    ),
  );
  state().setView({ ...DEFAULT_VIEW_OPTIONS });
});

describe("位置と大きさ: 回転と反転 (§5.3)", () => {
  it("回転の欄は自分の rotation。入力は -180〜180 にそろえる (履歴 1 件)", () => {
    render(<PropertiesPanel />);
    select("a");
    expect(field("回転")).toHaveValue("30");
    type(field("回転"), "270");
    expect(node("a").rotation).toBe(-90);
    expect(state().revision).toBe(1);
  });

  it("複数選択は同じ値ならその値、違えば混在。入力はそれぞれにそろえる", () => {
    render(<PropertiesPanel />);
    select("a", "b");
    expect(field("回転")).toHaveValue("30");
    act(() =>
      state().apply((doc) => ({
        ...doc,
        nodes: { ...doc.nodes, b: { ...doc.nodes["b"]!, rotation: 10 } as CanvasNode },
      })),
    );
    expect(field("回転")).toHaveValue("");
    expect(field("回転")).toHaveAttribute("placeholder", "混在");
    type(field("回転"), "45");
    expect([node("a").rotation, node("b").rotation]).toEqual([45, 45]);
  });

  it("箱を持たないノード (線・ブーリアン) を含むと回転の欄を出さない", () => {
    render(<PropertiesPanel />);
    select("a", "l");
    expect(screen.queryByRole("textbox", { name: "回転" })).toBeNull();
  });

  it("反転のボタン。テキストを含む選択では押せない", () => {
    render(<PropertiesPanel />);
    select("a");
    fireEvent.click(within(section("位置と大きさ")).getByRole("button", { name: "左右反転" }));
    expect(node("a").rotation).toBe(-30);
    select("a", "t");
    expect(
      within(section("位置と大きさ")).getByRole("button", { name: "上下反転" }),
    ).toBeDisabled();
  });
});

describe("線: 端・角・破線 (§5.3)", () => {
  it("端と角を切り替え、破線を入れる。空は実線", () => {
    render(<PropertiesPanel />);
    select("l", "p");
    const stroke = section("線");
    fireEvent.click(
      within(within(stroke).getByRole("group", { name: "線の端" })).getByRole("button", {
        name: "丸",
      }),
    );
    fireEvent.click(
      within(within(stroke).getByRole("group", { name: "線の角" })).getByRole("button", {
        name: "ベベル",
      }),
    );
    type(field("破線"), "4, 2　1");
    for (const id of ["l", "p"])
      expect(node(id).stroke).toMatchObject({ cap: "round", join: "bevel", dash: [4, 2, 1] });
    expect(field("破線")).toHaveValue("4 2 1");
    type(field("破線"), "");
    expect(node("l").stroke).toMatchObject({ dash: [] });
    expect(checkSavable(state().doc)).toBeNull();
  });

  it("規則に合わない破線は当てない (負の値、9 個以上、合計 0、数値でない)", () => {
    render(<PropertiesPanel />);
    select("l");
    for (const bad of ["-1 2", "1 1 1 1 1 1 1 1 1", "0 0", "a b", "20000"]) {
      type(field("破線"), bad);
      expect(node("l").stroke).toMatchObject({ dash: [] });
    }
    expect(state().revision).toBe(0);
  });

  it("混在の破線は、打ってから空にして確定すると全部を実線にする", () => {
    act(() =>
      state().apply((doc) => ({
        ...doc,
        nodes: {
          ...doc.nodes,
          l: { ...doc.nodes["l"]!, stroke: { ...createStroke(), dash: [4, 2] } } as CanvasNode,
        },
      })),
    );
    render(<PropertiesPanel />);
    select("l", "p");
    const input = field("破線");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "4" } });
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(node("l").stroke).toMatchObject({ dash: [] });
    expect(node("p").stroke).toMatchObject({ dash: [] });
  });

  it("違う破線は混在と出す", () => {
    act(() =>
      state().apply((doc) => ({
        ...doc,
        nodes: {
          ...doc.nodes,
          l: { ...doc.nodes["l"]!, stroke: { ...createStroke(), dash: [3] } } as CanvasNode,
        },
      })),
    );
    render(<PropertiesPanel />);
    select("l", "p");
    expect(field("破線")).toHaveAttribute("placeholder", "混在");
  });
});

describe("パスとブーリアンの節", () => {
  it("パスは塗り・線・影と、塗りの規則を出す", () => {
    render(<PropertiesPanel />);
    select("p");
    expect(sectionNames()).toEqual(expect.arrayContaining(["塗り", "線", "影", "パス"]));
    fireEvent.click(within(section("パス")).getByRole("button", { name: "偶奇" }));
    expect(node("p").fillRule).toBe("evenodd");
  });

  it("ブーリアンは演算を切り替える (履歴 1 件、既定の名前も変わる)", () => {
    render(<PropertiesPanel />);
    select("u");
    expect(sectionNames()).toEqual(expect.arrayContaining(["塗り", "線", "影", "ブーリアン"]));
    fireEvent.click(within(section("ブーリアン")).getByRole("button", { name: "交差" }));
    expect(node("u")).toMatchObject({ op: "intersect", name: "交差" });
    expect(state().revision).toBe(1);
  });
});

describe("変換の節 (§5.3)", () => {
  const convertButton = (name: string) => within(section("変換")).getByRole("button", { name });

  it("2 個以上の矩形・楕円でブーリアンを作り、それを選ぶ", () => {
    render(<PropertiesPanel />);
    select("a", "b");
    fireEvent.click(convertButton("合体"));
    const [id] = state().selection;
    expect(node(id!)).toMatchObject({ type: "boolean", op: "union", children: ["a", "b"] });
    expect(state().doc.pages[0]?.children).toEqual([id, "t", "p", "l", "u"]);
    expect(checkSavable(state().doc)).toBeNull();
  });

  it("テキストを含む選択ではブーリアンもパスに変換も出さない", () => {
    render(<PropertiesPanel />);
    select("a", "t");
    expect(sectionNames()).not.toContain("変換");
  });

  it("パスに変換 (1 個は同じ ID のまま)", () => {
    render(<PropertiesPanel />);
    select("a");
    fireEvent.click(convertButton("パスに変換"));
    expect(node("a")).toMatchObject({ type: "path", rotation: 30 });
    expect(state().selection).toEqual(["a"]);
    // パス 1 個ではパスに変換を出さない
    expect(screen.queryByRole("region", { name: "変換" })).toBeNull();
  });

  it("ブーリアンの子を選べば、子のままパスに変わる", () => {
    render(<PropertiesPanel />);
    select("c2");
    fireEvent.click(convertButton("パスに変換"));
    expect(node("c2").type).toBe("path");
    expect(node("u").children).toEqual(["c1", "c2"]);
  });

  it("当てられないときは理由を出す (結果が空のブーリアン)", () => {
    act(() =>
      state().apply((doc) => ({
        ...doc,
        nodes: {
          ...doc.nodes,
          c2: { ...doc.nodes["c2"]!, x: 500 } as CanvasNode,
          u: { ...doc.nodes["u"]!, op: "intersect" } as CanvasNode,
        },
      })),
    );
    const revision = state().revision;
    render(<PropertiesPanel />);
    select("u");
    fireEvent.click(convertButton("パスに変換"));
    expect(node("u").type).toBe("boolean");
    expect(state().revision).toBe(revision);
    expect(getImportStatus().notice).toMatchObject({ tone: "error" });
  });
});
