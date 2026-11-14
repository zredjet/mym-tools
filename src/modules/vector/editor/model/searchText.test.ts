import { describe, expect, it } from "vitest";
import { createFrame, createGroup, createText } from "./create";
import { collapseWhiteSpace, computeSearchText, isWhiteSpace } from "./searchText";
import type { CanvasDocument } from "./types";

describe("検索用テキスト", () => {
  it("Rust の char::is_whitespace と同じ空白で区切る", () => {
    expect(collapseWhiteSpace("  a　b c d\u0085e  ")).toBe("a b c d e");
    // U+FEFF と U+200B は空白ではない (JavaScript の \s とは違う)
    expect(isWhiteSpace("﻿")).toBe(false);
    expect(isWhiteSpace("​")).toBe(false);
    expect(collapseWhiteSpace("a﻿b​c")).toBe("a﻿b​c");
    expect(collapseWhiteSpace(" \t\n ")).toBe("");
  });

  it("frame の名前とテキストを順に拾い、group は子へ進み、非表示も拾う", () => {
    const doc: CanvasDocument = {
      pages: [
        { id: "a", name: "", children: ["f1", "g"], guides: [] },
        { id: "b", name: "", children: ["t3"], guides: [] },
      ],
      nodes: {
        f1: createFrame({ id: "f1", name: "  画面  1 ", children: ["t1"] }),
        t1: createText({ id: "t1", text: "本文\n2 行目", visible: false }),
        g: createGroup(["t2", "f2"], { id: "g", name: "拾わない" }),
        t2: createText({ id: "t2", text: "   " }),
        f2: createFrame({ id: "f2", name: "" }),
        t3: createText({ id: "t3", text: "次のページ" }),
      },
      assets: {},
    };
    expect(computeSearchText(doc)).toBe("画面 1 本文 2 行目 次のページ");
  });
});
