import { Channel, invoke } from "@tauri-apps/api/core";

export type NrbfNodeKind = "object" | "array" | "scalar" | "null" | "reference" | "unsupported";

export interface NrbfNode {
  id: number;
  parentId: number | null;
  displayName: string;
  rawName: string;
  kind: NrbfNodeKind;
  typeName: string | null;
  assemblyName: string | null;
  formattedValue: string | null;
  recordId: string | null;
  referenceTargetId: number | null;
  shape: number[] | null;
}

export interface NrbfSummary {
  path: string;
  fileName: string;
  fileSizeBytes: number;
  rootType: string | null;
  nodeCount: number;
  warnings: string[];
  durationMs: number;
}

export type NrbfProgress =
  | { type: "started"; fileSizeBytes: number }
  | { type: "nodes"; nodes: NrbfNode[] }
  | { type: "done"; summary: NrbfSummary }
  | { type: "cancelled" };

/** command応答後、`done`イベントの配送を待つ上限。超えたら結果を確定せずエラーにする。 */
export const NRBF_CHANNEL_DRAIN_TIMEOUT_MS = 30_000;

/**
 * NRBFファイルを解析し、全ノードbatchの配送が終わってから結果を返す。
 *
 * Tauriは8 KiB以上のChannel messageを追加のIPC取得で配送するため、command応答が
 * nodes batchより先に届くことがある。ChannelはRust側の送信順に配送するので、
 * 最後に送られる`done`の到着をもって全nodes batchの配送完了とみなす。
 */
export async function nrbfInspectFile(input: {
  operationId: string;
  path: string;
  expandByteArrays: boolean;
  onProgress: (progress: NrbfProgress) => void;
}): Promise<NrbfSummary> {
  let markDelivered: () => void = () => {};
  const delivered = new Promise<void>((resolve) => {
    markDelivered = resolve;
  });
  const channel = new Channel<NrbfProgress>();
  channel.onmessage = (progress) => {
    input.onProgress(progress);
    if (progress.type === "done") markDelivered();
  };
  const summary = await invoke<NrbfSummary>("nrbf_inspect_file", {
    operationId: input.operationId,
    path: input.path,
    expandByteArrays: input.expandByteArrays,
    onProgress: channel,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      delivered,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("NRBF解析結果の受信が完了しませんでした。再読込してください。")),
          NRBF_CHANNEL_DRAIN_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  return summary;
}

export function cancelNrbfOperation(operationId: string): Promise<void> {
  return invoke<void>("core_cancel_operation", { operationId });
}
