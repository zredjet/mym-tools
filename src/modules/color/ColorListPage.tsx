/**
 * M-Color 一覧 (`docs/ui-design.md` §6.5 / §9.3)。
 *
 * Phase 1 PR-L: パレットグリッド表示 + 新規作成 + 削除のみ。
 * - 5 列グリッド (画面幅で 6/4/3 列に切替)
 * - 各セルは 96px 角の swatch + 名前 + HEX
 * - 編集 (K-2 full editor with HEX/RGB/HSL/OKLCH 同時表示) は次 PR
 */
import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useParams } from "react-router-dom";

import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ColorCreateDialog } from "@/modules/color/ColorCreateDialog";
import { deleteItem, listItems } from "@/ipc/items";
import { formatInvokeError } from "@/lib/error";
import type { ColorPayloadV1, Item } from "@/lib/types";

export function ColorListPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const refresh = useCallback(async (pid: string) => {
    try {
      setLoading(true);
      const list = await listItems({ moduleId: "color", projectId: pid });
      setItems(list);
      setError(null);
    } catch (e) {
      setError(formatInvokeError(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (projectId == null) return;
    let cancelled = false;
    void (async () => {
      try {
        const list = await listItems({ moduleId: "color", projectId });
        if (!cancelled) {
          setItems(list);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(formatInvokeError(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const handleDelete = async (id: string) => {
    if (!confirm("この Color を削除しますか? (元に戻せません)")) return;
    try {
      await deleteItem({ moduleId: "color", itemId: id });
      if (projectId != null) await refresh(projectId);
    } catch (e) {
      setError(formatInvokeError(e));
    }
  };

  if (projectId == null) {
    return (
      <div className="m-6 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-muted)] p-4 text-sm text-[var(--fg-muted)]">
        プロジェクトが選択されていません。
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col px-[var(--page-pad)] py-6">
      <header className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">
          Colors <span className="text-[var(--fg-subtle)]">· {items.length}</span>
        </h1>
        <Button variant="primary" onClick={() => setCreateOpen(true)}>
          <Plus size={14} aria-hidden /> 新規 Color
        </Button>
      </header>

      {error != null && (
        <div
          role="alert"
          className="mb-3 rounded-[var(--radius)] border border-[var(--destructive)] bg-[var(--destructive)]/10 p-2 text-[13px] text-[var(--destructive)]"
        >
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-[13px] text-[var(--fg-subtle)]">読込中...</p>
      ) : items.length === 0 ? (
        <div className="flex-1 rounded-[var(--radius)] border border-dashed border-[var(--border)]">
          <EmptyState
            icon="🎨"
            title="パレットが空です"
            description="ブランド色や UI トークンを HEX/RGB/HSL/OKLCH で管理できます。"
            actions={
              <Button variant="primary" onClick={() => setCreateOpen(true)}>
                <Plus size={14} aria-hidden /> 新規 Color
              </Button>
            }
          />
        </div>
      ) : (
        <ul className="grid grid-cols-3 gap-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {items.map((item) => (
            <ColorSwatch key={item.id} item={item} onDelete={() => void handleDelete(item.id)} />
          ))}
        </ul>
      )}

      <ColorCreateDialog
        open={createOpen}
        projectId={projectId}
        onClose={() => setCreateOpen(false)}
        onCreated={() => void refresh(projectId)}
      />
    </div>
  );
}

function ColorSwatch({ item, onDelete }: { item: Item; onDelete: () => void }) {
  const payload = item.payload as ColorPayloadV1 | undefined;
  const hex = typeof payload?.hex === "string" ? payload.hex : "#000000";
  return (
    <li className="group relative flex flex-col overflow-hidden rounded-[var(--radius)] border border-[var(--border)]">
      <div className="aspect-square w-full" style={{ background: hex }} aria-label={hex} />
      <div className="flex items-center justify-between gap-2 px-2.5 py-1.5">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-medium text-[var(--fg)]" title={item.title}>
            {item.title}
          </p>
          <p className="font-mono text-[11px] text-[var(--fg-muted)]">{hex}</p>
        </div>
        <button
          type="button"
          aria-label="削除"
          title="削除"
          onClick={onDelete}
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--fg-subtle)] opacity-0 transition-opacity group-hover:opacity-100 hover:bg-[var(--bg-muted)] hover:text-[var(--destructive)]"
        >
          <Trash2 size={13} aria-hidden />
        </button>
      </div>
    </li>
  );
}
