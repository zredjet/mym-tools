import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type DirSizeProgress,
  type DirSizeScanResult,
  cancelDirSizeOperation,
  dirSizeScan,
  revealDirSizePath,
} from "@/ipc/dirsize";

import { DirSizePage } from "./DirSizePage";
import { makeNode, makeResult } from "./testNodes";

const openDialog = vi.fn();
const onDragDropEvent = vi.fn();
let dragDropHandler: ((event: { payload: { type: string; paths: string[] } }) => void) | undefined;

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openDialog(...args),
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent }),
}));

vi.mock("@/ipc/dirsize", async () => {
  const actual = await vi.importActual<typeof import("@/ipc/dirsize")>("@/ipc/dirsize");
  return {
    ...actual,
    dirSizeScan: vi.fn(),
    cancelDirSizeOperation: vi.fn(),
    revealDirSizePath: vi.fn(),
  };
});

const scanMock = vi.mocked(dirSizeScan);
const cancelMock = vi.mocked(cancelDirSizeOperation);
const revealMock = vi.mocked(revealDirSizePath);

const MIB = 1024 * 1024;

// /data
//   videos/ (logical 300 MiB, allocated 300 MiB)
//     movie.mp4
//     ほか 4 項目
//   cache/ (logical 10 MiB, allocated 400 MiB: 小さなファイルが多い)
//   notes.txt
const sample: DirSizeScanResult = makeResult([
  makeNode({
    id: 0,
    name: "/data",
    logical: 311 * MIB,
    allocated: 701 * MIB,
    file_count: 1_206,
    dir_count: 2,
  }),
  makeNode({
    id: 1,
    parent_id: 0,
    name: "videos",
    logical: 300 * MIB,
    allocated: 300 * MIB,
    file_count: 5,
    other_count: 4,
    other_logical: 50 * MIB,
    other_allocated: 50 * MIB,
  }),
  makeNode({
    id: 2,
    parent_id: 0,
    name: "cache",
    logical: 10 * MIB,
    allocated: 400 * MIB,
    file_count: 1_200,
  }),
  makeNode({ id: 3, parent_id: 0, name: "notes.txt", kind: "file", logical: MIB, allocated: MIB }),
  makeNode({
    id: 4,
    parent_id: 1,
    name: "movie.mp4",
    kind: "file",
    logical: 250 * MIB,
    allocated: 250 * MIB,
  }),
]);

function treeNames(): string[] {
  return screen
    .getAllByRole("treeitem")
    .map((item) => item.querySelector(".truncate")?.textContent ?? "");
}

async function scanFolder(result: DirSizeScanResult = sample) {
  scanMock.mockResolvedValue(result);
  openDialog.mockResolvedValue(result.root_path);
  const user = userEvent.setup();
  render(<DirSizePage />);
  await user.click(screen.getByRole("button", { name: "フォルダを選択" }));
  await screen.findByRole("tree");
  return user;
}

