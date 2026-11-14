import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setImportFileReader } from "../assets/reader";
import { resetImportStatus } from "../assets/status";
import { SAMPLE_SVG, SAMPLE_SVG_TEXT } from "../assets/testing";
import { sampleDocument } from "../model/testing";
import { editorStore } from "../state/store";
import { Toolbar } from "./Toolbar";

const state = () => editorStore.getState();
const imageButton = () => screen.getByRole("button", { name: "画像" });

beforeEach(() => {
  resetImportStatus();
  state().load(sampleDocument());
});

afterEach(() => {
  setImportFileReader(null);
});

describe("Toolbar の「画像」", () => {
  it("ファイルを読む関数の登録がない間は無効", () => {
    render(<Toolbar />);
    expect(imageButton()).toBeDisabled();
    act(() => {
      setImportFileReader(async () => null);
    });
    expect(imageButton()).toBeEnabled();
  });

  it("押したらツールを切り替えずにすぐファイル選択を開き、選んだら置く", async () => {
    const reader = vi.fn(async () => ({
      kind: "svg" as const,
      svg: SAMPLE_SVG,
      text: SAMPLE_SVG_TEXT,
    }));
    setImportFileReader(reader);
    act(() => state().setTool("rect"));
    render(<Toolbar />);
    fireEvent.click(imageButton());
    expect(reader).toHaveBeenCalledTimes(1);
    expect(state().toolId).toBe("select");
    await waitFor(() => expect(state().revision).toBe(1));
    expect(state().doc.nodes[state().selection[0] ?? ""]?.type).toBe("svg");
  });

  it("取り消したら何もせず、選択ツールのまま", async () => {
    setImportFileReader(async () => null);
    render(<Toolbar />);
    fireEvent.click(imageButton());
    await waitFor(() => expect(imageButton()).toBeEnabled());
    expect(state().revision).toBe(0);
    expect(state().toolId).toBe("select");
  });

  it("取り込めなければ理由を出す", async () => {
    setImportFileReader(async () => ({ kind: "svg", svg: SAMPLE_SVG, text: "違う" }));
    render(<Toolbar />);
    fireEvent.click(imageButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("一致しない");
    fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
