/**
 * M-LinkMemo 一覧 (`docs/ui-design.md` §6.4 / §9.2)。
 *
 * Phase 1 PR-L (本 PR): 実 items 一覧 + 新規作成ダイアログ + 削除 + 「開く」 (URL/path)。
 * - 行高 32px
 * - type 別アイコン (URL: 🌐 / Path: 📄 / Memo: 📝)
 * - クリックで OS 既定アプリで開く (memo は body をモーダル等で見せる UI 未実装)
 * - 編集 (L-3 full editor) は次 PR
 */
import { useCallback, useEffect, useState } from "react";
import { ExternalLink, FileText, Globe, Plus, StickyNote, Trash2 } from "lucide-react";
import { useParams } from "react-router-dom";

import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { deleteItem, listItems } from "@/ipc/items";
import { linkmemoOpen } from "@/ipc/linkmemo";
import { formatInvokeError } from "@/lib/error";
import type { Item, LinkMemoPayloadV1 } from "@/lib/types";
import { LinkMemoCreateDialog } from "@/modules/linkmemo/LinkMemoCreateDialog";

export function LinkMemoListPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const refresh = useCallback(async (pid: string) => {
    try {
      setLoading(true);
      const list = await listItems({ moduleId: "linkmemo", projectId: pid });
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
        const list = await listItems({ moduleId: "linkmemo", projectId });
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
    if (!confirm("この Link/Memo を削除しますか? (元に戻せません)")) return;
    try {
      await deleteItem({ moduleId: "linkmemo", itemId: id });
      if (projectId != null) await refresh(projectId);
    } catch (e) {
      setError(formatInvokeError(e));
    }
  };

  const handleOpen = async (payload: LinkMemoPayloadV1) => {
    if (payload.type === "memo" || payload.target == null || payload.target === "") {
      // Phase 1 PR-L では memo の表示 UI は未実装 (編集 PR で詳細モーダル化)
      return;
    }
    try {
      await linkmemoOpen({ itemType: payload.type, target: payload.target });
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
          Links / Memos <span className="text-[var(--fg-subtle)]">· {items.length}</span>
        </h1>
        <Button variant="primary" onClick={() => setCreateOpen(true)}>
          <Plus size={14} aria-hidden /> 新規 Link/Memo
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
            icon="🔗"
            title="Link / Memo を追加しましょう"
            description="URL / ローカルパス / メモをプロジェクトごとに整理できます。"
            actions={
              <Button variant="primary" onClick={() => setCreateOpen(true)}>
                <Plus size={14} aria-hidden /> 新規 Link/Memo
              </Button>
            }
          />
        </div>
      ) : (
        <ul className="divide-y divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)]">
          {items.map((item) => (
            <LinkMemoRow
              key={item.id}
              item={item}
              onOpen={() => void handleOpen(asPayload(item))}
              onDelete={() => void handleDelete(item.id)}
            />
          ))}
        </ul>
      )}

      <LinkMemoCreateDialog
        open={createOpen}
        projectId={projectId}
        onClose={() => setCreateOpen(false)}
        onCreated={() => void refresh(projectId)}
      />
    </div>
  );
}

function asPayload(item: Item): LinkMemoPayloadV1 {
  const p = item.payload as LinkMemoPayloadV1 | undefined;
  return p ?? { type: "memo", target: null, body: "" };
}

function LinkMemoRow({
  item,
  onOpen,
  onDelete,
}: {
  item: Item;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const payload = asPayload(item);
  const Icon = payload.type === "url" ? Globe : payload.type === "path" ? FileText : StickyNote;
  const openable = payload.type !== "memo" && payload.target != null && payload.target !== "";

  return (
    <li className="flex h-[var(--row-h)] items-center gap-3 px-3 hover:bg-[var(--bg-muted)]">
      <Icon
        size={14}
        aria-hidden
        className={
          payload.type === "url"
            ? "text-[var(--accent)]"
            : payload.type === "path"
              ? "text-[var(--fg-muted)]"
              : "text-[var(--fg-subtle)]"
        }
      />
      <button
        type="button"
        onClick={openable ? onOpen : undefined}
        disabled={!openable}
        title={payload.target ?? ""}
        className="min-w-0 flex-1 truncate text-left text-[13px] font-medium text-[var(--fg)] hover:text-[var(--accent)] disabled:cursor-default disabled:hover:text-[var(--fg)]"
      >
        {item.title}
      </button>
      {item.tags.length > 0 && (
        <span className="hidden shrink-0 truncate text-[12px] text-[var(--fg-muted)] md:inline">
          {item.tags.map((t) => `#${t}`).join(" ")}
        </span>
      )}
      {openable && (
        <button
          type="button"
          aria-label="OS で開く"
          title="OS で開く"
          onClick={onOpen}
          className="inline-flex h-5 w-5 items-center justify-center rounded text-[var(--fg-subtle)] hover:bg-[var(--bg)] hover:text-[var(--accent)]"
        >
          <ExternalLink size={13} aria-hidden />
        </button>
      )}
      <button
        type="button"
        aria-label="削除"
        title="削除"
        onClick={onDelete}
        className="inline-flex h-5 w-5 items-center justify-center rounded text-[var(--fg-subtle)] hover:bg-[var(--bg)] hover:text-[var(--destructive)]"
      >
        <Trash2 size={13} aria-hidden />
      </button>
    </li>
  );
}
