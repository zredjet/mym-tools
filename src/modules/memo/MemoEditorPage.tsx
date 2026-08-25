import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Save } from "lucide-react";
import { useHotkeys } from "react-hotkeys-hook";
import { useBlocker, useLocation, useNavigate, useParams } from "react-router-dom";

import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { createItem, getItem, updateItem } from "@/ipc/items";
import { formatInvokeError } from "@/lib/error";
import type { MemoPayloadV1 } from "@/lib/types";
import { modulePath } from "@/modules/registry";

export function MemoEditorRoute() {
  const { itemId } = useParams<{ itemId?: string }>();
  const location = useLocation();
  return <MemoEditorPage key={`${itemId ?? "new"}:${location.pathname}`} />;
}

export function MemoEditorPage() {
  const { projectId, itemId } = useParams<{ projectId: string; itemId?: string }>();
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [body, setBody] = useState("");
  const [baseline, setBaseline] = useState(() => documentKey("", "", ""));
  const [loading, setLoading] = useState(itemId != null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allowNavigation = useRef(false);

  useEffect(() => {
    if (itemId == null) return;
    let cancelled = false;
    void getItem({ moduleId: "memo", itemId })
      .then((item) => {
        if (cancelled) return;
        const nextBody = (item.payload as Partial<MemoPayloadV1>).body ?? "";
        const nextTags = item.tags.join(", ");
        setTitle(item.title);
        setTagsInput(nextTags);
        setBody(nextBody);
        setBaseline(documentKey(item.title, nextTags, nextBody));
      })
      .catch((cause) => {
        if (!cancelled) setError(formatInvokeError(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [itemId]);

  const dirty = documentKey(title, tagsInput, body) !== baseline;
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty &&
      !allowNavigation.current &&
      (currentLocation.pathname !== nextLocation.pathname ||
        currentLocation.search !== nextLocation.search),
  );
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const save = useCallback(async (): Promise<boolean> => {
    if (projectId == null || submitting || title.trim() === "" || body.trim() === "") return false;
    setSubmitting(true);
    setError(null);
    const tags = parseTags(tagsInput);
    const payload: MemoPayloadV1 = { body };
    try {
      const savedId =
        itemId ??
        (await createItem({ moduleId: "memo", projectId, title: title.trim(), tags, payload }));
      if (itemId != null)
        await updateItem({ moduleId: "memo", itemId, title: title.trim(), tags, payload });
      setBaseline(documentKey(title.trim(), tags.join(", "), body));
      allowNavigation.current = true;
      navigate(modulePath(projectId, "memo", `/${savedId}`), { replace: true });
      return true;
    } catch (cause) {
      setError(formatInvokeError(cause));
      return false;
    } finally {
      setSubmitting(false);
    }
  }, [body, itemId, navigate, projectId, submitting, tagsInput, title]);

  useHotkeys(
    "mod+s",
    (event) => {
      event.preventDefault();
      void save();
    },
    { enableOnFormTags: true },
    [save],
  );

  if (projectId == null)
    return (
      <div className="p-6 text-sm text-[var(--fg-muted)]">プロジェクトが選択されていません。</div>
    );
  if (loading)
    return <div className="p-6 text-sm text-[var(--fg-subtle)]">メモを読み込んでいます...</div>;
  const cancelPath = modulePath(projectId, "memo", itemId == null ? "/" : `/${itemId}`);

  return (
    <div className="flex h-full min-h-[420px] flex-col px-[var(--page-pad)] py-6">
      <header className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => navigate(cancelPath)}>
            <ArrowLeft size={14} /> キャンセル
          </Button>
          <h1 className="text-lg font-semibold">{itemId == null ? "メモを作成" : "メモを編集"}</h1>
        </div>
        <Button
          variant="primary"
          onClick={() => void save()}
          disabled={submitting || title.trim() === "" || body.trim() === ""}
        >
          <Save size={14} /> {submitting ? "保存中..." : "保存"}
          <span className="text-[10px] opacity-70">⌘S</span>
        </Button>
      </header>
      {error != null && (
        <div role="alert" className="mb-3 text-sm text-[var(--destructive)]">
          {error}
        </div>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        className="flex min-h-0 flex-1 flex-col gap-3"
      >
        <label className="flex flex-col gap-1">
          <span className="text-[13px] font-medium">タイトル</span>
          <input
            autoFocus
            required
            maxLength={200}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className="h-9 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-3 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[13px] font-medium">タグ (カンマ区切り)</span>
          <input
            maxLength={200}
            value={tagsInput}
            onChange={(event) => setTagsInput(event.target.value)}
            placeholder="design, note"
            className="h-9 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-3 text-sm"
          />
        </label>
        <label className="flex min-h-0 flex-1 flex-col gap-1">
          <span className="text-[13px] font-medium">本文 (Markdown)</span>
          <textarea
            required
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="メモ本文..."
            className="min-h-[260px] flex-1 resize-none rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] p-3 font-mono text-[13px] leading-relaxed"
          />
        </label>
      </form>
      <Modal
        open={blocker.state === "blocked"}
        onClose={() => blocker.reset?.()}
        title="未保存の変更があります"
      >
        <p className="text-[13px] text-[var(--fg-muted)]">変更を破棄して移動しますか?</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => blocker.reset?.()}>
            編集を続ける
          </Button>
          <Button variant="secondary" onClick={() => blocker.proceed?.()}>
            破棄して移動
          </Button>
        </div>
      </Modal>
    </div>
  );
}

function parseTags(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((tag) => tag.trim().replace(/^#/, ""))
        .filter(Boolean),
    ),
  ];
}

function documentKey(title: string, tags: string, body: string): string {
  return JSON.stringify([title, tags, body]);
}
