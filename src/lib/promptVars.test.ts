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
    expect(extractPromptVariables("{{こんにちは}}")).toEqual([]);
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
});
