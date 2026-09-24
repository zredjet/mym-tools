import { describe, expect, it } from "vitest";

import { findHighlightRange } from "./highlight";
import { normalizeSearchText } from "./tree";

describe("NRBF search highlighting", () => {
  it.each([
    ["前Ａｌｉｃｅ後", "alice", "Ａｌｉｃｅ"],
    ["前ｶﾞ後", "ガ", "ｶﾞ"],
    ["前e\u0301後", "É", "e\u0301"],
    ["前㍿後", "会社", "㍿"],
    ["前👩‍💻後", "💻", "👩‍💻"],
    ["前🇯🇵後", "🇯", "🇯🇵"],
    ["前ΟΣΑ後", "οσ", "ΟΣ"],
    ["ΟΣ", "ος", "ΟΣ"],
    ["前İ後", "i", "İ"],
    ["前Alice後Alice", " ALICE ", "Alice"],
  ])("maps a normalized match in %s back to whole graphemes", (text, query, expected) => {
    expect(normalizeSearchText(text)).toContain(normalizeSearchText(query.trim()));
    const range = findHighlightRange(text, query)!;
    expect(text.slice(range.start, range.end)).toBe(expected);
  });

  it("does not highlight an absent, empty, or contextually different match", () => {
    expect(findHighlightRange("Name", "backingfield")).toBeNull();
    expect(findHighlightRange("Name", "  ")).toBeNull();
    expect(findHighlightRange("ΟΣ", "οσ")).toBeNull();
  });
});
