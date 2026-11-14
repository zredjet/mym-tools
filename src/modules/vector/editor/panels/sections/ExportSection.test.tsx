import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { exportDocument } from "../../export/testing";
import type { ExportWriter } from "../../export/types";
import { setExportWriter } from "../../export/writer";
import { editorStore } from "../../state/store";
import { ExportSection } from "./ExportSection";

const state = () => editorStore.getState();
const exportButton = () => screen.getByRole("button", { name: /を書き出す/ });

beforeEach(() => {
  state().load(exportDocument());
});

afterEach(() => {
  setExportWriter(null);
});

describe("ExportSection", () => {
  it("登録がない間はボタンを無効にし、登録されたら有効にする", () => {
    render(<ExportSection />);
    expect(exportButton()).toBeDisabled();
    act(() => {
      setExportWriter(async (files) => ({ written: files.length }));
    });
    expect(exportButton()).toBeEnabled();
  });

  it("何を書き出すかを表示する", () => {
    render(<ExportSection />);
    expect(screen.getByText(/ページ全体を 1 ファイルに/)).toBeInTheDocument();
    act(() => state().setSelection(["fa", "fb"]));
    expect(screen.getByText(/フレーム 2 個を 1 個ずつのファイルに/)).toBeInTheDocument();
    act(() => state().setSelection(["fn"]));
    expect(screen.getByText(/フレームを 1 ファイルに/)).toBeInTheDocument();
    expect(screen.getByText("40 × 30 px")).toBeInTheDocument();
    act(() => state().setSelection(["ra", "r2"]));
    expect(screen.getByText(/選択した 2 個を 1 ファイルに/)).toBeInTheDocument();
  });

  it("書き出すと登録された関数にファイルを渡し、文書は変えない", async () => {
    const writer = vi.fn<ExportWriter>(async (files) => ({ written: files.length }));
    setExportWriter(writer);
    act(() => state().setSelection(["fa", "fb"]));
    const before = { doc: state().doc, revision: state().revision, canUndo: state().canUndo };
    render(<ExportSection />);
    fireEvent.click(exportButton());
    await screen.findByText("2 ファイルを書き出しました。");
    expect(writer.mock.calls[0]?.[0].map((file) => [file.fileName, file.format])).toEqual([
      ["表紙.svg", "svg"],
      ["表紙 (2).svg", "svg"],
    ]);
    expect({ doc: state().doc, revision: state().revision, canUndo: state().canUndo }).toEqual(
      before,
    );
    expect(state().doc).toBe(before.doc);
  });

  it("PNG の倍率が上限を超えれば理由を出し、書き出さない", () => {
    setExportWriter(async (files) => ({ written: files.length }));
    act(() => {
      state().apply((doc) => ({
        ...doc,
        nodes: { ...doc.nodes, fb: { ...doc.nodes["fb"]!, width: 6000, height: 500 } as never },
      }));
      state().setSelection(["fb"]);
    });
    render(<ExportSection />);
    fireEvent.click(screen.getByRole("button", { name: "PNG" }));
    fireEvent.click(screen.getByRole("button", { name: "3x" }));
    expect(screen.getByRole("alert")).toHaveTextContent("1 辺の上限 16,384 px を超えます");
    expect(exportButton()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "2x" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("12,000 × 1,000 px")).toBeInTheDocument();
    expect(exportButton()).toBeEnabled();
  });

  it("書き込みの失敗と取り消しを表示する", async () => {
    setExportWriter(() => Promise.reject(new Error("disk full")));
    render(<ExportSection />);
    fireEvent.click(exportButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("書き出しに失敗しました: disk full");
    act(() => {
      setExportWriter(async () => ({ written: 0 }));
    });
    fireEvent.click(exportButton());
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("書き出しを取り消しました。"),
    );
  });

  it("選択がすべて非表示なら理由を出す", () => {
    setExportWriter(async (files) => ({ written: files.length }));
    act(() => state().setSelection(["hid"]));
    render(<ExportSection />);
    expect(screen.getByRole("alert")).toHaveTextContent("選択したノードはすべて非表示です。");
    expect(exportButton()).toBeDisabled();
  });
});
