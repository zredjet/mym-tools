/**
 * ルート描画中の例外 (モジュール画面の描画エラー、遅延読み込み chunk の取得失敗など) の表示。
 *
 * モジュールのルートに `errorElement` として置くと、エラーは AppShell の Outlet 内だけに
 * 出て、サイドバーから別のモジュール / プロジェクトへ移動できる。
 */
import { isRouteErrorResponse, useNavigate, useRouteError } from "react-router-dom";

import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { formatInvokeError } from "@/lib/error";

export function RouteErrorPage() {
  const error = useRouteError();
  const navigate = useNavigate();
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : formatInvokeError(error);

  return (
    <div role="alert" className="h-full">
      <EmptyState
        icon="⚠️"
        title="画面を表示できませんでした"
        description={message}
        actions={
          <>
            <Button variant="secondary" onClick={() => window.location.reload()}>
              再読み込み
            </Button>
            <Button variant="ghost" onClick={() => navigate("/", { replace: true })}>
              スタート画面へ
            </Button>
          </>
        }
      />
    </div>
  );
}
