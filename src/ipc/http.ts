import { invoke } from "@tauri-apps/api/core";

export type HttpBodyKind = "none" | "text" | "json";

export interface HttpHeaderInput {
  name: string;
  value: string;
}

export interface HttpRequestInput {
  method: string;
  url: string;
  headers: HttpHeaderInput[];
  body_kind: HttpBodyKind;
  body: string;
  timeout_ms: number;
}

export interface HttpHeaderOutput {
  name: string;
  value: string;
}

export interface HttpResponseOutput {
  status: number;
  status_text: string;
  final_url: string;
  headers: HttpHeaderOutput[];
  body: string;
  body_kind: "text" | "binary";
  body_truncated: boolean;
  bytes_received: number;
  duration_ms: number;
}

export function sendHttpRequest(
  operationId: string,
  request: HttpRequestInput,
): Promise<HttpResponseOutput> {
  return invoke<HttpResponseOutput>("http_send_request", { operationId, request });
}

export function cancelHttpRequest(operationId: string): Promise<void> {
  return invoke<void>("core_cancel_operation", { operationId });
}
