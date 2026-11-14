import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as items from "@/ipc/items";
import { vectorReadFile, vectorWriteFile } from "@/ipc/vector";
import type { Item, ItemSummary } from "@/lib/types";
import {
  installWindowCloseCoordinator,
  resetWindowCloseCoordinatorForTest,
} from "@/lib/windowClose";
import { getImportFileReader } from "./editor/assets";
import { resetImportStatus } from "./editor/assets/status";
import { getExportWriter } from "./editor/export";
import { createRect, FIRST_PAGE_ID } from "./editor/model/create";
import fixtures from "./editor/model/fixtures/payload-v2.json";
import { toPayload } from "./editor/model/payload";
import { insertNode } from "./editor/model/structure";
import { fixturePayload } from "./editor/model/testing";
import type { CanvasDocument, SvgNode, TextNode } from "./editor/model/types";
import { editorStore } from "./editor/state/store";
import { DEFAULT_VIEW_OPTIONS } from "./editor/state/types";
import { getTextEditSession, openTextEditSession } from "./editor/text/editSession";
import { fixedWidthMeasurer } from "./editor/render/testing";
import { getLastFrameSize, rememberFrameSize } from "./editor/tools/create/frameSize";
import { VectorWorkspaceRoute } from "./VectorWorkspacePage";

const native = vi.hoisted(() => ({ enabled: false, onCloseRequested: vi.fn(), close: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => native }));
const webview = vi.hoisted(() => ({ onDragDropEvent: vi.fn() }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => webview }));
const dialog = vi.hoisted(() => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => dialog);
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => native.enabled, invoke: vi.fn() }));
vi.mock("@/ipc/vector", () => ({
  vectorReadFile: vi.fn(),
  vectorReadImage: vi.fn(),
  vectorWriteFile: vi.fn(),
}));
vi.mock("@/ipc/items", () => ({
  listItemSummaries: vi.fn(),
  createItem: vi.fn(),
  updateItem: vi.fn(),
  getItem: vi.fn(),
  deleteItem: vi.fn(),
}));

class ResizeObserverStub {
  observe() {}
  disconnect() {}
}

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><text>取込</text></svg>';
const state = () => editorStore.getState();
const flush = async () => {
  await act(async () => {
    for (let n = 0; n < 8; n++) await Promise.resolve();
  });
};
const summary = (id: string, title: string): ItemSummary => ({
  id,
  project_id: "p1",
  module_id: "vector",
  title,
  tags: [],
  position: 0,
  created_at: "2026-11-15T00:00:00.000+09:00",
  updated_at: "2026-11-15T00:00:00.000+09:00",
});
const item = (id: string, title: string, payload: unknown): Item => ({
  ...summary(id, title),
  payload_schema_version: 2,
  payload,
});
/** v1 の作品を Rust の Eager-on-Read が v2 にした形 (契約データの upgrade の結果)。 */
const upgradedV1 = fixtures.upgrade.find((entry) => entry.name === "svgedit-document")!;

function addRect(id = "r1") {
  act(() =>
    state().apply((doc: CanvasDocument) =>
      insertNode(doc, createRect({ id, x: 10, y: 10, width: 40, height: 30 }), {
        kind: "page",
        id: FIRST_PAGE_ID,
      }),
    ),
  );
}

async function start(path = "/projects/p1/m/vector/new", strict = false) {
  const router = createMemoryRouter(
    [
      { path: "/projects/:projectId/m/vector/new", element: <VectorWorkspaceRoute /> },
      { path: "/projects/:projectId/m/vector/edit/:itemId", element: <VectorWorkspaceRoute /> },
      { path: "/elsewhere", element: <p>別画面</p> },
    ],
    { initialEntries: [path] },
  );
  const view = render(
    strict ? (
      <StrictMode>
        <RouterProvider router={router} />
      </StrictMode>
    ) : (
      <RouterProvider router={router} />
    ),
  );
  await flush();
  return { router, ...view };
}

const editor = () => document.querySelector("[data-canvas-editor]");
/** Cmd/Ctrl + key。`react-hotkeys-hook` は `code` で照合し、`mod` は macOS で meta、ほかで ctrl を見る */
const pressMod = (key: string) =>
  fireEvent.keyDown(document.body, {
    key,
    code: `Key${key.toUpperCase()}`,
    metaKey: true,
    ctrlKey: true,
  });
const saveButton = () => screen.getByRole("button", { name: /保存/ });

