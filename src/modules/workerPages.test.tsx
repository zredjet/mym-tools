import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RegexPage } from "@/modules/regex/RegexPage";
import { TextDiffPage } from "@/modules/textdiff/TextDiffPage";

/** 応答を返さない Worker。打ち切りタイマーが残っているかを確かめる */
class SilentWorker {
  static instances: SilentWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  terminate = vi.fn();
  constructor() {
    SilentWorker.instances.push(this);
  }
  postMessage() {}
}

describe("worker-backed tool pages", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    SilentWorker.instances = [];
    vi.stubGlobal("Worker", SilentWorker);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([
    ["TextDiff", () => render(<TextDiffPage />), /比較|差分/],
    ["Regex", () => render(<RegexPage />), /評価/],
  ])(
    "%s stops the worker and its timeout when the page is left mid-run",
    (_name, renderPage, button) => {
      const { unmount } = renderPage();
      fireEvent.click(screen.getByRole("button", { name: button }));
      expect(vi.getTimerCount()).toBe(1);

      unmount();

      expect(vi.getTimerCount()).toBe(0);
      expect(SilentWorker.instances[0]!.terminate).toHaveBeenCalled();
    },
  );
});
