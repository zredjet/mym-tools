/**
 * `ProjectSwitcher` の振る舞い (`docs/ui-design.md` §6 C-3 / §8.1)。
 *
 * - filter: 部分一致 (case-insensitive)
 * - keyboard: ↑↓ で active 行が動く / Enter で navigate
 * - 0 件: 「該当なし」表示
 * - Hash を含む現在モジュールを新しいプロジェクトでも維持
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Project } from "@/lib/types";
import { useAppStore } from "@/store/useAppStore";

import { ProjectSwitcher } from "./ProjectSwitcher";

const projects: Project[] = [
  {
    id: "p1",
    name: "Apple",
    description: "果物",
    position: 0,
    created_at: "2026-01-01T00:00:00.000+09:00",
    updated_at: "2026-01-01T00:00:00.000+09:00",
  },
  {
    id: "p2",
    name: "Banana",
    description: null,
    position: 1,
    created_at: "2026-01-01T00:00:00.000+09:00",
    updated_at: "2026-01-01T00:00:00.000+09:00",
  },
  {
    id: "p3",
    name: "apricot",
    description: null,
    position: 2,
    created_at: "2026-01-01T00:00:00.000+09:00",
    updated_at: "2026-01-01T00:00:00.000+09:00",
  },
];

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}</div>;
}

function renderAt(initial: string, onClose = vi.fn()) {
  // App.tsx と同じく、Prompt 詳細用の固定リテラル route を別途登録する。
  // これにより `/projects/:projectId/m/prompt/:itemId` 上で `useParams()` に
  // `moduleId` が乗らない実環境を再現できる (codex P2 の対象)。
  const switcher = (
    <>
      <ProjectSwitcher open onClose={onClose} projects={projects} />
      <LocationProbe />
    </>
  );
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route path="/projects/:projectId/m/prompt/:itemId" element={switcher} />
        <Route path="/projects/:projectId/m/:moduleId" element={switcher} />
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ProjectSwitcher", () => {
  beforeEach(() => {
    useAppStore.setState({
      lastOpenedModuleId: null,
      lastOpenedProjectId: null,
      moduleEnabled: {},
    });
  });

  it("filters projects by case-insensitive substring match", () => {
    renderAt("/projects/p1/m/prompt");
    const input = screen.getByLabelText("プロジェクト検索") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "ap" } });
    // "Apple" と "apricot" が hit、"Banana" は hit しない
    expect(screen.getByText("Apple")).toBeInTheDocument();
    expect(screen.getByText("apricot")).toBeInTheDocument();
    expect(screen.queryByText("Banana")).not.toBeInTheDocument();
  });

  it("shows 'no match' message when filter has no result", () => {
    renderAt("/projects/p1/m/prompt");
    const input = screen.getByLabelText("プロジェクト検索") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "zzz" } });
    expect(screen.getByText(/「zzz」に一致するプロジェクトはありません/)).toBeInTheDocument();
  });

  it("navigates to selected project on Enter, preserving current moduleId", () => {
    const onClose = vi.fn();
    renderAt("/projects/p1/m/linkmemo", onClose);
    const input = screen.getByLabelText("プロジェクト検索") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Banana" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("loc").textContent).toBe("/projects/p2/m/linkmemo");
    expect(onClose).toHaveBeenCalled();
    // store 更新も確認
    expect(useAppStore.getState().lastOpenedProjectId).toBe("p2");
    expect(useAppStore.getState().lastOpenedModuleId).toBe("linkmemo");
  });

  it("preserves hash module because every module is project-scoped", () => {
    renderAt("/projects/p2/m/hash");
    const input = screen.getByLabelText("プロジェクト検索") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Apple" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("loc").textContent).toBe("/projects/p1/m/hash");
  });

  it("ArrowDown moves the active row down and Enter selects it", () => {
    renderAt("/projects/p1/m/prompt");
    const input = screen.getByLabelText("プロジェクト検索") as HTMLInputElement;
    // 初期 active = projects[0] = Apple。↓ で Banana に移動
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("loc").textContent).toBe("/projects/p2/m/prompt");
  });

  it("preserves 'prompt' module when opened from Prompt detail page (codex P2)", () => {
    // PromptDetailPage は `/projects/:projectId/m/prompt/:itemId` という固定リテラル
    // ルートに住んでいるため `useParams().moduleId` は得られない。`useLocation` から
    // pathname を直接 parse することで、`lastOpenedModuleId` のフォールバックに頼らず
    // 「現在 prompt にいる」ことを正確に検出する。
    useAppStore.setState({ lastOpenedModuleId: "color" }); // 過去履歴がノイズになる状況
    renderAt("/projects/p1/m/prompt/item-uuid-123");
    const input = screen.getByLabelText("プロジェクト検索") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Banana" } });
    fireEvent.keyDown(input, { key: "Enter" });
    // lastOpenedModuleId="color" に引きずられず、現在の prompt に着地
    expect(screen.getByTestId("loc").textContent).toBe("/projects/p2/m/prompt");
  });

  it("ignores Enter while IME composition is active (codex P1)", () => {
    // 日本語 / 中国語 / 韓国語の IME 変換中、Enter は候補確定キーになる。
    // この時にコマンドパレットが遷移してしまうと、絞り込み入力中にプロジェクト
    // が勝手に切り替わって混乱する。`isComposing` で素通しさせる。
    renderAt("/projects/p1/m/prompt");
    const input = screen.getByLabelText("プロジェクト検索") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Banana" } });

    // composition 中の Enter は無視される (URL 変化なし)
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(screen.getByTestId("loc").textContent).toBe("/projects/p1/m/prompt");

    // composition 終了後の Enter は通常通り遷移する
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("loc").textContent).toBe("/projects/p2/m/prompt");
  });
});
