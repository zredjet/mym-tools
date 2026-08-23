import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { sendHttpRequest } from "@/ipc/http";
import { A11yPage } from "@/modules/a11y/A11yPage";
import { CodecPage } from "@/modules/codec/CodecPage";
import { CronPage } from "@/modules/cron/CronPage";
import { DateTimePage } from "@/modules/datetime/DateTimePage";
import { HttpPage } from "@/modules/http/HttpPage";
import { IdGeneratorPage } from "@/modules/idgen/IdGeneratorPage";
import { JwtPage } from "@/modules/jwt/JwtPage";
import { RegexPage } from "@/modules/regex/RegexPage";
import { SecretGeneratorPage } from "@/modules/secretgen/SecretGeneratorPage";
import { TextDiffPage } from "@/modules/textdiff/TextDiffPage";
import { UrlQueryPage } from "@/modules/urlquery/UrlQueryPage";

vi.mock("@/ipc/http", () => ({
  sendHttpRequest: vi.fn(),
  cancelHttpRequest: vi.fn().mockResolvedValue(undefined),
}));

class ImmediateWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  terminate = vi.fn();

  postMessage(message: { id: number; input: Record<string, unknown> }) {
    const result =
      "pattern" in message.input
        ? { matches: [], replacement: "worker-ok" }
        : [{ value: "changed", added: true }];
    this.onmessage?.({ data: { id: message.id, result } } as MessageEvent);
  }
}

describe("stateless developer tool pages", () => {
  beforeEach(() => {
    vi.stubGlobal("Worker", ImmediateWorker);
    vi.mocked(sendHttpRequest).mockResolvedValue({
      status: 200,
      status_text: "OK",
      final_url: "https://example.com/",
      headers: [{ name: "content-type", value: "application/json" }],
      body: '{"ok":true}',
      body_kind: "text",
      body_truncated: false,
      bytes_received: 11,
      duration_ms: 12,
    });
  });

  it("converts codec input", () => {
    render(<CodecPage />);
    fireEvent.change(screen.getAllByRole("textbox")[0]!, { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "変換" }));
    expect(screen.getAllByRole("textbox")[1]).toHaveValue("aGVsbG8=");
  });

  it("decomposes a URL without losing duplicate query keys", () => {
    render(<UrlQueryPage />);
    fireEvent.click(screen.getByRole("button", { name: "分解" }));
    expect(screen.getByLabelText("query key 1")).toHaveValue("foo");
    expect(screen.getByLabelText("query key 2")).toHaveValue("foo");
  });

  it("converts Unix epoch timestamps", () => {
    render(<DateTimePage />);
    fireEvent.change(screen.getAllByRole("textbox")[0]!, { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "変換" }));
    expect(screen.getByText(/1970-01-01T00:00:00/)).toBeInTheDocument();
  });

  it("generates IDs", () => {
    render(<IdGeneratorPage />);
    fireEvent.click(screen.getByRole("button", { name: "生成" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(10);
  });

  it("generates a secret without persistence", () => {
    render(<SecretGeneratorPage />);
    fireEvent.click(screen.getByRole("button", { name: "生成" }));
    expect(screen.queryByText("—")).not.toBeInTheDocument();
  });

  it("evaluates a regex through a worker", () => {
    render(<RegexPage />);
    fireEvent.click(screen.getByRole("button", { name: "評価" }));
    expect(screen.getByText("worker-ok")).toBeInTheDocument();
  });

  it("computes a text diff through a worker", () => {
    render(<TextDiffPage />);
    fireEvent.click(screen.getByRole("button", { name: "比較" }));
    expect(screen.getByText("changed")).toBeInTheDocument();
  });

  it("decodes a JWT while showing the unverified warning", () => {
    render(<JwtPage />);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "eyJhbGciOiJub25lIn0.eyJzdWIiOiIxMjMifQ.sig" },
    });
    fireEvent.click(screen.getByRole("button", { name: "解析" }));
    expect(screen.getByText(/"sub": "123"/)).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent("未検証");
  });

  it("builds upcoming Cron occurrences", () => {
    render(<CronPage />);
    fireEvent.click(screen.getByRole("button", { name: "次回を計算" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(10);
  });

  it("evaluates WCAG contrast", () => {
    render(<A11yPage />);
    fireEvent.click(screen.getByRole("button", { name: "判定" }));
    expect(screen.getByText(/プレビュー — \d+\.\d{2}:1/)).toBeInTheDocument();
  });

  it("sends HTTP requests through the IPC boundary", async () => {
    render(<HttpPage />);
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    expect(await screen.findByText("200 OK")).toBeInTheDocument();
    expect(sendHttpRequest).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ method: "GET", url: "https://example.com" }),
    );
  });
});
