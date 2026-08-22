/**
 * `MarkdownView` の振る舞い (`docs/ui-design.md` §6.3 P-2)。
 *
 * - 通常の Markdown が描画される
 * - 未登録言語タグの fenced code block で render が落ちない
 *   (PR #36 codex P1 回帰: `rehype-highlight` の `ignoreMissing: true`)
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MarkdownView } from "./MarkdownView";

describe("MarkdownView", () => {
  it("renders heading and paragraph from markdown", () => {
    render(<MarkdownView source={"# Title\n\nHello *world*"} />);
    expect(screen.getByRole("heading", { name: "Title" })).toBeInTheDocument();
    expect(screen.getByText(/Hello/)).toBeInTheDocument();
  });

  it("highlights a TypeScript import while preserving punctuation and identifiers", () => {
    const { container } = render(
      <MarkdownView source={'```typescript\nimport { useEffect } from "react";\n```'} />,
    );

    const code = container.querySelector("code.hljs.language-typescript");
    expect(code).toHaveTextContent('import { useEffect } from "react";');
    expect(code?.querySelector(".hljs-string")).toHaveTextContent('"react"');
  });

  it("PR #36 codex P1 回帰: 未登録言語 fenced code block で例外を投げない", () => {
    // `unknownlang` は highlight.js に登録のない言語タグ。`ignoreMissing: true`
    // が無効だと render が throw して画面が真っ白になる。
    expect(() => {
      render(
        <MarkdownView source={"# Header\n\n```unknownlang\nlet x = 1;\n```\n\nplain after"} />,
      );
    }).not.toThrow();
    expect(screen.getByRole("heading", { name: "Header" })).toBeInTheDocument();
    expect(screen.getByText("plain after")).toBeInTheDocument();
    // コードの中身もテキストとして残っている (プレーンテキスト fallback)
    expect(screen.getByText(/let x = 1/)).toBeInTheDocument();
  });

  it("disables raw HTML by default (XSS guard)", () => {
    // ユーザー入力 markdown 内の `<script>` は **そのままテキストとして** 出る
    // (rehype-raw を入れていないため DOM に `<script>` 要素が作られない)
    const { container } = render(<MarkdownView source={"hello <script>alert(1)</script>"} />);
    expect(container.querySelector("script")).toBeNull();
  });
});
