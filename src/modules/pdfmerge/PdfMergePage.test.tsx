import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cancelPdfMergeOperation, pdfMergeFiles, pdfMergeInspectFiles } from "@/ipc/pdfmerge";

import { PdfMergePage } from "./PdfMergePage";

const openDialog = vi.fn();
const saveDialog = vi.fn();
const onDragDropEvent = vi.fn().mockResolvedValue(() => {});
let dragDropHandler: ((event: { payload: { type: string; paths: string[] } }) => void) | undefined;

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openDialog(...args),
  save: (...args: unknown[]) => saveDialog(...args),
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent }),
}));

vi.mock("@/ipc/pdfmerge", async () => {
  const actual = await vi.importActual<typeof import("@/ipc/pdfmerge")>("@/ipc/pdfmerge");
  return {
    ...actual,
    pdfMergeInspectFiles: vi.fn(),
    pdfMergeFiles: vi.fn(),
    cancelPdfMergeOperation: vi.fn(),
  };
});

const inspectMock = vi.mocked(pdfMergeInspectFiles);
const mergeMock = vi.mocked(pdfMergeFiles);
const cancelMock = vi.mocked(cancelPdfMergeOperation);

describe("PdfMergePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dragDropHandler = undefined;
    onDragDropEvent.mockImplementation(
      async (handler: (event: { payload: { type: string; paths: string[] } }) => void) => {
        dragDropHandler = handler;
        return () => {};
      },
    );
    openDialog.mockResolvedValue(["/docs/a.pdf", "/docs/b.pdf"]);
    saveDialog.mockResolvedValue("/docs/merged.pdf");
    inspectMock.mockResolvedValue({
      accepted: [
        { path: "/docs/a.pdf", file_name: "a.pdf", size_bytes: 1024, page_count: 2 },
        { path: "/docs/b.pdf", file_name: "b.pdf", size_bytes: 2048, page_count: 3 },
      ],
      rejected: [],
    });
    mergeMock.mockResolvedValue({
      output_path: "/docs/merged.pdf",
      total_pages: 5,
      output_bytes: 4096,
      duration_ms: 25,
    });
    cancelMock.mockResolvedValue();
  });

  it("adds multiple PDFs, reorders them, and sends the displayed order to merge", async () => {
    const user = userEvent.setup();
    render(<PdfMergePage />);

    await user.click(screen.getByRole("button", { name: "PDFを追加" }));
    expect(await screen.findByText("a.pdf")).toBeInTheDocument();
    expect(screen.getByText("b.pdf")).toBeInTheDocument();
    expect(screen.getByText("合計 5ページ")).toBeInTheDocument();

    const aRow = screen.getByText("a.pdf").closest("li")!;
    await user.click(within(aRow).getByRole("button", { name: "a.pdf を下へ移動" }));
    expect(screen.getAllByRole("listitem").map((row) => row.textContent)).toEqual([
      expect.stringContaining("b.pdf"),
      expect.stringContaining("a.pdf"),
    ]);

    await user.click(screen.getByRole("button", { name: "結合して保存" }));
    await waitFor(() => expect(mergeMock).toHaveBeenCalledTimes(1));
    expect(mergeMock.mock.calls[0]?.[0]).toMatchObject({
      inputPaths: ["/docs/b.pdf", "/docs/a.pdf"],
      outputPath: "/docs/merged.pdf",
    });
    expect(await screen.findByText(/5ページのPDFを保存しました/)).toBeInTheDocument();
    expect(screen.getByText("a.pdf")).toBeInTheDocument();
  });

  it("keeps duplicate input paths as separate rows", async () => {
    const user = userEvent.setup();
    openDialog.mockResolvedValue(["/docs/a.pdf", "/docs/a.pdf"]);
    inspectMock.mockResolvedValue({
      accepted: [
        { path: "/docs/a.pdf", file_name: "a.pdf", size_bytes: 1024, page_count: 2 },
        { path: "/docs/a.pdf", file_name: "a.pdf", size_bytes: 1024, page_count: 2 },
      ],
      rejected: [],
    });
    render(<PdfMergePage />);

    await user.click(screen.getByRole("button", { name: "PDFを追加" }));
    expect(await screen.findAllByText("a.pdf")).toHaveLength(2);
  });

  it("shows rejected files without discarding accepted files", async () => {
    const user = userEvent.setup();
    inspectMock.mockResolvedValue({
      accepted: [{ path: "/docs/a.pdf", file_name: "a.pdf", size_bytes: 1024, page_count: 2 }],
      rejected: [{ path: "/docs/locked.pdf", reason: "暗号化されたPDFには対応していません。" }],
    });
    render(<PdfMergePage />);

    await user.click(screen.getByRole("button", { name: "PDFを追加" }));
    expect(await screen.findByText("a.pdf")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("locked.pdf");
    expect(screen.getByRole("alert")).toHaveTextContent("暗号化されたPDF");
    expect(screen.getByRole("button", { name: "結合して保存" })).toBeDisabled();
  });

  it("does not start merging when the save dialog is cancelled", async () => {
    const user = userEvent.setup();
    saveDialog.mockResolvedValue(null);
    render(<PdfMergePage />);
    await user.click(screen.getByRole("button", { name: "PDFを追加" }));
    await screen.findByText("a.pdf");

    await user.click(screen.getByRole("button", { name: "結合して保存" }));
    expect(mergeMock).not.toHaveBeenCalled();
  });

  it("does not replace an operation started while the save dialog is open", async () => {
    const user = userEvent.setup();
    let resolveSave: (value: string | null) => void = () => undefined;
    saveDialog.mockImplementationOnce(
      () =>
        new Promise<string | null>((resolve) => {
          resolveSave = resolve;
        }),
    );
    render(<PdfMergePage />);
    await user.click(screen.getByRole("button", { name: "PDFを追加" }));
    await screen.findByText("a.pdf");
    await waitFor(() => expect(dragDropHandler).toBeDefined());

    await user.click(screen.getByRole("button", { name: "結合して保存" }));
    await waitFor(() => expect(saveDialog).toHaveBeenCalledTimes(1));

    inspectMock.mockImplementationOnce(() => new Promise(() => undefined));
    act(() => {
      dragDropHandler?.({
        payload: { type: "drop", paths: ["/docs/c.pdf"] },
      });
    });
    await waitFor(() => expect(inspectMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolveSave("/docs/merged.pdf");
    });

    expect(mergeMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "キャンセル" })).toBeInTheDocument();
  });

  it("accepts multiple paths from an OS file drop", async () => {
    render(<PdfMergePage />);
    await waitFor(() => expect(dragDropHandler).toBeDefined());

    act(() => {
      dragDropHandler?.({
        payload: { type: "drop", paths: ["/docs/a.pdf", "/docs/b.pdf"] },
      });
    });

    await waitFor(() =>
      expect(inspectMock).toHaveBeenCalledWith(
        expect.objectContaining({ paths: ["/docs/a.pdf", "/docs/b.pdf"] }),
      ),
    );
    expect(await screen.findByText("a.pdf")).toBeInTheDocument();
  });

  it("cancels an active inspection", async () => {
    const user = userEvent.setup();
    inspectMock.mockImplementation(() => new Promise(() => undefined));
    render(<PdfMergePage />);

    await user.click(screen.getByRole("button", { name: "PDFを追加" }));
    await user.click(await screen.findByRole("button", { name: "キャンセル" }));

    expect(cancelMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "キャンセル中..." })).toBeDisabled();
  });

  it("ignores progress that arrives late from an older operation", async () => {
    const user = userEvent.setup();
    let oldProgress: Parameters<typeof pdfMergeInspectFiles>[0]["onProgress"] | undefined;
    inspectMock.mockImplementationOnce(async (input) => {
      oldProgress = input.onProgress;
      return {
        accepted: [
          { path: "/docs/a.pdf", file_name: "a.pdf", size_bytes: 1024, page_count: 2 },
          { path: "/docs/b.pdf", file_name: "b.pdf", size_bytes: 2048, page_count: 3 },
        ],
        rejected: [],
      };
    });
    render(<PdfMergePage />);

    await user.click(screen.getByRole("button", { name: "PDFを追加" }));
    await screen.findByText("a.pdf");
    inspectMock.mockImplementationOnce(() => new Promise(() => undefined));
    openDialog.mockResolvedValueOnce(["/docs/c.pdf"]);
    await user.click(screen.getByRole("button", { name: "PDFを追加" }));
    await waitFor(() => expect(inspectMock).toHaveBeenCalledTimes(2));

    act(() => {
      oldProgress?.({
        type: "reading",
        completed_files: 1,
        total_files: 1,
        file_name: "stale.pdf",
      });
    });

    expect(screen.queryByText(/stale\.pdf/)).not.toBeInTheDocument();
  });
});
