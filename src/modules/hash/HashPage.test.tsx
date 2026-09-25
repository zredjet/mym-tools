import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cancelOperation, hashComputeFile } from "@/ipc/hash";

import { HashPage } from "./HashPage";

type DragDropHandler = (event: { payload: { type: string; paths?: string[] } }) => void;
const webview = vi.hoisted(() => ({ handler: null as DragDropHandler | null }));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (handler: DragDropHandler) => {
      webview.handler = handler;
      return Promise.resolve(() => undefined);
    },
  }),
}));
vi.mock("@/ipc/hash", () => ({
  hashComputeText: vi.fn(),
  hashComputeFile: vi.fn(),
  cancelOperation: vi.fn(),
}));

function drop(path: string) {
  webview.handler?.({ payload: { type: "drop", paths: [path] } });
}

describe("HashPage file hashing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    webview.handler = null;
    vi.mocked(cancelOperation).mockResolvedValue(undefined);
  });

  // 小さいファイルは IPC が React の effect より先に返ることがある。結果を捨てて
  // 「計算中」のまま止まらない
  it("shows the result when the hash resolves immediately", async () => {
    vi.mocked(hashComputeFile).mockResolvedValue("abc123");
    render(<HashPage />);
    await waitFor(() => expect(webview.handler).not.toBeNull());

    await act(async () => {
      drop("/tmp/small.txt");
      await Promise.resolve();
    });

    expect(await screen.findByText("abc123")).toBeInTheDocument();
    expect(screen.queryByText("計算中は変更不可")).not.toBeInTheDocument();
  });

  it("cancels the previous job when files are dropped back to back", async () => {
    vi.mocked(hashComputeFile).mockImplementation(() => new Promise(() => undefined));
    render(<HashPage />);
    await waitFor(() => expect(webview.handler).not.toBeNull());

    await act(async () => {
      drop("/tmp/first.bin");
      drop("/tmp/second.bin");
      await Promise.resolve();
    });

    const firstOperationId = vi.mocked(hashComputeFile).mock.calls[0]?.[0].operationId;
    expect(firstOperationId).toBeDefined();
    expect(cancelOperation).toHaveBeenCalledWith(firstOperationId);
  });
});