beforeEach(() => {
  resetWindowCloseCoordinatorForTest();
  resetImportStatus();
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  native.enabled = false;
  native.onCloseRequested.mockResolvedValue(vi.fn());
  native.close.mockResolvedValue(undefined);
  webview.onDragDropEvent.mockResolvedValue(vi.fn());
  vi.mocked(items.listItemSummaries).mockResolvedValue([]);
  vi.mocked(items.createItem).mockResolvedValue("created");
  vi.mocked(items.updateItem).mockResolvedValue(undefined as never);
  vi.mocked(items.deleteItem).mockResolvedValue(undefined);
  dialog.open.mockResolvedValue(null);
  dialog.save.mockResolvedValue(null);
  state().setViewport({ x: 0, y: 0, zoom: 1 });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("読み込み", () => {
  it("v2 の作品を文書にしてエディタで開く", async () => {
    const payload = fixturePayload("full");
    vi.mocked(items.listItemSummaries).mockResolvedValue([summary("a1", "既存")]);
    vi.mocked(items.getItem).mockResolvedValue({
      ...item("a1", "既存", payload),
      tags: ["ui", "案"],
    });
    await start("/projects/p1/m/vector/edit/a1");
    expect(editor()).not.toBeNull();
    expect(screen.getByLabelText("タイトル")).toHaveValue("既存");
    expect(screen.getByLabelText("タグ")).toHaveValue("ui, 案");
    expect(screen.getByLabelText("作品を切り替え")).toHaveValue("a1");
    expect(Object.keys(state().doc.nodes).sort()).toEqual(Object.keys(payload.nodes).sort());
    expect(state().revision).toBe(0);
    expect(screen.getByText("保存済み")).toBeVisible();
  });

  it("v1 から変換された作品 (埋め込み SVG 1 個) を開ける", async () => {
    vi.mocked(items.getItem).mockResolvedValue(item("old", "古い作品", upgradedV1.v2));
    await start("/projects/p1/m/vector/edit/old");
    expect(editor()).not.toBeNull();
    const node = state().doc.nodes["legacy"] as SvgNode;
    expect(node.type).toBe("svg");
    expect(state().doc.assets[node.assetId]).toMatchObject({
      kind: "svg",
      svg: upgradedV1.v1.svg,
    });
  });

  it("読めない payload はエラーを出し、エディタを出さず、保存させない", async () => {
    vi.mocked(items.getItem).mockResolvedValue(
      item("bad", "壊れた作品", { svg: "<svg/>", text: "" }),
    );
    await start("/projects/p1/m/vector/edit/bad");
    expect(screen.getByRole("alert")).toHaveTextContent("この作品は読み込めません");
    expect(editor()).toBeNull();
    expect(saveButton()).toBeDisabled();
    expect(screen.getByLabelText("タイトル")).toHaveValue("壊れた作品");
    // 新規と削除はできる
    expect(screen.getByRole("button", { name: "新規" })).toBeEnabled();
    expect(screen.getByRole("button", { name: /削除/ })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "新規" }));
    expect(editor()).not.toBeNull();
    expect(items.updateItem).not.toHaveBeenCalled();
  });

  it("v1 から変換できなかった作品は、理由を出して開かない", async () => {
    vi.mocked(items.listItemSummaries).mockResolvedValue([summary("broken", "古い作品")]);
    vi.mocked(items.getItem).mockRejectedValue({
      code: "payload_upgrade_failed",
      message: { module_id: "vector", reason: "変換した文書が検証を通りません: script" },
    });
    await start("/projects/p1/m/vector/edit/broken");
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("新しい形式に変換できないため開けません");
    expect(alert).toHaveTextContent("元のデータは変えずに残しています");
    expect(alert).toHaveTextContent("検証を通りません: script");
    expect(editor()).toBeNull();
    expect(screen.getByRole("button", { name: "再試行" })).toBeVisible();
    // 新しい作品の既定のタイトルではなく、一覧のタイトルを出す
    expect(screen.getByLabelText("タイトル")).toHaveValue("古い作品");
    expect(saveButton()).toBeDisabled();
  });

  it("StrictMode でも 1 回だけ開き、新規では作品を読まない", async () => {
    await start(undefined, true);
    expect(items.getItem).not.toHaveBeenCalled();
    expect(items.listItemSummaries).toHaveBeenCalledWith({ projectId: "p1", moduleId: "vector" });
    expect(editor()).not.toBeNull();
    expect(screen.getByLabelText("タイトル")).toHaveValue("新しいキャンバス");
    expect(Object.keys(state().doc.nodes)).toEqual([]);
  });

  it("開くたびに、フレームの大きさと表示の設定と表示位置を既定へ戻す", async () => {
    rememberFrameSize({ width: 24, height: 24 });
    state().setView({ grid: true, rulers: false });
    state().setViewport({ x: 300, y: 200, zoom: 3 });
    await start();
    expect(getLastFrameSize()).toEqual({ width: 393, height: 852 });
    expect(state().view).toEqual(DEFAULT_VIEW_OPTIONS);
    expect(state().viewport).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it("URL の作品を、新規の後に開き直せる", async () => {
    vi.mocked(items.listItemSummaries).mockResolvedValue([summary("a1", "既存")]);
    vi.mocked(items.getItem).mockResolvedValue(item("a1", "既存", fixturePayload("empty")));
    const { router } = await start("/projects/p1/m/vector/edit/a1");
    fireEvent.click(screen.getByRole("button", { name: "新規" }));
    expect(screen.getByLabelText("タイトル")).toHaveValue("新しいキャンバス");
    await act(() => router.navigate("/projects/p1/m/vector/edit/a1"));
    await flush();
    expect(items.getItem).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText("タイトル")).toHaveValue("既存");
    expect(screen.getByLabelText("作品を切り替え")).toHaveValue("a1");
  });
});

describe("保存", () => {
  it("文書を payload v2 にして保存し、保存した時点の revision と比べる", async () => {
    await start();
    addRect();
    expect(screen.getByText("未保存", { exact: true })).toBeVisible();
    const expected = toPayload(state().doc);
    fireEvent.click(saveButton());
    await flush();
    expect(items.createItem).toHaveBeenCalledWith({
      moduleId: "vector",
      projectId: "p1",
      title: "新しいキャンバス",
      tags: [],
      payload: expected,
    });
    expect(screen.getByText("保存済み")).toBeVisible();
    expect(screen.getByText("保存しました")).toBeVisible();
    // 2 回目は更新
    addRect("r2");
    pressMod("s");
    await flush();
    expect(items.updateItem).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: "created", moduleId: "vector" }),
    );
  });

  it("保存の途中の編集は、次の未保存の内容として残す", async () => {
    await start();
    let finish!: (id: string) => void;
    vi.mocked(items.createItem).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    addRect();
    fireEvent.click(saveButton());
    await flush();
    addRect("r2");
    fireEvent.change(screen.getByLabelText("タイトル"), { target: { value: "保存中に追加編集" } });
    await act(async () => finish("created"));
    await flush();
    const saved = vi.mocked(items.createItem).mock.calls[0]![0];
    expect(Object.keys((saved.payload as { nodes: object }).nodes)).toEqual(["r1"]);
    expect(saved.title).toBe("新しいキャンバス");
    expect(screen.getByText("未保存", { exact: true })).toBeVisible();
    expect(screen.getByLabelText("タイトル")).toHaveValue("保存中に追加編集");
  });

  it("本文の編集と進行中のジェスチャーを確定してから保存する", async () => {
    vi.mocked(items.getItem).mockResolvedValue(item("a1", "既存", fixturePayload("full")));
    await start("/projects/p1/m/vector/edit/a1");
    const textId = Object.values(state().doc.nodes).find((node) => node.type === "text")!.id;
    act(() => {
      state().startTextEdit(textId);
      openTextEditSession(editorStore, textId, fixedWidthMeasurer()).setText("打ちかけ");
    });
    expect(state().revision).toBe(0);
    expect(screen.getByText("未保存", { exact: true })).toBeVisible();
    pressMod("s");
    await flush();
    const saved = vi.mocked(items.updateItem).mock.calls[0]![0];
    const nodes = (saved.payload as { nodes: Record<string, TextNode> }).nodes;
    expect(nodes[textId]!.text).toBe("打ちかけ");
    expect(state().editingTextId).toBeNull();
    expect(getTextEditSession()).toBeNull();
    expect(state().gestureActive).toBe(false);
    expect(screen.getByText("保存済み")).toBeVisible();

    // 色の選択のように長く開くジェスチャーも、保存の前に確定する
    act(() => {
      state().beginGesture();
      state().updateGesture((doc) =>
        insertNode(doc, createRect({ id: "g1" }), { kind: "page", id: FIRST_PAGE_ID }),
      );
    });
    fireEvent.click(saveButton());
    await flush();
    const second = vi.mocked(items.updateItem).mock.calls[1]![0];
    expect((second.payload as { nodes: object }).nodes).toHaveProperty("g1");
    expect(state().gestureActive).toBe(false);
    expect(screen.getByText("保存済み")).toBeVisible();
  });

  it("保存できない文書は保存せず、理由を出す", async () => {
    await start();
    act(() =>
      state().apply((doc) => ({
        ...doc,
        nodes: { ...doc.nodes, ghost: createRect({ id: "ghost" }) },
      })),
    );
    fireEvent.click(saveButton());
    await flush();
    expect(items.createItem).not.toHaveBeenCalled();
    expect(screen.getByText(/保存できません/)).toBeVisible();
  });
});

