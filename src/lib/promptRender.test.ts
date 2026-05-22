import { describe, expect, it } from "vitest";

import { renderPromptTemplate } from "./promptRender";

/**
 * Rust 側 `template::render_template` のテストケース
 * (`src-tauri/src/modules/prompt/template.rs::tests::render_*`) と仕様一致。
 */
describe("renderPromptTemplate", () => {
  it("replaces provided variable", () => {
    expect(renderPromptTemplate("Hello {{name}}", { name: "Alice" })).toBe("Hello Alice");
  });

  it("leaves undefined variables as-is (partial preview)", () => {
    expect(renderPromptTemplate("Hello {{name}}, age {{age}}", { name: "Alice" })).toBe(
      "Hello Alice, age {{age}}",
    );
  });

  it("replaces repeated variable each occurrence", () => {
    expect(renderPromptTemplate("{{x}} and {{x}}", { x: "Y" })).toBe("Y and Y");
  });

  it("returns input as-is when no variables", () => {
    expect(renderPromptTemplate("plain text", {})).toBe("plain text");
  });

  it("handles unclosed `{{` as literal", () => {
    expect(renderPromptTemplate("Hello {{name", { name: "Alice" })).toBe("Hello {{name");
  });

  it("preserves invalid variable names literally", () => {
    expect(renderPromptTemplate("{{a-b}} ok", { "a-b": "X" })).toBe("{{a-b}} ok");
  });

  it("matches translation example from data-model spec", () => {
    expect(
      renderPromptTemplate("Translate the following to {{language}}: {{text}}", {
        language: "Japanese",
        text: "hello",
      }),
    ).toBe("Translate the following to Japanese: hello");
  });

  it("empty value replaces with empty string (PR #33 codex P2: not a 'no preview' state)", () => {
    expect(renderPromptTemplate("Hello [{{name}}]", { name: "" })).toBe("Hello []");
  });

  it("does not recurse into replaced value", () => {
    expect(renderPromptTemplate("{{a}}", { a: "{{b}}", b: "VALUE" })).toBe("{{b}}");
  });

  // PR-AD: 日本語 (CJK) 対応
  it("replaces Japanese variable names", () => {
    expect(
      renderPromptTemplate("{{言語}} で {{トピック}} について書いてください", {
        言語: "日本語",
        トピック: "猫",
      }),
    ).toBe("日本語 で 猫 について書いてください");
  });

  it("replaces mixed ASCII and Japanese placeholders", () => {
    expect(
      renderPromptTemplate("Translate {{topic}} into {{言語}}", {
        topic: "hello",
        言語: "日本語",
      }),
    ).toBe("Translate hello into 日本語");
  });

  it("leaves undefined Japanese variable as-is", () => {
    expect(renderPromptTemplate("{{topic}} と {{言語}}", { topic: "hello" })).toBe(
      "hello と {{言語}}",
    );
  });
});
