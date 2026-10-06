import { describe, expect, it } from "vitest";

import {
  cleanText,
  defaultTextCleanOptions,
  interpretEscapes,
  type TextCleanOptions,
} from "./textClean";

function clean(input: string, options: Partial<TextCleanOptions>) {
  return cleanText(input, { ...defaultTextCleanOptions, ...options });
}

describe("interpretEscapes", () => {
  it("turns only \\t, \\n and \\\\ into characters", () => {
    expect(interpretEscapes("a\\tb\\nc\\\\d")).toBe("a\tb\nc\\d");
    expect(interpretEscapes("\\x\\")).toBe("\\x\\");
    expect(interpretEscapes("\\\\t")).toBe("\\t");
  });
});

describe("cleanText", () => {
  it("leaves the text unchanged with default options", () => {
    const input = "a\t \n\n\nb\n";
    expect(clean(input, {})).toEqual({
      output: input,
      replacements: 0,
      tabs: 0,
      trimmedLines: 0,
      removedBlankLines: 0,
    });
  });

  describe("replace rules", () => {
    it("replaces every literal match in rule order", () => {
      const result = clean("foo bar foo", {
        rules: [
          { find: "foo", replace: "bar" },
          { find: "bar", replace: "baz" },
        ],
      });
      expect(result.output).toBe("baz baz baz");
      expect(result.replacements).toBe(5);
    });

    it("does not treat $ patterns or regex syntax specially", () => {
      expect(clean("a.b", { rules: [{ find: ".", replace: "$&$1$$" }] }).output).toBe("a$&$1$$b");
    });

    it("can ignore case without changing the replacement", () => {
      const result = clean("Foo FOO foo", {
        rules: [{ find: "foo", replace: "x" }],
        caseSensitive: false,
      });
      expect(result.output).toBe("x x x");
      expect(result.replacements).toBe(3);
    });

    it("skips rules whose search text is empty", () => {
      const result = clean("abc", { rules: [{ find: "", replace: "x" }] });
      expect(result.output).toBe("abc");
      expect(result.replacements).toBe(0);
    });

    it("interprets escapes only when asked", () => {
      expect(clean("a,b", { rules: [{ find: ",", replace: "\\t" }] }).output).toBe("a\\tb");
      expect(
        clean("a,b", { rules: [{ find: ",", replace: "\\t" }], interpretEscapes: true }).output,
      ).toBe("a\tb");
    });
  });

  describe("tabs", () => {
    it("deletes every tab", () => {
      const result = clean("\ta\tb\n\t\tc", { tabMode: "delete" });
      expect(result.output).toBe("ab\nc");
      expect(result.tabs).toBe(4);
    });

    it("replaces each tab with N spaces without aligning to tab stops", () => {
      expect(clean("ab\tc", { tabMode: "spaces", tabWidth: 4 }).output).toBe("ab    c");
      expect(clean("\tx", { tabMode: "spaces", tabWidth: 2 }).output).toBe("  x");
    });

    it("only touches tabs in the leading whitespace when scoped to leading", () => {
      const result = clean(" \t\tif (a)\tb\n\tc\td", {
        tabMode: "spaces",
        tabWidth: 2,
        tabScope: "leading",
      });
      expect(result.output).toBe("     if (a)\tb\n  c\td");
      expect(result.tabs).toBe(3);
    });
  });

  it("removes trailing whitespace including full-width spaces", () => {
    const result = clean("a \t　\nb\nc ", { trimTrailing: true });
    expect(result.output).toBe("a\nb\nc");
    expect(result.trimmedLines).toBe(2);
  });

  describe("blank lines", () => {
    const input = "a\n\n 　\nb\n\n\nc\n";

    it("deletes empty and whitespace-only lines", () => {
      const result = clean(input, { blankLines: "delete" });
      expect(result.output).toBe("a\nb\nc\n");
      expect(result.removedBlankLines).toBe(4);
    });

    it("keeps whitespace-only lines when they are not treated as blank", () => {
      const result = clean(input, { blankLines: "delete", whitespaceLinesAreBlank: false });
      expect(result.output).toBe("a\n 　\nb\nc\n");
      expect(result.removedBlankLines).toBe(3);
    });

    it("collapses consecutive blank lines into one", () => {
      const result = clean(input, { blankLines: "collapse" });
      expect(result.output).toBe("a\n\nb\n\nc\n");
      expect(result.removedBlankLines).toBe(2);
    });

    it("keeps the final newline and drops it only when nothing is left", () => {
      expect(clean("a\n\n", { blankLines: "delete" }).output).toBe("a\n");
      expect(clean("a", { blankLines: "delete" }).output).toBe("a");
      expect(clean("\n\n", { blankLines: "delete" }).output).toBe("");
      expect(clean("", { blankLines: "delete" }).output).toBe("");
    });
  });

  it("processes tabs and newlines inserted by replace rules in later steps", () => {
    const result = clean("a;;b", {
      rules: [{ find: ";", replace: "\\n\\t" }],
      interpretEscapes: true,
      tabMode: "delete",
      trimTrailing: true,
      blankLines: "delete",
    });
    expect(result.output).toBe("a\nb");
    expect(result.tabs).toBe(2);
    expect(result.removedBlankLines).toBe(1);
  });

  it("trims trailing whitespace before deciding blank lines", () => {
    const result = clean("a\n \t\nb", {
      trimTrailing: true,
      blankLines: "delete",
      whitespaceLinesAreBlank: false,
    });
    expect(result.output).toBe("a\nb");
  });

  it("rejects input over 1 MiB", () => {
    expect(() => clean("a".repeat(1024 * 1024 + 1), {})).toThrow("1MiB");
  });
});
