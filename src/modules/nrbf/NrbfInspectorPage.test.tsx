import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NrbfNode, NrbfProgress, NrbfSummary } from "@/ipc/nrbf";
import { cancelNrbfOperation, nrbfInspectFile } from "@/ipc/nrbf";

import { NrbfInspectorPage } from "./NrbfInspectorPage";

const openDialog = vi.fn();
const onDragDropEvent = vi.fn().mockResolvedValue(() => {});
let dragDropHandler: ((event: { payload: { type: string; paths: string[] } }) => void) | undefined;

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: (...args: unknown[]) => openDialog(...args) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent }) }));
vi.mock("@/ipc/nrbf", async () => {
  const actual = await vi.importActual<typeof import("@/ipc/nrbf")>("@/ipc/nrbf");
  return { ...actual, nrbfInspectFile: vi.fn(), cancelNrbfOperation: vi.fn() };
});

const inspectMock = vi.mocked(nrbfInspectFile);
const cancelMock = vi.mocked(cancelNrbfOperation);

function makeNode(
  overrides: Partial<NrbfNode> & Pick<NrbfNode, "id" | "parentId" | "displayName">,
): NrbfNode {
  return {
    rawName: overrides.displayName,
    kind: "object",
    typeName: null,
    assemblyName: null,
    formattedValue: null,
    recordId: String(overrides.id),
    referenceTargetId: null,
    shape: null,
    ...overrides,
  };
}

const sampleNodes: NrbfNode[] = [
  makeNode({ id: 1, parentId: null, displayName: "$", typeName: "Sample.Person" }),
  makeNode({
    id: 2,
    parentId: 1,
    displayName: "Name",
    rawName: "<Name>k__BackingField",
    kind: "scalar",
    formattedValue: "Alice",
  }),
  makeNode({ id: 3, parentId: 1, displayName: "City", kind: "scalar", formattedValue: "東京" }),
  makeNode({
    id: 4,
    parentId: 1,
    displayName: "Friend",
    kind: "reference",
    formattedValue: "→ #1",
    referenceTargetId: 1,
  }),
];
const summary: NrbfSummary = {
  path: "/data/sample.bin",
  fileName: "sample.bin",
  fileSizeBytes: 128,
  rootType: "Sample.Person",
  nodeCount: sampleNodes.length,
  warnings: [],
  durationMs: 5,
};

function resolveWith(nodes = sampleNodes, completed = { ...summary, nodeCount: nodes.length }) {
  inspectMock.mockImplementation(async (input) => {
    input.onProgress({ type: "started", fileSizeBytes: completed.fileSizeBytes });
    input.onProgress({ type: "nodes", nodes });
    input.onProgress({ type: "done", summary: completed });
    return completed;
  });
}

