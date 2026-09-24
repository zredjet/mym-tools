import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NRBF_CHANNEL_DRAIN_TIMEOUT_MS, type NrbfProgress, nrbfInspectFile } from "./nrbf";

const { channels, FakeChannel } = vi.hoisted(() => {
  const created: { onmessage: (progress: NrbfProgress) => void }[] = [];
  class Fake {
    onmessage: (progress: NrbfProgress) => void = () => {};
    constructor() {
      created.push(this);
    }
  }
  return { channels: created, FakeChannel: Fake };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: FakeChannel,
}));

const invokeMock = vi.mocked(invoke);

const summary = {
  path: "/data/large.bin",
  fileName: "large.bin",
  fileSizeBytes: 220_000,
  rootType: "Sample.Root",
  nodeCount: 1,
  warnings: [],
  durationMs: 3,
};

const node = {
  id: 1,
  parentId: null,
  displayName: "$",
  rawName: "$",
  kind: "object" as const,
  typeName: "Sample.Root",
  assemblyName: null,
  formattedValue: null,
  recordId: "1",
  referenceTargetId: null,
  shape: null,
};

describe("NRBF IPC", () => {
  beforeEach(() => {
    channels.length = 0;
    invokeMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for channel batches that arrive after the command response", async () => {
    // Tauriが8 KiB以上のmessageを追加IPCで取得し、command応答が先に届くケース。
    invokeMock.mockResolvedValue(summary);
    const received: NrbfProgress[] = [];
    let settled = false;

    const result = nrbfInspectFile({
      operationId: "op-1",
      path: summary.path,
      expandByteArrays: false,
      onProgress: (progress) => received.push(progress),
    }).then((value) => {
      settled = true;
      return value;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    channels[0]!.onmessage({ type: "nodes", nodes: [node] });
    channels[0]!.onmessage({ type: "done", summary });

    await expect(result).resolves.toEqual(summary);
    expect(received.map((progress) => progress.type)).toEqual(["nodes", "done"]);
  });

  it("fails instead of returning a partial tree when batches never arrive", async () => {
    vi.useFakeTimers();
    invokeMock.mockResolvedValue(summary);

    const result = nrbfInspectFile({
      operationId: "op-2",
      path: summary.path,
      expandByteArrays: false,
      onProgress: () => {},
    });
    const assertion = expect(result).rejects.toThrow("受信が完了しませんでした");
    await vi.advanceTimersByTimeAsync(NRBF_CHANNEL_DRAIN_TIMEOUT_MS);

    await assertion;
  });

  it("propagates command errors without waiting for the channel", async () => {
    invokeMock.mockRejectedValue({ code: "validation", message: { reason: "壊れています" } });

    await expect(
      nrbfInspectFile({
        operationId: "op-3",
        path: summary.path,
        expandByteArrays: false,
        onProgress: () => {},
      }),
    ).rejects.toEqual({ code: "validation", message: { reason: "壊れています" } });
  });
});
