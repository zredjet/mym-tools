import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createRect } from "../model/create";
import { insertNode } from "../model/structure";
import { sampleDocument } from "../model/testing";
import { updateNodes } from "../model/transform";
import { editorStore } from "../state/store";
import { DEFAULT_VIEW_OPTIONS } from "../state/types";
import { LayersPanel } from "./LayersPanel";

/** 行が描かれた回数 (行のアイコンが描かれた回数で数える)。 */
const renders = vi.hoisted(() => vi.fn<(id: string) => void>());

vi.mock("./layers/layerActions", async (importOriginal) => {
  const original = await importOriginal<typeof import("./layers/layerActions")>();
  const counting = (props: { "data-row-id"?: string }) => {
    renders(props["data-row-id"] ?? "");
    return null;
  };
  const icons = Object.fromEntries(
    Object.keys(original.NODE_TYPE_ICONS).map((type) => [type, counting]),
  );
  return { ...original, NODE_TYPE_ICONS: icons };
});

const state = () => editorStore.getState();
const row = (id: string) => {
  const found = screen.getAllByRole("treeitem").find((el) => el.dataset.layerId === id);
  if (!found) throw new Error(`row not found: ${id}`);
  return found;
};
const rendered = () => renders.mock.calls.map(([id]) => id);

beforeEach(() => {
  state().load(sampleDocument());
  state().setView({ ...DEFAULT_VIEW_OPTIONS });
  renders.mockClear();
});

describe("LayersPanel の描き直し (§5.2)", () => {
  it("初回は全行を描く", () => {
    render(<LayersPanel />);
    expect(rendered()).toHaveLength(8);
  });

  it("選択が変わったら、選択が変わった行だけを描き直す", () => {
    render(<LayersPanel />);
    act(() => state().setSelection(["r0"]));
    renders.mockClear();
    act(() => state().setSelection(["r1"]));
    expect(rendered().sort()).toEqual(["r0", "r1"]);
  });

  it("ノード 1 個の変更は、その行だけ", () => {
    render(<LayersPanel />);
    renders.mockClear();
    act(() => state().apply((doc) => updateNodes(doc, ["r2"], { name: "四角" })));
    expect(rendered()).toEqual(["r2"]);
    renders.mockClear();
    act(() => state().apply((doc) => updateNodes(doc, ["r2"], { x: 99 })));
    expect(rendered()).toEqual(["r2"]);
  });

  it("ノードを足しても、ほかの行は描き直さない", () => {
    render(<LayersPanel />);
    renders.mockClear();
    act(() =>
      state().apply((doc) => insertNode(doc, createRect({ id: "n1" }), { kind: "page", id: "p1" })),
    );
    expect(rendered()).toEqual(["n1"]);
  });

  it("開閉したら、開閉した行だけを描き直す", () => {
    render(<LayersPanel />);
    renders.mockClear();
    fireEvent.click(within(row("grp")).getByRole("button", { name: "閉じる" }));
    expect(rendered()).toEqual(["grp"]);
  });
});
