import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type PngOptProgress,
  cancelPngOptOperation,
  pngOptOptimizeFile,
  pngOptOptimizeFolder,
  pngOptScanFolder,
} from "@/ipc/pngopt";

import { defaultOutputPath, validateSettings } from "./format";
import { PngOptPage } from "./PngOptPage";

const openDialog = vi.fn();
const saveDialog = vi.fn();
const onDragDropEvent = vi.fn();
let dragDropHandler: ((event: { payload: { type: string; paths: string[] } }) => void) | undefined;

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openDialog(...args),
  save: (...args: unknown[]) => saveDialog(...args),
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent }),
}));

vi.mock("@/ipc/pngopt", async () => {
  const actual = await vi.importActual<typeof import("@/ipc/pngopt")>("@/ipc/pngopt");
  return {
    ...actual,
    pngOptOptimizeFile: vi.fn(),
    pngOptScanFolder: vi.fn(),
    pngOptOptimizeFolder: vi.fn(),
    cancelPngOptOperation: vi.fn(),
  };
});

const optimizeFileMock = vi.mocked(pngOptOptimizeFile);
const scanMock = vi.mocked(pngOptScanFolder);
const optimizeFolderMock = vi.mocked(pngOptOptimizeFolder);
const cancelMock = vi.mocked(cancelPngOptOperation);

const CLI_SETTINGS = { qualityMin: 70, qualityMax: 85, speed: 11 };

