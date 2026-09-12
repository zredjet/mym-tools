import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as items from "@/ipc/items";
import { vectorEditorUrl } from "@/ipc/vector";
import { VectorWorkspaceRoute } from "./VectorWorkspacePage";
const native = vi.hoisted(() => ({ enabled: false, onCloseRequested: vi.fn(), close: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => native }));
const dialog = vi.hoisted(() => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@/ipc/vector", () => ({
  vectorEditorUrl: vi.fn(),
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
vi.mock("@tauri-apps/plugin-dialog", () => dialog);
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => native.enabled }));
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><text>作品</text></svg>';
const flush = async () => {
  await act(async () => {
    for (let n = 0; n < 8; n++) await Promise.resolve();
  });
};
async function start(strict = false) {
  const router = createMemoryRouter(
    [
      { path: "/projects/:projectId/m/vector/new", element: <VectorWorkspaceRoute /> },
      { path: "/elsewhere", element: <p>別画面</p> },
    ],
    { initialEntries: ["/projects/p1/m/vector/new"] },
  );
  render(
    strict ? (
      <StrictMode>
        <RouterProvider router={router} />
      </StrictMode>
    ) : (
      <RouterProvider router={router} />
    ),
  );
  await flush();
  const iframe = screen.getByTitle("SVG-Edit オフラインエディタ") as HTMLIFrameElement;
  const session = new URLSearchParams(new URL(iframe.src).hash.slice(1)).get("session");
  const post = vi.spyOn(iframe.contentWindow!, "postMessage");
  const send = (value: object) =>
    act(() =>
      window.dispatchEvent(
        new MessageEvent("message", {
          source: iframe.contentWindow,
          origin: "http://127.0.0.1:4567",
          data: { protocol: "mym-vector-v1", session, ...value },
        }),
      ),
    );
  send({ event: "ready" });
  await flush();
  const load = post.mock.calls[post.mock.calls.length - 1]![0];
  send({ ...load, event: "loaded", revision: 0 });
  await flush();
  return { router, post, send, documentId: load.documentId };
}
beforeEach(() => {
  vi.useFakeTimers();
  native.enabled = false;
  native.onCloseRequested.mockResolvedValue(vi.fn());
  native.close.mockResolvedValue(undefined);
  vi.mocked(items.listItemSummaries).mockResolvedValue([]);
  vi.mocked(items.createItem).mockResolvedValue("created");
  vi.mocked(vectorEditorUrl).mockResolvedValue("http://127.0.0.1:4567/index.html");
  dialog.open.mockResolvedValue(null);
  dialog.save.mockResolvedValue(null);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
describe("Vector workspace lifecycle", () => {
  it("initializes once after StrictMode cleanup and uses metadata lists", async () => {
    const { post } = await start(true);
    expect(post.mock.calls.filter(([m]) => m.action === "load")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "保存" })).toBeEnabled();
    expect(items.getItem).not.toHaveBeenCalled();
    expect(items.listItemSummaries).toHaveBeenCalledWith({ projectId: "p1", moduleId: "vector" });
  });
  it("persists only the requested snapshot and retains edits made during save", async () => {
    const { post, send, documentId } = await start();
    let finish!: (id: string) => void;
    vi.mocked(items.createItem).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    send({ event: "changed", documentId, revision: 1 });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await flush();
    const packet = post.mock.calls[post.mock.calls.length - 1]![0];
    send({ ...packet, event: "snapshot", svg, text: "作品", revision: 1 });
    await flush();
    send({ event: "changed", documentId, revision: 2 });
    fireEvent.change(screen.getByLabelText("タイトル"), { target: { value: "保存中に追加編集" } });
    await act(async () => finish("created"));
    await flush();
    expect(items.createItem).toHaveBeenCalledWith(
      expect.objectContaining({ title: "新しいベクター描画", payload: { svg, text: "作品" } }),
    );
    expect(screen.getByText("未保存", { exact: true })).toBeVisible();
    expect(screen.getByLabelText("タイトル")).toHaveValue("保存中に追加編集");
  });
  it("ignores shortcut requests from a different document", async () => {
    const { post, send, documentId } = await start();
    send({ event: "action", documentId: "old-document", action: "save" });
    send({ event: "action", action: "save" });
    await flush();
    expect(post).toHaveBeenCalledTimes(1);
    send({ event: "action", documentId, action: "save" });
    await flush();
    const packet = post.mock.calls[post.mock.calls.length - 1]![0];
    expect(packet.action).toBe("snapshot");
    send({ ...packet, event: "snapshot", svg, revision: 0 });
    await flush();
    expect(items.createItem).toHaveBeenCalledOnce();
  });
  it("releases save locks after timeout and retries without accepting stale replies", async () => {
    const { post, send } = await start();
    const save = screen.getByRole("button", { name: "保存" });
    fireEvent.click(save);
    await flush();
    const old = post.mock.calls[post.mock.calls.length - 1]![0];
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(save).toBeEnabled();
    expect(screen.getByRole("alert")).toHaveTextContent("タイムアウト");
    fireEvent.click(save);
    await flush();
    send({ ...old, event: "snapshot", svg, revision: 0 });
    await flush();
    expect(items.createItem).not.toHaveBeenCalled();
    send({
      ...post.mock.calls[post.mock.calls.length - 1]![0],
      event: "snapshot",
      svg,
      revision: 0,
    });
    await flush();
    expect(items.createItem).toHaveBeenCalledTimes(1);
    expect(save).toBeEnabled();
  });
  it("keeps a native close listener across dirty and busy transitions", async () => {
    native.enabled = true;
    const { send, documentId, post } = await start();
    const handler = native.onCloseRequested.mock.calls[0]![0];
    const event = { preventDefault: vi.fn() };
    act(() => handler(event));
    expect(event.preventDefault).not.toHaveBeenCalled();
    send({ event: "changed", documentId, revision: 1 });
    act(() => handler(event));
    expect(event.preventDefault).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "戻る" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await flush();
    send({
      ...post.mock.calls[post.mock.calls.length - 1]![0],
      event: "snapshot",
      svg,
      revision: 1,
    });
    await flush();
    expect(native.onCloseRequested).toHaveBeenCalledOnce();
    send({ event: "changed", documentId, revision: 2 });
    act(() => handler(event));
    fireEvent.click(screen.getByRole("button", { name: "続行" }));
    expect(native.close).toHaveBeenCalledOnce();
  });
  it("preserves the document when a file dialog or unsaved navigation is cancelled", async () => {
    const { post, send, documentId, router } = await start();
    fireEvent.click(screen.getByRole("button", { name: "SVGを取り込む" }));
    await flush();
    expect(post).toHaveBeenCalledTimes(1);
    send({ event: "changed", documentId, revision: 1 });
    await act(async () => {
      void router.navigate("/elsewhere");
    });
    expect(screen.getByRole("dialog")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "戻る" }));
    expect(screen.getByText("未保存", { exact: true })).toBeVisible();
    expect(screen.queryByText("別画面")).toBeNull();
  });
});
