import { describe, expect, it } from "vitest";

import { extractPromptVariables } from "./promptVars";

describe("extractPromptVariables", () => {
  it("extracts simple single variable", () => {
    expect(extractPromptVariables("Hello {{name}}")).toEqual(["name"]);
  });

  it("preserves first-occurrence order and dedupes repeats", () => {
    expect(extractPromptVariables("{{a}} {{b}} {{a}} {{c}} {{b}}")).toEqual(["a", "b", "c"]);
  });

  it("returns empty array when no variables", () => {
    expect(extractPromptVariables("plain text")).toEqual([]);
  });

  it("ignores empty braces and invalid names", () => {
    expect(extractPromptVariables("{{}}")).toEqual([]);
    expect(extractPromptVariables("{{a-b}}")).toEqual([]);
    expect(extractPromptVariables("{{a.b}}")).toEqual([]);
    // 空白入りは現状の Phase 1 では無視 (前後空白許容は U-13 候補)
    expect(extractPromptVariables("{{ topic }}")).toEqual([]);
    expect(extractPromptVariables("{{a b}}")).toEqual([]);
  });

  it("stops at unclosed braces (no infinite loop)", () => {
    expect(extractPromptVariables("text {{abc no close")).toEqual([]);
    expect(extractPromptVariables("{{ok}} but {{no_close")).toEqual(["ok"]);
  });

  it("accepts underscore and digits in var names", () => {
    expect(extractPromptVariables("{{user_id_1}} and {{topic42}}")).toEqual([
      "user_id_1",
      "topic42",
    ]);
  });

  // PR-AD: 日本語 (CJK) 対応
  it("accepts Japanese (hiragana / katakana / kanji) variable names", () => {
    expect(extractPromptVariables("{{こんにちは}}")).toEqual(["こんにちは"]);
    expect(extractPromptVariables("{{トピック}}")).toEqual(["トピック"]);
    expect(extractPromptVariables("{{言語}}")).toEqual(["言語"]);
    expect(extractPromptVariables("{{ぷろんぷと}}")).toEqual(["ぷろんぷと"]);
  });

  it("preserves order with mixed ASCII and Japanese placeholders", () => {
    expect(extractPromptVariables("Translate {{topic}} into {{言語}}")).toEqual(["topic", "言語"]);
  });

  it("treats fullwidth and halfwidth digits as distinct names", () => {
    // `1` (U+0031) と `1` (U+FF11) は別 Unicode コードポイント
    const body = "{{topic1}} と {{topic１}}";
    const result = extractPromptVariables(body);
    expect(result).toEqual(["topic1", "topic１"]);
    expect(result[0]).not.toBe(result[1]);
  });
});
