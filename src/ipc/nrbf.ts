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

export function nrbfInspectFile(input: {
  operationId: string;
  path: string;
  onProgress: (progress: NrbfProgress) => void;
}): Promise<NrbfSummary> {
  const channel = new Channel<NrbfProgress>();
  channel.onmessage = input.onProgress;
  return invoke<NrbfSummary>("nrbf_inspect_file", {
    operationId: input.operationId,
    path: input.path,
    onProgress: channel,
  });
}

export function cancelNrbfOperation(operationId: string): Promise<void> {
  return invoke<void>("core_cancel_operation", { operationId });
}
