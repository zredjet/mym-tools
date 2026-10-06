import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cancelCsvViewOperation, csvviewReadFile } from "@/ipc/csvview";

import { CsvViewPage } from "./CsvViewPage";
import { createCsvSession, type CsvRequest, handleCsvRequest } from "./csvWorkerCore";

const openDialog = vi.fn();
const onDragDropEvent = vi.fn();

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openDialog(...args),
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent }),
}));

vi.mock("@/ipc/csvview", async () => {
  const actual = await vi.importActual<typeof import("@/ipc/csvview")>("@/ipc/csvview");
  return { ...actual, csvviewReadFile: vi.fn(), cancelCsvViewOperation: vi.fn() };
});

const readMock = vi.mocked(csvviewReadFile);
const cancelMock = vi.mocked(cancelCsvViewOperation);

/** 本物の解析・変換を非同期に返す Worker */
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  terminate = vi.fn();
  private session = createCsvSession();
  constructor() {
    FakeWorker.instances.push(this);
  }
  postMessage(request: CsvRequest) {
    const response = handleCsvRequest(this.session, request);
    queueMicrotask(() => this.onmessage?.({ data: response } as MessageEvent));
  }
}

async function paste(text: string) {
  vi.useFakeTimers();
  fireEvent.change(screen.getByRole("textbox", { name: "CSV を貼り付け" }), {
    target: { value: text },
  });
  await act(async () => {
    vi.advanceTimersByTime(300);
  });
  vi.useRealTimers();
}

describe("CsvViewPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    FakeWorker.instances = [];
    vi.stubGlobal("Worker", FakeWorker);
    onDragDropEvent.mockResolvedValue(() => {});
    cancelMock.mockResolvedValue();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows pasted CSV as a table and converts it to JSON", async () => {
    render(<CsvViewPage />);
    await paste('id,name\n1,"山田, 太郎"\n2,佐藤\n');

    const table = await screen.findByRole("table");
    expect(within(table).getByRole("columnheader", { name: "name" })).toBeInTheDocument();
    expect(within(table).getByRole("cell", { name: "山田, 太郎" })).toBeInTheDocument();
    expect(screen.getByText(/2 行 × 2 列/)).toBeInTheDocument();
    expect(screen.getByText(/区切り: カンマ/)).toBeInTheDocument();

    const output = await screen.findByLabelText("変換結果");
    expect(JSON.parse(output.textContent ?? "")).toEqual([
      { id: "1", name: "山田, 太郎" },
      { id: "2", name: "佐藤" },
    ]);
  });

  it("detects TSV, switches the header off and copies Markdown", async () => {
    const user = userEvent.setup();
    render(<CsvViewPage />);
    await paste("a\tb\n1\t2\n");
    await screen.findByLabelText("変換結果");

    await user.click(screen.getByRole("checkbox", { name: "1 行目を見出しにする" }));
    await user.selectOptions(screen.getByRole("combobox", { name: /^形式/ }), "markdown");
    await waitFor(() =>
      expect(screen.getByLabelText("変換結果")).toHaveTextContent("| 列1 | 列2 |"),
    );
    expect(screen.getByText(/区切り: タブ/)).toBeInTheDocument();

    // userEvent.setup() が navigator.clipboard を差し替えるので、その後で見張る
    const writeSpy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await user.click(screen.getByRole("button", { name: "コピー" }));
    expect(writeSpy).toHaveBeenCalledWith("| 列1 | 列2 |\n| --- | --- |\n| a | b |\n| 1 | 2 |\n");
    expect(await screen.findByText("コピーしました")).toBeInTheDocument();
  });

  it("shows an error for an unclosed quote", async () => {
    render(<CsvViewPage />);
    await paste('a,b\n"c,d\n');
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "2 行目で始まる引用符が閉じられていません",
    );
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("reads a file through IPC and re-reads it with another encoding", async () => {
    const user = userEvent.setup();
    openDialog.mockResolvedValue("/data/list.csv");
    readMock.mockResolvedValue({
      text: "名前,値\r\n東京,1\r\n",
      encoding: "shift_jis",
      confidence: "guess",
      bom: null,
      size: 17,
    });
    render(<CsvViewPage />);

    await user.click(screen.getByRole("button", { name: /ファイル/ }));
    await user.click(screen.getByRole("button", { name: "ファイルを選択" }));
    expect(readMock).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/data/list.csv", source: "auto" }),
    );
    expect(await screen.findByRole("cell", { name: "東京" })).toBeInTheDocument();
    expect(screen.getByText(/Shift_JIS \(CP932 相当\) \(推定\)/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "CSV を貼り付け" })).not.toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: /^文字コード/ }), "euc_jp");
    expect(readMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: "/data/list.csv", source: "euc_jp" }),
    );
  });

  it("shows the reason when a file cannot be decoded", async () => {
    const user = userEvent.setup();
    openDialog.mockResolvedValue("/data/bad.csv");
    readMock.mockRejectedValue({
      code: "validation",
      message: {
        module_id: "csvview",
        reason: "2 行目 (4 バイト目) に Shift_JIS として読めないバイト",
      },
    });
    render(<CsvViewPage />);

    await user.click(screen.getByRole("button", { name: /ファイル/ }));
    await user.click(screen.getByRole("button", { name: "ファイルを選択" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("読めないバイト");
  });

  it("stops the worker and a pending file read when the page closes", async () => {
    const user = userEvent.setup();
    openDialog.mockResolvedValue("/data/big.csv");
    readMock.mockReturnValue(new Promise(() => {}));
    const { unmount } = render(<CsvViewPage />);
    await paste("a,b\n");
    await screen.findByRole("table");

    await user.click(screen.getByRole("button", { name: /ファイル/ }));
    await user.click(screen.getByRole("button", { name: "ファイルを選択" }));
    expect(await screen.findByText("ファイルを読んでいます…")).toBeInTheDocument();
    unmount();

    expect(FakeWorker.instances[0]!.terminate).toHaveBeenCalled();
    expect(cancelMock).toHaveBeenCalledTimes(1);
  });
});