describe("未保存の確認", () => {
  it("新規の前に確かめ、戻れば文書を残す", async () => {
    await start();
    addRect();
    fireEvent.click(screen.getByRole("button", { name: "新規" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("未保存の変更を破棄しますか？");
    fireEvent.click(screen.getByRole("button", { name: "戻る" }));
    expect(state().doc.nodes).toHaveProperty("r1");
    pressMod("n");
    fireEvent.click(screen.getByRole("button", { name: "続行" }));
    expect(state().doc.nodes).not.toHaveProperty("r1");
    expect(state().revision).toBe(0);
    expect(screen.getByText("保存済み")).toBeVisible();
  });

  it("本文の編集中は、確定してから未保存を確かめる", async () => {
    vi.mocked(items.getItem).mockResolvedValue(item("a1", "既存", fixturePayload("full")));
    await start("/projects/p1/m/vector/edit/a1");
    const textId = Object.values(state().doc.nodes).find((node) => node.type === "text")!.id;
    act(() => {
      state().startTextEdit(textId);
      openTextEditSession(editorStore, textId, fixedWidthMeasurer()).setText("変更");
    });
    fireEvent.click(screen.getByRole("button", { name: "新規" }));
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(state().editingTextId).toBeNull();
    expect((state().doc.nodes[textId] as TextNode).text).toBe("変更");
  });

  it("モーダルが開いている間は、キャンバスがキーを取らない", async () => {
    await start();
    addRect();
    act(() => state().setSelection(["r1"]));
    fireEvent.click(screen.getByRole("button", { name: "新規" }));
    expect(screen.getByRole("dialog")).toBeVisible();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Delete" });
    fireEvent.keyDown(document.body, { key: "Backspace" });
    fireEvent.keyDown(document.body, { key: "r" });
    expect(state().doc.nodes).toHaveProperty("r1");
    expect(state().toolId).toBe("select");
    // 閉じれば効く
    fireEvent.click(screen.getByRole("button", { name: "戻る" }));
    fireEvent.keyDown(document.body, { key: "Delete" });
    expect(state().doc.nodes).not.toHaveProperty("r1");
  });

  it("作品の切替と画面の移動は、未保存なら止めて確かめる", async () => {
    vi.mocked(items.listItemSummaries).mockResolvedValue([summary("a1", "既存")]);
    const { router } = await start();
    addRect();
    fireEvent.change(screen.getByLabelText("作品を切り替え"), { target: { value: "a1" } });
    await flush();
    expect(screen.getByRole("dialog")).toHaveTextContent("未保存の変更を破棄して移動しますか？");
    fireEvent.click(screen.getByRole("button", { name: "戻る" }));
    expect(items.getItem).not.toHaveBeenCalled();
    await act(async () => {
      void router.navigate("/elsewhere");
    });
    expect(screen.getByRole("dialog")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "続行" }));
    await flush();
    expect(screen.getByText("別画面")).toBeVisible();
    // 画面を離れたら作品を store から外す
    expect(Object.keys(state().doc.nodes)).toEqual([]);
  });

  it("ウィンドウを閉じる要求を、未保存のときだけ止める", async () => {
    native.enabled = true;
    const uninstall = installWindowCloseCoordinator();
    await start();
    const handler = native.onCloseRequested.mock.calls[0]![0];
    const event = { preventDefault: vi.fn() };
    await act(async () => {
      await handler(event);
    });
    expect(event.preventDefault).not.toHaveBeenCalled();
    addRect();
    await act(async () => {
      await handler(event);
    });
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(screen.getByRole("dialog")).toHaveTextContent("ウィンドウを閉じますか？");
    fireEvent.click(screen.getByRole("button", { name: "続行" }));
    expect(native.close).toHaveBeenCalledOnce();
    uninstall();
  });

  it("削除は確かめてから行い、新しい作品を開く", async () => {
    vi.mocked(items.getItem).mockResolvedValue(item("a1", "既存", fixturePayload("full")));
    await start("/projects/p1/m/vector/edit/a1");
    fireEvent.click(screen.getByRole("button", { name: /削除/ }));
    expect(screen.getByRole("dialog")).toHaveTextContent("この作品を削除しますか？");
    fireEvent.click(screen.getByRole("button", { name: "続行" }));
    await flush();
    expect(items.deleteItem).toHaveBeenCalledWith({ moduleId: "vector", itemId: "a1" });
    expect(screen.getByLabelText("タイトル")).toHaveValue("新しいキャンバス");
    expect(Object.keys(state().doc.nodes)).toEqual([]);
  });
});

describe("取込と書き出し", () => {
  it("ファイルを読む関数と書き出す関数を登録し、画面を離れたら外す", async () => {
    const { unmount } = await start();
    expect(getImportFileReader()).not.toBeNull();
    expect(getExportWriter()).not.toBeNull();
    dialog.save.mockResolvedValueOnce("/out/ページ 1.svg");
    await getExportWriter()!([{ fileName: "ページ 1.svg", format: "svg", data: "<svg/>" }]);
    expect(vectorWriteFile).toHaveBeenCalledWith("/out/ページ 1.svg", "svg", "<svg/>");
    unmount();
    expect(getImportFileReader()).toBeNull();
    expect(getExportWriter()).toBeNull();
  });

  it("作品バーの「取込」は、今の作品に SVG を置き、draw.io の変換を知らせる", async () => {
    await start();
    dialog.open.mockResolvedValueOnce("/tmp/図.svg");
    vi.mocked(vectorReadFile).mockResolvedValueOnce({
      svg: SVG,
      text: "取込",
      notices: ["HTML のラベル 2 件を通常のテキストに置き換えました。"],
    });
    fireEvent.click(screen.getByRole("button", { name: /取込/ }));
    await flush();
    const placed = Object.values(state().doc.nodes);
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatchObject({ type: "svg", name: "図" });
    expect(state().selection).toEqual([placed[0]!.id]);
    expect(screen.getByText(/HTML のラベル 2 件/)).toBeVisible();
    expect(screen.getByText("未保存", { exact: true })).toBeVisible();
  });

  it("取込の途中は作品を切り替えない", async () => {
    await start();
    let choose!: (path: string | null) => void;
    dialog.open.mockReturnValueOnce(
      new Promise((resolve) => {
        choose = resolve;
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /取込/ }));
    await flush();
    expect(screen.getByRole("button", { name: "新規" })).toBeDisabled();
    expect(screen.getByLabelText("作品を切り替え")).toBeDisabled();
    pressMod("n");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("取り込みが終わるまでお待ちください。")).toBeVisible();
    await act(async () => choose(null));
    await flush();
    expect(screen.getByRole("button", { name: "新規" })).toBeEnabled();
  });

  it("OS からドロップしたファイルを今の作品に置く", async () => {
    native.enabled = true;
    await start();
    const listener = webview.onDragDropEvent.mock.calls[0]![0];
    vi.mocked(vectorReadFile).mockResolvedValueOnce({ svg: SVG, text: "取込", notices: [] });
    act(() =>
      listener({ payload: { type: "enter", paths: ["/tmp/a.svg"], position: { x: 1, y: 1 } } }),
    );
    act(() =>
      listener({ payload: { type: "drop", paths: ["/tmp/a.svg"], position: { x: 1, y: 1 } } }),
    );
    await flush();
    expect(vectorReadFile).toHaveBeenCalledWith("/tmp/a.svg");
    expect(Object.values(state().doc.nodes)).toEqual([
      expect.objectContaining({ type: "svg", name: "a" }),
    ]);
  });

  it("ドロップしたファイルが読めなければ、理由を知らせて文書を変えない", async () => {
    native.enabled = true;
    await start();
    const listener = webview.onDragDropEvent.mock.calls[0]![0];
    vi.mocked(vectorReadFile).mockRejectedValueOnce({
      code: "validation",
      message: { module_id: "vector", reason: "未対応のSVG要素です: script" },
    });
    act(() =>
      listener({ payload: { type: "drop", paths: ["/tmp/x.svg"], position: { x: 1, y: 1 } } }),
    );
    await flush();
    expect(screen.getByText(/ファイルを読み込めません: 未対応のSVG要素です: script/)).toBeVisible();
    expect(Object.keys(state().doc.nodes)).toEqual([]);
    expect(state().revision).toBe(0);
  });
});
