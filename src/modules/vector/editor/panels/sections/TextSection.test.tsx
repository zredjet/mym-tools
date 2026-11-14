import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyDocument, createRect, createText, FIRST_PAGE_ID } from "../../model/create";
import { insertNode } from "../../model/structure";
import type { CanvasDocument, TextNode } from "../../model/types";
import { canvasTextMeasurer } from "../../render/measureText";
import { editorStore } from "../../state/store";
import { fitTextNodes } from "../../text/fit";
import { fontDetector } from "../../text/fonts";
import { TextSection } from "./TextSection";

const page = { kind: "page", id: FIRST_PAGE_ID } as const;
const state = () => editorStore.getState();
const textOf = (id: string) => state().doc.nodes[id] as TextNode;
const select = (...ids: string[]) => act(() => state().setSelection(ids));
const section = () => screen.getByRole("region", { name: "文字" });
const field = (name: string) => within(section()).getByRole("textbox", { name });
const type = (input: HTMLElement, value: string, key = "Enter") => {
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key });
};

function documentWithTexts(): CanvasDocument {
  let doc = createEmptyDocument();
  doc = insertNode(doc, createRect({ id: "r1" }), page);
  doc = insertNode(doc, createText({ id: "t1", text: "abc", fontFamily: "Arial" }), page);
  doc = insertNode(
    doc,
    createText({ id: "t2", text: "de", fontSize: 24, lineHeight: 30, fontFamily: "Arial" }),
    page,
  );
  return fitTextNodes(doc, null, canvasTextMeasurer);
}

beforeEach(() => {
  state().load(documentWithTexts());
  vi.spyOn(fontDetector, "availableGroups").mockReturnValue([
    { label: "欧文", families: ["Arial", "Georgia"] },
    { label: "総称", families: ["sans-serif"] },
  ]);
  vi.spyOn(fontDetector, "isAvailable").mockImplementation((name) => name !== "Missing Font");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("TextSection", () => {
  it("テキストを選んでいなければ出さない", () => {
    render(<TextSection />);
    select("r1");
    expect(screen.queryByRole("region", { name: "文字" })).toBeNull();
  });

  it("サイズを変えると大きさも求め直し、履歴 1 件。テキスト以外には当てない", () => {
    render(<TextSection />);
    select("t1", "r1");
    const before = textOf("t1");
    type(field("フォントサイズ"), "32");
    expect(textOf("t1")).toMatchObject({ fontSize: 32 });
    expect(textOf("t1").width).toBeGreaterThan(before.width);
    expect(textOf("t1").height).toBe(45);
    expect(state().revision).toBe(1);
    expect(state().doc.nodes.r1).toEqual(createRect({ id: "r1" }));
  });

  it("複数選択で値が違う欄は混在。行の高さは自動のとき「自動」を添える", () => {
    render(<TextSection />);
    select("t1", "t2");
    expect(field("フォントサイズ")).toHaveValue("");
    expect(field("フォントサイズ")).toHaveAttribute("placeholder", "混在");
    expect(field("フォント名")).toHaveValue("Arial");
    select("t1");
    expect(field("行の高さ")).toHaveValue("22.4");
    expect(within(section()).getByText("自動")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "行の高さを自動にする" })).toBeDisabled();
  });

  it("行の高さを数値にし、自動に戻す", () => {
    render(<TextSection />);
    select("t1");
    type(field("行の高さ"), "40");
    expect(textOf("t1")).toMatchObject({ lineHeight: 40, height: 40 });
    fireEvent.click(screen.getByRole("button", { name: "行の高さを自動にする" }));
    expect(textOf("t1")).toMatchObject({ lineHeight: null, height: 23 });
    expect(state().revision).toBe(2);
  });

  it("フォント名の入力は、入力を始めた時点の対象に当てる", () => {
    render(<TextSection />);
    select("t1");
    const input = field("フォント名");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Georgia" } });
    select("t1", "t2");
    fireEvent.blur(input);
    expect(textOf("t1").fontFamily).toBe("Georgia");
    expect(textOf("t2").fontFamily).toBe("Arial");
  });

  it("フォント名の Esc は取り消し、空や制御文字の名前は確定しない", () => {
    render(<TextSection />);
    select("t1");
    type(field("フォント名"), "Georgia", "Escape");
    type(field("フォント名"), "   ");
    type(field("フォント名"), "A\u0007");
    expect(textOf("t1").fontFamily).toBe("Arial");
    expect(state().revision).toBe(0);
  });

  it("候補の一覧から選べる。PC にないフォントには注意を出す", () => {
    render(<TextSection />);
    select("t1");
    const picker = within(section()).getByRole("combobox", { name: "フォントの候補" });
    expect(
      within(picker)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Arial", "Arial", "Georgia", "sans-serif"]);
    fireEvent.change(picker, { target: { value: "Georgia" } });
    expect(textOf("t1").fontFamily).toBe("Georgia");
    expect(within(section()).queryByRole("note")).toBeNull();
    type(field("フォント名"), "Missing Font");
    expect(within(section()).getByRole("note")).toHaveTextContent(
      "「Missing Font」はこの PC にありません",
    );
  });

  it("太さ・斜体・字間・揃え・大きさの決め方を当てる", () => {
    render(<TextSection />);
    select("t1");
    fireEvent.change(within(section()).getByRole("combobox", { name: "太さ" }), {
      target: { value: "700" },
    });
    fireEvent.click(within(section()).getByRole("checkbox"));
    type(field("字間"), "2");
    fireEvent.click(within(section()).getByRole("button", { name: "中央" }));
    fireEvent.click(within(section()).getByRole("button", { name: "高さを自動" }));
    expect(textOf("t1")).toMatchObject({
      fontWeight: 700,
      italic: true,
      letterSpacing: 2,
      align: "center",
      sizing: "auto-height",
    });
    expect(state().revision).toBe(5);
  });
});