describe("DirSizePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dragDropHandler = undefined;
    onDragDropEvent.mockImplementation(
      async (handler: (event: { payload: { type: string; paths: string[] } }) => void) => {
        dragDropHandler = handler;
        return () => {};
      },
    );
    cancelMock.mockResolvedValue();
    revealMock.mockResolvedValue();
  });

  it("scans the chosen folder and lists children by size on disk", async () => {
    await scanFolder();

    expect(openDialog).toHaveBeenCalledWith({ multiple: false, directory: true });
    expect(scanMock).toHaveBeenCalledWith(
      expect.objectContaining({ rootPath: "/data", operationId: expect.any(String) }),
    );
    expect(treeNames()).toEqual(["/data", "cache", "videos", "notes.txt"]);
    const summary = screen.getByRole("heading", { name: "概要" }).closest("section")!;
    expect(within(summary).getByText("1,206 件")).toBeInTheDocument();
    expect(within(summary).getByText("701.0 MB")).toBeInTheDocument();
  });

  it("re-sorts by file size", async () => {
    const user = await scanFolder();
    await user.click(screen.getByRole("button", { name: "サイズ" }));
    expect(treeNames()).toEqual(["/data", "videos", "cache", "notes.txt"]);
  });

  it("expands folders and summarizes the items left out", async () => {
    const user = await scanFolder();
    const videos = screen.getByRole("treeitem", { name: /videos/ });
    await user.click(videos);
    fireEvent.keyDown(screen.getByRole("tree"), { key: "ArrowRight" });
    expect(treeNames()).toEqual([
      "/data",
      "cache",
      "videos",
      "movie.mp4",
      "ほか 4 項目",
      "notes.txt",
    ]);

    await user.click(screen.getByRole("treeitem", { name: /ほか 4 項目/ }));
    expect(screen.getByText(/上位 10,000件に入らなかった項目/)).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("tree"), { key: "ArrowLeft" });
    expect(screen.getByRole("treeitem", { selected: true })).toHaveTextContent("videos");
    fireEvent.keyDown(screen.getByRole("tree"), { key: "ArrowLeft" });
    expect(treeNames()).toEqual(["/data", "cache", "videos", "notes.txt"]);
  });

  it("reveals the selected item and scans a sub folder", async () => {
    const user = await scanFolder();
    await user.click(screen.getByRole("treeitem", { name: /cache/ }));
    expect(screen.getByText("/data/cache")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Finder で表示" }));
    expect(revealMock).toHaveBeenCalledWith("/data/cache");

    await user.click(screen.getByRole("button", { name: "このフォルダを走査" }));
    await waitFor(() =>
      expect(scanMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ rootPath: "/data/cache" }),
      ),
    );
  });

  it("scans a dropped folder", async () => {
    scanMock.mockResolvedValue(sample);
    render(<DirSizePage />);
    await waitFor(() => expect(dragDropHandler).toBeDefined());
    act(() => dragDropHandler!({ payload: { type: "drop", paths: ["/data"] } }));
    expect(await screen.findByRole("tree")).toBeInTheDocument();
    expect(scanMock).toHaveBeenCalledWith(expect.objectContaining({ rootPath: "/data" }));
  });

  it("shows progress and cancels the running scan", async () => {
    let reject: (cause: unknown) => void = () => {};
    let onProgress: (progress: DirSizeProgress) => void = () => {};
    scanMock.mockImplementation((input) => {
      onProgress = input.onProgress;
      return new Promise((_, rejectScan) => {
        reject = rejectScan;
      });
    });
    openDialog.mockResolvedValue("/data");
    const user = userEvent.setup();
    render(<DirSizePage />);
    await user.click(screen.getByRole("button", { name: "フォルダを選択" }));

    act(() =>
      onProgress({
        type: "scanning",
        files: 1234,
        dirs: 56,
        logical_bytes: 3 * MIB,
        current_dir: "/data/videos",
      }),
    );
    expect(screen.getByText("1,234 ファイル · 56 フォルダ · 3.0 MB")).toBeInTheDocument();
    expect(screen.getByText("/data/videos")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "フォルダを選択" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "キャンセル" }));
    const operationId = scanMock.mock.calls[0]![0].operationId;
    expect(cancelMock).toHaveBeenCalledWith(operationId);
    expect(screen.getByRole("button", { name: "キャンセル中..." })).toBeDisabled();

    await act(async () => reject({ code: "cancelled", message: { operation_id: operationId } }));
    expect(screen.getByRole("status")).toHaveTextContent("走査をキャンセルしました。");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the reason when the folder is rejected", async () => {
    scanMock.mockRejectedValue({
      code: "validation",
      message: {
        module_id: "dirsize",
        reason: "ネットワーク上の場所は対象外です。ローカルのフォルダを指定してください。",
      },
    });
    openDialog.mockResolvedValue("//nas/share");
    const user = userEvent.setup();
    render(<DirSizePage />);
    await user.click(screen.getByRole("button", { name: "フォルダを選択" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "ネットワーク上の場所は対象外です。ローカルのフォルダを指定してください。",
    );
    expect(screen.queryByRole("tree")).not.toBeInTheDocument();
  });

  it("explains unreadable Windows folders and the space it could not see", async () => {
    const windows = makeResult(
      [
        makeNode({ id: 0, name: "C:\\", logical: 80 * MIB, allocated: 100 * MIB, dir_count: 2 }),
        makeNode({
          id: 1,
          parent_id: 0,
          name: "Users",
          logical: 80 * MIB,
          allocated: 100 * MIB,
        }),
        makeNode({ id: 2, parent_id: 0, name: "System Volume Information", unreadable: true }),
      ],
      {
        root_path: "C:\\",
        separator: "\\",
        unreadable: { count: 3, paths: ["C:\\System Volume Information"] },
        volume: { total_bytes: 1000 * MIB, used_bytes: 600 * MIB },
      },
    );
    const user = await scanFolder(windows);

    expect(screen.getByText("ドライブの使用量")).toBeInTheDocument();
    expect(screen.getByText("500.0 MB")).toBeInTheDocument(); // 600 - 100
    expect(screen.getByText("読めないフォルダ 3 件")).toBeInTheDocument();
    expect(screen.getByText("ほか 2 件")).toBeInTheDocument();

    const locked = screen.getByRole("treeitem", { name: /System Volume Information/ });
    expect(locked).toHaveTextContent("読めない");
    expect(within(locked).getAllByText("—")).toHaveLength(2);
    await user.click(locked);
    expect(screen.getByText("復元ポイント・シャドウコピー")).toBeInTheDocument();
    expect(screen.getAllByText(/管理者権限が必要なフォルダです/).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "このフォルダを走査" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "エクスプローラーで表示" }));
    expect(revealMock).toHaveBeenCalledWith("C:\\System Volume Information");
  });

  it("virtualizes a large folder and supports arrow-key selection", async () => {
    const many = makeResult([
      makeNode({ id: 0, name: "/big", logical: 5000, allocated: 5000 }),
      ...Array.from({ length: 5000 }, (_, index) =>
        makeNode({
          id: index + 1,
          parent_id: 0,
          name: `file-${String(index).padStart(4, "0")}`,
          kind: "file",
          logical: 1,
          allocated: 1,
        }),
      ),
    ]);
    await scanFolder(many);
    const tree = screen.getByRole("tree");
    expect(screen.getAllByRole("treeitem").length).toBeLessThan(50);

    tree.focus();
    for (let index = 0; index < 40; index++) fireEvent.keyDown(tree, { key: "ArrowDown" });
    const selected = screen.getByRole("treeitem", { selected: true });
    expect(selected).toHaveTextContent("file-0039");
    expect(tree).toHaveAttribute("aria-activedescendant", selected.id);
    expect(selected).toHaveAttribute("aria-posinset", "40");
    expect(selected).toHaveAttribute("aria-setsize", "5000");
    expect(tree.scrollTop).toBe(41 * 32 - 464);

    fireEvent.keyDown(tree, { key: "End" });
    expect(screen.getByRole("treeitem", { selected: true })).toHaveTextContent("file-4999");
    expect(screen.getAllByRole("treeitem").length).toBeLessThan(50);
    fireEvent.keyDown(tree, { key: "Home" });
    expect(screen.getByRole("treeitem", { selected: true })).toHaveTextContent("/big");
  });

  it("cancels the scan when the page is closed", async () => {
    scanMock.mockReturnValue(new Promise(() => {}));
    openDialog.mockResolvedValue("/data");
    const user = userEvent.setup();
    const { unmount } = render(<DirSizePage />);
    await user.click(screen.getByRole("button", { name: "フォルダを選択" }));
    await waitFor(() => expect(scanMock).toHaveBeenCalled());
    unmount();
    expect(cancelMock).toHaveBeenCalledWith(scanMock.mock.calls[0]![0].operationId);
  });
});
