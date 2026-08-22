import { describe, expect, it } from "vitest";

import {
  commitHistory,
  createHistory,
  redoHistory,
  undoHistory,
  type PaletteSnapshot,
} from "./paletteHistory";

const initial: PaletteSnapshot = {
  colors: ["#000000", "#111111", "#222222", "#333333", "#444444"],
  harmony: "custom" as const,
  baseIndex: 2 as const,
  locked: [false, false, false, false, false] as [boolean, boolean, boolean, boolean, boolean],
};

describe("palette history", () => {
  it("supports undo and redo", () => {
    const changed = { ...initial, harmony: "triad" as const };
    const history = commitHistory(createHistory(initial), changed);
    expect(undoHistory(history).present).toEqual(initial);
    expect(redoHistory(undoHistory(history)).present).toEqual(changed);
  });

  it("clears redo after a new edit", () => {
    const first = commitHistory(createHistory(initial), { ...initial, harmony: "triad" });
    const undone = undoHistory(first);
    const branched = commitHistory(undone, { ...initial, harmony: "square" });
    expect(branched.future).toEqual([]);
  });

  it("does not add duplicate snapshots and caps history", () => {
    let history = createHistory(initial);
    expect(commitHistory(history, initial)).toBe(history);
    for (let index = 0; index < 120; index += 1) {
      history = commitHistory(history, {
        ...history.present,
        colors: [`#${String(index).padStart(6, "0")}`, ...history.present.colors.slice(1)] as [
          string,
          string,
          string,
          string,
          string,
        ],
      });
    }
    expect(history.past).toHaveLength(100);
  });
});
