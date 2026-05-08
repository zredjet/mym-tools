/**
 * `EmptyState` の最小レンダリングテスト。a11y (heading)・description・actions の各要素が
 * 期待通りに DOM に出ることを確認する。
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EmptyState } from "./EmptyState";

describe("EmptyState", () => {
  it("renders title as heading and optional description / actions", () => {
    render(
      <EmptyState
        icon="📝"
        title="まだプロンプトがありません"
        description="変数差し込みで再利用できます"
        actions={<button>新規</button>}
      />,
    );
    expect(screen.getByRole("heading", { name: "まだプロンプトがありません" })).toBeInTheDocument();
    expect(screen.getByText("変数差し込みで再利用できます")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新規" })).toBeInTheDocument();
  });

  it("omits optional fields when not provided", () => {
    render(<EmptyState title="empty" />);
    expect(screen.getByRole("heading", { name: "empty" })).toBeInTheDocument();
    // description / actions が無い場合はそれらの要素が存在しない
    expect(screen.queryByRole("button")).toBeNull();
  });
});
