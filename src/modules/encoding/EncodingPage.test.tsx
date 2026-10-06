import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  cancelEncodingOperation,
  encodingConvertFile,
  type EncodingConvertResult,
  encodingInspectFile,
  type EncodingInspection,
} from "@/ipc/encoding";

import { EncodingPage } from "./EncodingPage";

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

vi.mock("@/ipc/encoding", async () => {
  const actual = await vi.importActual<typeof import("@/ipc/encoding")>("@/ipc/encoding");
  return {
    ...actual,
    encodingInspectFile: vi.fn(),
    encodingConvertFile: vi.fn(),
    cancelEncodingOperation: vi.fn(),
  };
});

const inspectMock = vi.mocked(encodingInspectFile);
const convertMock = vi.mocked(encodingConvertFile);
const cancelMock = vi.mocked(cancelEncodingOperation);

const sjisInspection: EncodingInspection = {
  size: 2048,
  bom: null,
  detection: {
    encoding: "shift_jis",
    confidence: "guess",
    ascii_only: false,
    candidates: [
      { encoding: "shift_jis", ok: true, malformed_count: 0, first_error: null },
      {
        encoding: "euc_jp",
        ok: false,
        malformed_count: 3,
        first_error: { offset: 0, line: 1, bytes: "96" },
      },
    ],
  },
  encoding: "shift_jis",
  ascii_only: false,
  malformed_count: 0,
  malformed: [],
  newlines: { crlf: 2, lf: 0, cr: 0 },
  line_count: 2,
  char_count: 12,
  private_use_count: 0,
  preview: "名前,値\r\n東京,1\r\n",
  preview_truncated: false,
};

const written: EncodingConvertResult = {
  status: "written",
  source: "shift_jis",
  bytes_written: 30,
  malformed_count: 0,
  malformed: [],
  unmappable_count: 0,
  unmappable: [],
  normalized_count: 0,
  warnings: [],
  newlines: { crlf: 2, lf: 0, cr: 0 },
  duration_ms: 3,
};

describe("EncodingPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dragDropHandler = undefined;
    onDragDropEvent.mockImplementation(
      async (handler: (event: { payload: { type: string; paths: string[] } }) => void) => {
        dragDropHandler = handler;
        return () => {};
      },
    );
    inspectMock.mockResolvedValue(sjisInspection);
    convertMock.mockResolvedValue(written);
    cancelMock.mockResolvedValue();
  });

  it("inspects a chosen file and saves the conversion under a new name", async () => {
    const user = userEvent.setup();
    openDialog.mockResolvedValue("/data/list.csv");
    saveDialog.mockResolvedValue("/data/list-utf8bom.csv");
    render(<EncodingPage />);

    await user.click(screen.getByRole("button", { name: "ファイルを選択" }));
    expect(inspectMock).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/data/list.csv", source: "auto" }),
    );
    expect(await screen.findByText("(推定)")).toBeInTheDocument();
    expect(screen.getByLabelText("プレビュー")).toHaveTextContent("東京,1");

    await user.selectOptions(screen.getByRole("combobox", { name: "変換先" }), "utf8_bom");
    await user.selectOptions(screen.getByRole("combobox", { name: "改行" }), "lf");
    await user.click(screen.getByRole("button", { name: "別名で保存…" }));

    expect(saveDialog).toHaveBeenCalledWith({ defaultPath: "/data/list-utf8bom.csv" });
    expect(convertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        inputPath: "/data/list.csv",
        outputPath: "/data/list-utf8bom.csv",
        source: "auto",
        target: "utf8_bom",
        newline: "lf",
        normalizeMacSymbols: false,
      }),
    );
    expect(await screen.findByText("保存しました")).toBeInTheDocument();
  });

  it("re-inspects a dropped file with the chosen source encoding", async () => {
    const user = userEvent.setup();
    render(<EncodingPage />);
    await waitFor(() => expect(dragDropHandler).toBeDefined());

    act(() => dragDropHandler?.({ payload: { type: "drop", paths: ["/data/a.txt"] } }));
    await screen.findByText("(推定)");
    await user.selectOptions(screen.getByRole("combobox", { name: "変換元" }), "euc_jp");

    expect(inspectMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: "/data/a.txt", source: "euc_jp" }),
    );
  });

  it("disables saving when nothing would change", async () => {
    const user = userEvent.setup();
    openDialog.mockResolvedValue("/data/list.csv");
    render(<EncodingPage />);

    await user.click(screen.getByRole("button", { name: "ファイルを選択" }));
    await screen.findByText("(推定)");
    await user.selectOptions(screen.getByRole("combobox", { name: "変換先" }), "shift_jis");

    expect(screen.getByRole("button", { name: "別名で保存…" })).toBeDisabled();
    expect(screen.getByText(/変換しても内容は変わりません/)).toBeInTheDocument();
  });

  it("lists unmappable characters and suggests the Mac symbol option", async () => {
    const user = userEvent.setup();
    openDialog.mockResolvedValue("/data/memo.txt");
    saveDialog.mockResolvedValue("/data/memo-sjis.txt");
    inspectMock.mockResolvedValue({ ...sjisInspection, encoding: "utf8", detection: null });
    convertMock.mockResolvedValue({
      ...written,
      status: "rejected",
      source: "utf8",
      bytes_written: 0,
      unmappable_count: 1,
      unmappable: [{ code_point: "U+301C", char: "〜", line: 3, column: 5 }],
    });
    render(<EncodingPage />);

    await user.click(screen.getByRole("button", { name: "ファイルを選択" }));
    await screen.findByLabelText("プレビュー");
    await user.selectOptions(screen.getByRole("combobox", { name: "変換先" }), "shift_jis");
    await user.click(screen.getByRole("button", { name: "別名で保存…" }));

    expect(await screen.findByText("変換できませんでした")).toBeInTheDocument();
    expect(screen.getByText("3 行 5 文字目: 〜 (U+301C)")).toBeInTheDocument();
    expect(screen.getByText(/Mac で入力された記号が含まれています/)).toBeInTheDocument();
  });

  it("shows validation errors from the inspection", async () => {
    const user = userEvent.setup();
    openDialog.mockResolvedValue("/data/bin.dat");
    inspectMock.mockRejectedValue({
      code: "validation",
      message: { module_id: "encoding", reason: "NUL (0x00) を含むため" },
    });
    render(<EncodingPage />);

    await user.click(screen.getByRole("button", { name: "ファイルを選択" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("NUL (0x00) を含むため");
  });

  it("cancels a running inspection when the page closes", async () => {
    const user = userEvent.setup();
    openDialog.mockResolvedValue("/data/big.txt");
    inspectMock.mockReturnValue(new Promise(() => {}));
    const { unmount } = render(<EncodingPage />);

    await user.click(screen.getByRole("button", { name: "ファイルを選択" }));
    expect(await screen.findByText("判定しています…")).toBeInTheDocument();
    unmount();

    expect(cancelMock).toHaveBeenCalledTimes(1);
  });
});