describe("NrbfInspectorPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openDialog.mockResolvedValue("/data/sample.bin");
    dragDropHandler = undefined;
    onDragDropEvent.mockImplementation(async (handler: typeof dragDropHandler) => {
      dragDropHandler = handler;
      return () => {};
    });
    cancelMock.mockResolvedValue();
    resolveWith();
  });

  it("loads one file and shows the friendly tree", async () => {
    const user = userEvent.setup();
    render(<NrbfInspectorPage />);
    await user.click(screen.getByRole("button", { name: "ファイルを選択" }));
    expect(await screen.findByText(/Alice/)).toBeInTheDocument();
    expect(screen.getByText(/4ノード/)).toBeInTheDocument();
    expect(screen.getByText("Name")).toBeInTheDocument();
    expect(inspectMock).toHaveBeenCalledWith(expect.objectContaining({ expandByteArrays: false }));
  });

  it("shows multi-line sidecar error details and copies them", async () => {
    const reason =
      "NRBFデータを解析できません。\n\n【詳細】\n例外: System.Runtime.Serialization.SerializationException: Invalid type name.\n診断: 該当する型名 1件:\n  - 複雑さ 24: Sample.Many`22";
    inspectMock.mockRejectedValue({ code: "validation", message: { module_id: "nrbf", reason } });
    const user = userEvent.setup();
    render(<NrbfInspectorPage />);
    await user.click(screen.getByRole("button", { name: "ファイルを選択" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(reason);
    expect(alert).toHaveClass("whitespace-pre-wrap");
    await user.click(screen.getByRole("button", { name: "エラー詳細をコピー" }));
    await expect(navigator.clipboard.readText()).resolves.toBe(reason);
  });

  it("reports an incomplete delivery instead of showing an empty or partial tree", async () => {
    resolveWith(sampleNodes.slice(0, 2), { ...summary, nodeCount: 405 });
    const user = userEvent.setup();
    render(<NrbfInspectorPage />);
    await user.click(screen.getByRole("button", { name: "ファイルを選択" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "NRBF解析結果の受信が不完全です（受信 2 / 解析 405 ノード）",
    );
    expect(screen.queryByText("Name")).not.toBeInTheDocument();
  });

  it("expands byte arrays only when explicitly allowed for the next read", async () => {
    const user = userEvent.setup();
    render(<NrbfInspectorPage />);
    await user.click(screen.getByRole("checkbox", { name: /byte配列を展開/ }));
    await user.click(screen.getByRole("button", { name: "ファイルを選択" }));
    await screen.findByText(/Alice/);
    expect(inspectMock).toHaveBeenCalledWith(expect.objectContaining({ expandByteArrays: true }));
  });

  it("loads the first path from an operating-system file drop", async () => {
    render(<NrbfInspectorPage />);
    await waitFor(() => expect(dragDropHandler).toBeDefined());
    act(() => dragDropHandler?.({ payload: { type: "drop", paths: ["/data/dropped.bin"] } }));
    expect(await screen.findByText(/Alice/)).toBeInTheDocument();
    expect(inspectMock).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/data/dropped.bin" }),
    );
  });

  it("searches names and values independently and keeps ancestor paths", async () => {
    const user = userEvent.setup();
    render(<NrbfInspectorPage />);
    await user.click(screen.getByRole("button", { name: "ファイルを選択" }));
    const valueSearch = await screen.findByRole("textbox", { name: "値を検索" });
    await user.type(valueSearch, "東京");
    expect(screen.getByText("City")).toBeInTheDocument();
    expect(screen.queryByText("Alice")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("1件一致");
  });

  it("filters by the combination of a name and value on the same node", async () => {
    const user = userEvent.setup();
    render(<NrbfInspectorPage />);
    await user.click(screen.getByRole("button", { name: "ファイルを選択" }));
    await user.type(await screen.findByRole("textbox", { name: "項目名を検索" }), "City");
    await user.type(screen.getByRole("textbox", { name: "値を検索" }), "東京");
    expect(screen.getByText("City")).toBeInTheDocument();
    expect(screen.queryByText("Alice")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("1件一致");
  });

  it("jumps through matches without filtering the normal tree", async () => {
    const user = userEvent.setup();
    render(<NrbfInspectorPage />);
    await user.click(screen.getByRole("button", { name: "ファイルを選択" }));
    await user.selectOptions(await screen.findByRole("combobox", { name: "検索方法" }), "jump");
    await user.type(screen.getByRole("textbox", { name: "項目名を検索" }), "City");
    expect(screen.getByText(/Alice/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "次の一致へ" }));
    expect(screen.getByRole("treeitem", { selected: true })).toHaveTextContent("City");
    expect(screen.getByRole("status")).toHaveTextContent("1 / 1");
    expect(screen.getByRole("button", { name: "次の一致へ" })).toHaveFocus();
    const nameSearch = screen.getByRole("textbox", { name: "項目名を検索" });
    await user.click(nameSearch);
    await user.keyboard("{Enter}");
    expect(nameSearch).toHaveFocus();
  });

  it("switches to raw field names without re-reading the file", async () => {
    const user = userEvent.setup();
    render(<NrbfInspectorPage />);
    await user.click(screen.getByRole("button", { name: "ファイルを選択" }));
    await screen.findByText("Name");
    await user.click(screen.getByRole("checkbox", { name: "Raw表示" }));
    expect(screen.getByText("<Name>k__BackingField")).toBeInTheDocument();
    expect(inspectMock).toHaveBeenCalledTimes(1);
  });

  it("jumps from a reference to its canonical node", async () => {
    const user = userEvent.setup();
    render(<NrbfInspectorPage />);
    await user.click(screen.getByRole("button", { name: "ファイルを選択" }));
    await user.click(await screen.findByText("Friend"));
    await user.click(screen.getByRole("button", { name: "#1へ移動" }));
    expect(screen.getByRole("treeitem", { selected: true })).toHaveTextContent("$");
  });

  it("clears an active search before jumping to a reference target outside the result", async () => {
    const filteredReferenceNodes = [
      makeNode({ id: 1, parentId: null, displayName: "$" }),
      makeNode({ id: 2, parentId: 1, displayName: "Canonical", kind: "scalar" }),
      makeNode({
        id: 3,
        parentId: 1,
        displayName: "Needle reference",
        kind: "reference",
        referenceTargetId: 2,
      }),
    ];
    resolveWith(filteredReferenceNodes, { ...summary, nodeCount: filteredReferenceNodes.length });
    const user = userEvent.setup();
    render(<NrbfInspectorPage />);
    await user.click(screen.getByRole("button", { name: "ファイルを選択" }));
    const search = await screen.findByRole("textbox", { name: "項目名を検索" });
    await user.type(search, "Needle");
    expect(screen.queryByText("Canonical")).not.toBeInTheDocument();
    await user.click(screen.getByRole("treeitem", { name: /Needle reference/ }));
    await user.click(screen.getByRole("button", { name: "#2へ移動" }));
    expect(search).toHaveValue("");
    expect(screen.getByRole("treeitem", { selected: true })).toHaveTextContent("Canonical");
  });

  it("virtualizes a large expanded tree and supports arrow-key selection", async () => {
    const many = [
      makeNode({ id: 1, parentId: null, displayName: "$" }),
      ...Array.from({ length: 5000 }, (_, index) =>
        makeNode({
          id: index + 2,
          parentId: 1,
          displayName: `Item ${index}`,
          kind: "scalar",
          formattedValue: String(index),
        }),
      ),
    ];
    resolveWith(many, { ...summary, nodeCount: many.length });
    const user = userEvent.setup();
    render(<NrbfInspectorPage />);
    await user.click(screen.getByRole("button", { name: "ファイルを選択" }));
    const tree = await screen.findByRole("tree");
    expect(screen.getAllByRole("treeitem").length).toBeLessThan(50);
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(screen.getByRole("treeitem", { selected: true })).toHaveTextContent("Item 0");
    tree.focus();
    for (let index = 0; index < 40; index++) fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(tree.scrollTop).toBe(42 * 32 - 464);
    const selected = screen.getByRole("treeitem", { selected: true });
    expect(selected).toHaveTextContent("Item 40");
    expect(tree).toHaveAttribute("aria-activedescendant", selected.id);
    expect(selected).toHaveAttribute("aria-posinset", "41");
    expect(selected).toHaveAttribute("aria-setsize", "5000");
    expect(screen.getAllByRole("treeitem").every((item) => item.tabIndex === -1)).toBe(true);
    expect(tree).toHaveFocus();

    fireEvent.keyDown(tree, { key: "End" });
    expect(screen.getByRole("treeitem", { selected: true })).toHaveTextContent("Item 4999");
    expect(tree.scrollTop).toBe(5001 * 32 - 464);
    fireEvent.scroll(tree, { target: { scrollTop: 0 } });
    expect(screen.getByRole("treeitem", { selected: true })).toHaveTextContent("Item 4999");
    expect(tree.scrollTop).toBe(0);
    expect(screen.getAllByRole("treeitem").length).toBeLessThan(50);
    fireEvent.keyDown(tree, { key: "Home" });
    expect(screen.getByRole("treeitem", { selected: true })).toHaveTextContent("$");
    await user.tab();
    expect(tree).not.toHaveFocus();
    expect(screen.getAllByRole("treeitem")).not.toContain(document.activeElement);
  });

  it.each(["list", "dictionary"])(
    "reveals hidden %s reference targets without decoding again",
    async (kind) => {
      const container = makeNode({
        id: 2,
        parentId: 1,
        displayName: "Container",
        typeName:
          kind === "list"
            ? "System.Collections.Generic.List`1[[System.String]]"
            : "System.Collections.Generic.Dictionary`2[[System.String],[System.String]]",
      });
      const fields =
        kind === "list"
          ? [
              makeNode({ id: 3, parentId: 2, displayName: "_items", kind: "array", shape: [1] }),
              makeNode({
                id: 4,
                parentId: 3,
                displayName: "[0]",
                kind: "scalar",
                formattedValue: "value",
              }),
              makeNode({
                id: 5,
                parentId: 2,
                displayName: "_size",
                kind: "scalar",
                formattedValue: "1",
              }),
              makeNode({
                id: 6,
                parentId: 2,
                displayName: "_version",
                kind: "scalar",
                formattedValue: "1",
              }),
            ]
          : [
              makeNode({ id: 3, parentId: 2, displayName: "Comparer" }),
              makeNode({
                id: 4,
                parentId: 2,
                displayName: "Version",
                kind: "scalar",
                formattedValue: "1",
              }),
              makeNode({
                id: 5,
                parentId: 2,
                displayName: "HashSize",
                kind: "scalar",
                formattedValue: "0",
              }),
              makeNode({
                id: 6,
                parentId: 2,
                displayName: "KeyValuePairs",
                kind: "array",
                shape: [0],
              }),
            ];
      const fixture = [
        makeNode({ id: 1, parentId: null, displayName: "$" }),
        container,
        ...fields,
        makeNode({
          id: 7,
          parentId: 1,
          displayName: "Shared",
          kind: "reference",
          referenceTargetId: 3,
        }),
      ];
      resolveWith(fixture, { ...summary, nodeCount: fixture.length });
      const user = userEvent.setup();
      render(<NrbfInspectorPage />);
      await user.click(screen.getByRole("button", { name: "ファイルを選択" }));
      await user.type(await screen.findByRole("textbox", { name: "項目名を検索" }), "Shared");
      await user.click(await screen.findByRole("treeitem", { name: /Shared/ }));
      await user.click(screen.getByRole("button", { name: "#3へ移動" }));
      expect(screen.getByRole("checkbox", { name: "Raw表示" })).toBeChecked();
      expect(screen.getByRole("treeitem", { selected: true })).toHaveTextContent(
        fields[0]!.rawName,
      );
      expect(screen.getByRole("tree")).toHaveFocus();
      expect(screen.getByRole("textbox", { name: "項目名を検索" })).toHaveValue("");
      await user.click(screen.getByRole("checkbox", { name: "Raw表示" }));
      expect(screen.getByRole("treeitem", { selected: true })).toHaveTextContent("Container");
      expect(inspectMock).toHaveBeenCalledTimes(1);
    },
  );

  it("navigates parent and child rows, and reconciles a selection after collapsing", async () => {
    const fixture = [
      makeNode({ id: 1, parentId: null, displayName: "$" }),
      makeNode({ id: 2, parentId: 1, displayName: "Branch" }),
      makeNode({
        id: 3,
        parentId: 2,
        displayName: "Leaf",
        kind: "scalar",
        formattedValue: "value",
      }),
    ];
    resolveWith(fixture, { ...summary, nodeCount: fixture.length });
    const user = userEvent.setup();
    render(<NrbfInspectorPage />);
    await user.click(screen.getByRole("button", { name: "ファイルを選択" }));
    const tree = await screen.findByRole("tree");
    tree.focus();
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    expect(screen.getByRole("treeitem", { selected: true })).toHaveTextContent("Branch");
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    expect(screen.getByRole("treeitem", { selected: true })).toHaveTextContent("Branch");
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    expect(screen.getByRole("treeitem", { selected: true })).toHaveTextContent("Leaf");
    fireEvent.doubleClick(screen.getByRole("treeitem", { name: /Branch/ }));
    expect(screen.getByRole("treeitem", { selected: true })).toHaveTextContent("Branch");
    expect(screen.queryByRole("treeitem", { name: /Leaf/ })).not.toBeInTheDocument();
    fireEvent.keyDown(tree, { key: "ArrowLeft" });
    expect(screen.getByRole("treeitem", { selected: true })).toHaveTextContent("$");

    await user.type(screen.getByRole("textbox", { name: "項目名を検索" }), "Leaf");
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    expect(screen.getByRole("treeitem", { selected: true })).toHaveTextContent("Leaf");
    fireEvent.keyDown(tree, { key: "ArrowLeft" });
    fireEvent.keyDown(tree, { key: "ArrowLeft" });
    expect(screen.getByRole("treeitem", { selected: true })).toHaveTextContent("$");
    expect(screen.getAllByRole("treeitem")).toHaveLength(3);
    expect(screen.getByRole("treeitem", { name: /Branch/ })).toHaveAttribute("aria-setsize", "1");

    await user.clear(screen.getByRole("textbox", { name: "項目名を検索" }));
    await user.type(screen.getByRole("textbox", { name: "項目名を検索" }), "absent");
    expect(screen.queryByRole("treeitem")).not.toBeInTheDocument();
    expect(tree).not.toHaveAttribute("aria-activedescendant");
    expect(tree.scrollTop).toBe(0);
  });

  it("highlights only the matching original graphemes and explains raw-name-only matches", async () => {
    resolveWith([sampleNodes[0]!, { ...sampleNodes[1]!, formattedValue: "前ｶﾞ後" }]);
    const user = userEvent.setup();
    render(<NrbfInspectorPage />);
    await user.click(screen.getByRole("button", { name: "ファイルを選択" }));
    await user.type(await screen.findByRole("textbox", { name: "値を検索" }), "ガ");
    const row = screen.getByRole("treeitem", { name: /Name/ });
    expect(row.querySelector("mark")).toHaveTextContent("ｶﾞ");
    expect(row.querySelector("mark")).not.toHaveTextContent("前");
    await user.clear(screen.getByRole("textbox", { name: "値を検索" }));
    await user.type(screen.getByRole("textbox", { name: "項目名を検索" }), "backingfield");
    await user.click(screen.getByRole("treeitem", { name: /Name/ }));
    expect(row.querySelector("mark")).toBeNull();
    expect(screen.getByText("Raw名")).toBeInTheDocument();
    const rawValue = screen.getByText("Raw名").nextElementSibling! as HTMLElement;
    expect(within(rawValue).getByText("BackingField", { exact: false }).tagName).toBe("MARK");
  });

  it("cancels an active parse", async () => {
    const user = userEvent.setup();
    inspectMock.mockImplementation(() => new Promise(() => undefined));
    render(<NrbfInspectorPage />);
    await user.click(screen.getByRole("button", { name: "ファイルを選択" }));
    await user.click(await screen.findByRole("button", { name: "キャンセル" }));
    expect(cancelMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "キャンセル中..." })).toBeDisabled();
  });

  it("ignores delayed events from an older operation", async () => {
    const user = userEvent.setup();
    let oldProgress: ((progress: NrbfProgress) => void) | undefined;
    inspectMock.mockImplementationOnce(async (input) => {
      oldProgress = input.onProgress;
      input.onProgress({ type: "nodes", nodes: sampleNodes });
      return summary;
    });
    render(<NrbfInspectorPage />);
    await user.click(screen.getByRole("button", { name: "ファイルを選択" }));
    await screen.findByText(/Alice/);
    inspectMock.mockImplementationOnce(() => new Promise(() => undefined));
    await user.click(screen.getByRole("button", { name: /再読込/ }));
    act(() =>
      oldProgress?.({
        type: "nodes",
        nodes: [makeNode({ id: 99, parentId: null, displayName: "stale" })],
      }),
    );
    expect(screen.queryByText("stale")).not.toBeInTheDocument();
  });
});
