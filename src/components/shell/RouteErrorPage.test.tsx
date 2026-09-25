import { render, screen } from "@testing-library/react";
import { Outlet, RouterProvider, createMemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RouteErrorPage } from "./RouteErrorPage";

function Broken(): never {
  throw new Error("payload.colors is not iterable");
}

describe("RouteErrorPage", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps the shell and shows the error inside the outlet", () => {
    // React はレンダリング中の例外を console.error に出すため、テスト出力から除く
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const router = createMemoryRouter(
      [
        {
          element: (
            <div>
              <nav>サイドバー</nav>
              <Outlet />
            </div>
          ),
          children: [
            {
              path: "/projects/:projectId/m/palette",
              element: <Broken />,
              errorElement: <RouteErrorPage />,
            },
          ],
        },
      ],
      { initialEntries: ["/projects/p1/m/palette"] },
    );
    render(<RouterProvider router={router} />);

    expect(screen.getByText("サイドバー")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("画面を表示できませんでした");
    expect(screen.getByRole("alert")).toHaveTextContent("payload.colors is not iterable");
    expect(screen.getByRole("button", { name: "再読み込み" })).toBeInTheDocument();
  });
});