describe("PngOptPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dragDropHandler = undefined;
    onDragDropEvent.mockImplementation(
      async (handler: (event: { payload: { type: string; paths: string[] } }) => void) => {
        dragDropHandler = handler;
        return () => {};
      },
    );
    optimizeFileMock.mockResolvedValue({
      output_path: "/shots/a-optimized.png",
      status: "optimized",
      input_bytes: 4096,
      output_bytes: 1024,
      width: 320,
      height: 200,
      duration_ms: 12,
      detail: "59 colours, quality 98",
    });
    cancelMock.mockResolvedValue();
  });

  it("saves a single PNG under a new name with the shotq CLI defaults", async () => {
    const user = userEvent.setup();
    openDialog.mockResolvedValue("/shots/a.png");
    saveDialog.mockResolvedValue("/shots/a-optimized.png");
    render(<PngOptPage />);

    await user.click(screen.getByRole("button", { name: "PNGを選択" }));
    expect(await screen.findByText("/shots/a.png")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "最適化" }));

    expect(saveDialog).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "/shots/a-optimized.png" }),
    );
    expect(optimizeFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        inputPath: "/shots/a.png",
        outputPath: "/shots/a-optimized.png",
        settings: CLI_SETTINGS,
      }),
    );
    const status = await screen.findByRole("status");
    expect(within(status).getByText("最適化しました")).toBeInTheDocument();
    expect(within(status).getByText(/75%削減/)).toBeInTheDocument();
  });

  it("asks before overwriting the input and writes to the same path", async () => {
    const user = userEvent.setup();
    openDialog.mockResolvedValue("/shots/a.png");
    render(<PngOptPage />);

    await user.click(screen.getByRole("button", { name: "PNGを選択" }));
    await screen.findByText("/shots/a.png");
    await user.click(screen.getByRole("radio", { name: "元のファイルを上書き" }));
    await user.click(screen.getByRole("button", { name: "最適化" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("元のファイルを上書きしますか？")).toBeInTheDocument();
    expect(optimizeFileMock).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "上書きして最適化" }));

    await waitFor(() =>
      expect(optimizeFileMock).toHaveBeenCalledWith(
        expect.objectContaining({ inputPath: "/shots/a.png", outputPath: "/shots/a.png" }),
      ),
    );
    expect(saveDialog).not.toHaveBeenCalled();
  });

  it("does not start when the save dialog is cancelled", async () => {
    const user = userEvent.setup();
    openDialog.mockResolvedValue("/shots/a.png");
    saveDialog.mockResolvedValue(null);
    render(<PngOptPage />);

    await user.click(screen.getByRole("button", { name: "PNGを選択" }));
    await screen.findByText("/shots/a.png");
    await user.click(screen.getByRole("button", { name: "最適化" }));
    expect(optimizeFileMock).not.toHaveBeenCalled();
  });

  it("disables the run button while the settings are invalid", async () => {
    const user = userEvent.setup();
    render(<PngOptPage />);
    act(() => dragDropHandler?.({ payload: { type: "drop", paths: ["/shots/a.png"] } }));
    expect(await screen.findByText("/shots/a.png")).toBeInTheDocument();

    const min = screen.getByRole("spinbutton", { name: "品質の下限" });
    await user.clear(min);
    await user.type(min, "90");
    expect(screen.getByRole("alert")).toHaveTextContent("品質の下限は上限以下にしてください。");
    expect(screen.getByRole("button", { name: "最適化" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "既定に戻す" }));
    expect(screen.getByRole("button", { name: "最適化" })).toBeEnabled();
  });

  it("scans a folder, confirms, and shows the progress and the summary", async () => {
    const user = userEvent.setup();
    openDialog.mockResolvedValueOnce("/shots").mockResolvedValueOnce("/out");
    scanMock.mockResolvedValue({
      file_count: 3,
      input_bytes: 30000,
      conflict_count: 1,
      skipped_count: 2,
    });
    let emit: ((progress: PngOptProgress) => void) | undefined;
    let finish: (() => void) | undefined;
    optimizeFolderMock.mockImplementation(
      ({ onProgress }) =>
        new Promise((resolve) => {
          emit = onProgress;
          finish = () =>
            resolve({
              total: 3,
              optimized: 1,
              quality_too_low: 1,
              not_smaller: 0,
              failed: 1,
              input_bytes: 20000,
              output_bytes: 12000,
              duration_ms: 40,
            });
        }),
    );
    render(<PngOptPage />);

    await user.click(screen.getByRole("button", { name: "フォルダ" }));
    await user.click(screen.getByRole("button", { name: "フォルダを選択" }));
    await screen.findByText("/shots");
    expect(screen.getByRole("button", { name: "最適化" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "出力先を選択" }));
    await screen.findByText("/out");
    await user.click(screen.getByRole("button", { name: "最適化" }));

    expect(scanMock).toHaveBeenCalledWith({
      folderPath: "/shots",
      outputMode: "separate",
      outputFolder: "/out",
    });
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("3ファイルを最適化しますか？")).toBeInTheDocument();
    expect(within(dialog).getByText(/同じ名前の1/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "最適化" }));

    await waitFor(() => expect(emit).toBeDefined());
    expect(optimizeFolderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        folderPath: "/shots",
        outputMode: "separate",
        outputFolder: "/out",
        settings: CLI_SETTINGS,
      }),
    );
    act(() => {
      emit?.({ type: "started", total: 3 });
      emit?.({
        type: "file",
        index: 0,
        total: 3,
        name: "a.png",
        status: "optimized",
        input_bytes: 10000,
        output_bytes: 2000,
        detail: "",
      });
    });
    expect(screen.getByText(/1 \/ 3 ファイル · a.png/)).toBeInTheDocument();
    act(() => {
      emit?.({
        type: "file",
        index: 1,
        total: 3,
        name: "b.png",
        status: "quality_too_low",
        input_bytes: 10000,
        output_bytes: 10000,
        detail: "",
      });
      emit?.({
        type: "file",
        index: 2,
        total: 3,
        name: "c.png",
        status: "failed",
        input_bytes: 0,
        output_bytes: 0,
        detail: "PNGのヘッダーが壊れています。",
      });
      emit?.({ type: "done", duration_ms: 40 });
    });
    await act(async () => finish?.());

    const status = await screen.findByRole("status");
    expect(within(status).getByText("3ファイルを処理しました")).toBeInTheDocument();
    expect(within(status).getByText("失敗: 1")).toBeInTheDocument();
    expect(within(status).getByText(/40%削減/)).toBeInTheDocument();
    expect(within(status).getByText(/PNGのヘッダーが壊れています/)).toBeInTheDocument();
  });

  it("cancels a running folder operation", async () => {
    const user = userEvent.setup();
    openDialog.mockResolvedValueOnce("/shots");
    scanMock.mockResolvedValue({
      file_count: 2,
      input_bytes: 100,
      conflict_count: 2,
      skipped_count: 0,
    });
    let reject: ((cause: unknown) => void) | undefined;
    optimizeFolderMock.mockImplementation(
      () =>
        new Promise((_, rejectPromise) => {
          reject = rejectPromise;
        }),
    );
    render(<PngOptPage />);

    await user.click(screen.getByRole("button", { name: "フォルダ" }));
    await user.click(screen.getByRole("button", { name: "フォルダを選択" }));
    await screen.findByText("/shots");
    await user.click(screen.getByRole("radio", { name: "元のファイルを上書き" }));
    await user.click(screen.getByRole("button", { name: "最適化" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/元には戻せません/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "上書きして最適化" }));

    await user.click(await screen.findByRole("button", { name: "キャンセル" }));
    expect(cancelMock).toHaveBeenCalledTimes(1);
    const operationId = optimizeFolderMock.mock.calls[0]![0].operationId;
    expect(cancelMock).toHaveBeenCalledWith(operationId);
    await act(async () => reject?.({ code: "cancelled" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("キャンセルしました");
  });
});

describe("pngopt format helpers", () => {
  it("suggests <name>-optimized.png next to the input", () => {
    expect(defaultOutputPath("/shots/a.png")).toBe("/shots/a-optimized.png");
    expect(defaultOutputPath("C:\\shots\\B.PNG")).toBe("C:\\shots\\B-optimized.png");
    expect(defaultOutputPath("plain")).toBe("plain-optimized.png");
  });

  it("validates the CLI ranges", () => {
    expect(validateSettings({ qualityMin: 70, qualityMax: 85, speed: 11 })).toBeNull();
    expect(validateSettings({ qualityMin: 0, qualityMax: 100, speed: 1 })).toBeNull();
    expect(validateSettings({ qualityMin: 86, qualityMax: 85, speed: 11 })).not.toBeNull();
    expect(validateSettings({ qualityMin: 70, qualityMax: 101, speed: 11 })).not.toBeNull();
    expect(validateSettings({ qualityMin: Number.NaN, qualityMax: 85, speed: 11 })).not.toBeNull();
    expect(validateSettings({ qualityMin: 70, qualityMax: 85, speed: 12 })).not.toBeNull();
  });
});
