import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, FilePlus2, Save } from "lucide-react";
import { useHotkeys } from "react-hotkeys-hook";
import { useBlocker, useLocation, useNavigate, useParams } from "react-router-dom";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";

import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { createItem, getItem, listAllItems, updateItem } from "@/ipc/items";
import { mermaidWriteFile, type MermaidExportFormat } from "@/ipc/mermaid";
import { formatInvokeError } from "@/lib/error";
import type { Item, MermaidPayloadV1 } from "@/lib/types";
import { modulePath } from "@/modules/registry";
import { useAppStore } from "@/store/useAppStore";

import { readableMermaidError, renderMermaid, type MermaidTheme } from "./mermaidRenderer";
import { MAX_MERMAID_EXPORT_BYTES, renderMermaidPng } from "./mermaidExporter";

const DEFAULT_SOURCE = `flowchart LR
  A[アイデア] --> B[設計]
  B --> C[実装]`;
const MAX_SOURCE_BYTES = 1024 * 1024;

export function MermaidLandingPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (projectId == null) return;
    let cancelled = false;
    void listAllItems({ moduleId: "mermaid", projectId })
      .then((items) => {
        if (cancelled) return;
        const recent = [...items].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
        navigate(modulePath(projectId, "mermaid", recent ? `/edit/${recent.id}` : "/new"), {
          replace: true,
        });
      })
      .catch((cause) => {
        if (!cancelled) setError(formatInvokeError(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [navigate, projectId]);

  return (
    <div className="flex h-full items-center justify-center p-6 text-sm text-[var(--fg-muted)]">
      {error ?? "直近のMermaid図を読み込んでいます..."}
    </div>
  );
}

export function MermaidWorkspaceRoute() {
  const { itemId } = useParams<{ itemId?: string }>();
  const location = useLocation();
  return <MermaidWorkspacePage key={`${itemId ?? "new"}:${location.pathname}`} />;
}

export function MermaidWorkspacePage() {
  const { projectId, itemId } = useParams<{ projectId: string; itemId?: string }>();
  const navigate = useNavigate();
  const configuredTheme = useAppStore((state) => state.theme);
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const [documents, setDocuments] = useState<Item[]>([]);
  const [title, setTitle] = useState(itemId == null ? "新しいMermaid図" : "");
  const [tagsInput, setTagsInput] = useState("");
  const [source, setSource] = useState(DEFAULT_SOURCE);
  const [baseline, setBaseline] = useState(() =>
    documentKey("新しいMermaid図", "", DEFAULT_SOURCE),
  );
  const [loading, setLoading] = useState(itemId != null);
  const [submitting, setSubmitting] = useState(false);
  const [rendering, setRendering] = useState(true);
  const [validSource, setValidSource] = useState<string | null>(null);
  const [validRenderKey, setValidRenderKey] = useState<string | null>(null);
  const [previewSvg, setPreviewSvg] = useState("");
  const [renderError, setRenderError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<MermaidExportFormat | null>(null);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const allowNavigation = useRef(false);
  const renderToken = useRef(0);
  const exportingRef = useRef(false);

  const refreshDocuments = useCallback(async () => {
    if (projectId == null) return;
    const items = await listAllItems({ moduleId: "mermaid", projectId });
    setDocuments([...items].sort((a, b) => b.updated_at.localeCompare(a.updated_at)));
  }, [projectId]);

  useEffect(() => {
    if (projectId == null) return;
    let cancelled = false;
    void listAllItems({ moduleId: "mermaid", projectId })
      .then((items) => {
        if (!cancelled) {
          setDocuments([...items].sort((a, b) => b.updated_at.localeCompare(a.updated_at)));
        }
      })
      .catch((cause) => {
        if (!cancelled) setError(formatInvokeError(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    if (itemId == null) return;
    let cancelled = false;
    void getItem({ moduleId: "mermaid", itemId })
      .then((item) => {
        if (cancelled) return;
        const nextSource = (item.payload as Partial<MermaidPayloadV1>).source ?? "";
        const nextTags = item.tags.join(", ");
        setTitle(item.title);
        setTagsInput(nextTags);
        setSource(nextSource);
        setBaseline(documentKey(item.title, nextTags, nextSource));
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

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = () => setSystemDark(media.matches);
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, []);

  const theme: MermaidTheme =
    configuredTheme === "dark" || (configuredTheme === "system" && systemDark) ? "dark" : "default";
  const renderKey = `${theme}\u0000${source}`;
  const sourceBytes = useMemo(() => new TextEncoder().encode(source).byteLength, [source]);

  useEffect(() => {
    const token = ++renderToken.current;
    const timeout = window.setTimeout(() => {
      if (source.trim() === "") {
        if (token === renderToken.current) {
          setValidSource(null);
          setValidRenderKey(null);
          setRenderError("Mermaid記法を入力してください。");
          setRendering(false);
        }
        return;
      }
      if (sourceBytes > MAX_SOURCE_BYTES) {
        if (token === renderToken.current) {
          setValidSource(null);
          setValidRenderKey(null);
          setRenderError("Mermaid記法はUTF-8で1MiB以下にしてください。");
          setRendering(false);
        }
        return;
      }
      setRendering(true);
      void renderMermaid(source, theme)
        .then((svg) => {
          if (token !== renderToken.current) return;
          setPreviewSvg(svg);
          setRenderError(null);
          setValidSource(source);
          setValidRenderKey(`${theme}\u0000${source}`);
        })
        .catch((cause) => {
          if (token === renderToken.current) {
            setValidSource(null);
            setValidRenderKey(null);
            setRenderError(readableMermaidError(cause));
          }
        })
        .finally(() => {
          if (token === renderToken.current) setRendering(false);
        });
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [source, sourceBytes, theme]);

  const dirty = documentKey(title, tagsInput, source) !== baseline;
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

  const canSave =
    !submitting && title.trim() !== "" && validSource === source && sourceBytes <= MAX_SOURCE_BYTES;
  const canExport =
    !rendering &&
    validSource === source &&
    validRenderKey === renderKey &&
    previewSvg !== "" &&
    exporting == null;
  const save = useCallback(async (): Promise<boolean> => {
    if (projectId == null || !canSave) return false;
    setSubmitting(true);
    setError(null);
    const tags = parseTags(tagsInput);
    const normalizedTitle = title.trim();
    const payload: MermaidPayloadV1 = { source };
    try {
      let savedId = itemId;
      if (savedId == null) {
        savedId = await createItem({
          moduleId: "mermaid",
          projectId,
          title: normalizedTitle,
          tags,
          payload,
        });
      } else {
        await updateItem({
          moduleId: "mermaid",
          itemId: savedId,
          title: normalizedTitle,
          tags,
          payload,
        });
      }
      setTitle(normalizedTitle);
      setTagsInput(tags.join(", "));
      setBaseline(documentKey(normalizedTitle, tags.join(", "), source));
      await refreshDocuments();
      if (itemId == null) {
        allowNavigation.current = true;
        navigate(modulePath(projectId, "mermaid", `/edit/${savedId}`), { replace: true });
      }
      return true;
    } catch (cause) {
      setError(formatInvokeError(cause));
      return false;
    } finally {
      setSubmitting(false);
    }
  }, [canSave, itemId, navigate, projectId, refreshDocuments, source, tagsInput, title]);

  useHotkeys(
    "mod+s",
    (event) => {
      event.preventDefault();
      void save();
    },
    { enableOnFormTags: true },
    [save],
  );

  const exportImage = useCallback(
    async (format: MermaidExportFormat) => {
      if (!canExport || exportingRef.current) return;
      exportingRef.current = true;
      setExporting(format);
      setExportNotice(null);
      setError(null);
      try {
        const path = await saveDialog({
          defaultPath: `${safeFileName(title)}.${format}`,
          filters: [{ name: format.toUpperCase(), extensions: [format] }],
        });
        if (path == null) return;
        const data = format === "svg" ? previewSvg : await renderMermaidPng(previewSvg);
        if (
          format === "svg" &&
          new TextEncoder().encode(data).byteLength > MAX_MERMAID_EXPORT_BYTES
        ) {
          throw new Error("SVGは20MiB以下にしてください。");
        }
        await mermaidWriteFile({ path, format, data });
        setExportNotice(`${format.toUpperCase()}を書き出しました`);
      } catch (cause) {
        setError(formatInvokeError(cause));
      } finally {
        exportingRef.current = false;
        setExporting(null);
      }
    },
    [canExport, previewSvg, title],
  );

  if (projectId == null)
    return <div className="p-6 text-sm">プロジェクトが選択されていません。</div>;
  if (loading)
    return <div className="p-6 text-sm text-[var(--fg-muted)]">Mermaid図を読み込んでいます...</div>;

  return (
    <div className="flex h-full min-h-[520px] flex-col px-[var(--page-pad)] py-4">
      <header className="mb-3 flex flex-wrap items-center gap-2">
        <h1 className="mr-2 text-lg font-semibold">Mermaid</h1>
        <label className="sr-only" htmlFor="mermaid-document">
          ドキュメント
        </label>
        <select
          id="mermaid-document"
          value={itemId ?? "__new"}
          onChange={(event) => {
            const id = event.target.value;
            navigate(modulePath(projectId, "mermaid", id === "__new" ? "/new" : `/edit/${id}`));
          }}
          className="h-8 min-w-48 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-2 text-sm"
        >
          <option value="__new">新規ドラフト</option>
          {documents.map((document) => (
            <option key={document.id} value={document.id}>
              {document.title}
            </option>
          ))}
        </select>
        <Button
          variant="secondary"
          onClick={() => navigate(modulePath(projectId, "mermaid", "/new"))}
        >
          <FilePlus2 size={14} /> 新規
        </Button>
        <Button disabled={!canExport} onClick={() => void exportImage("svg")}>
          <Download size={14} /> {exporting === "svg" ? "SVG生成中..." : "SVG"}
        </Button>
        <Button disabled={!canExport} onClick={() => void exportImage("png")}>
          {exporting === "png" ? "PNG生成中..." : "PNG"}
        </Button>
        <span className="ml-auto text-xs text-[var(--fg-muted)]">
          {dirty ? "未保存" : "保存済み"}
          {exportNotice == null ? "" : `・${exportNotice}`}
        </span>
        <Button variant="primary" disabled={!canSave} onClick={() => void save()}>
          <Save size={14} /> {submitting ? "保存中..." : "保存"}
          <span className="text-[10px] opacity-70">⌘S</span>
        </Button>
      </header>

      {(error != null || renderError != null) && (
        <div
          role="alert"
          className="mb-3 rounded-[var(--radius)] bg-[var(--bg-muted)] px-3 py-2 text-sm text-[var(--destructive)]"
        >
          {error ?? `構文エラー: ${renderError}（最後に成功したプレビューを表示しています）`}
        </div>
      )}

      <div className="mb-3 grid grid-cols-[minmax(180px,2fr)_minmax(140px,1fr)] gap-3">
        <label className="flex flex-col gap-1 text-[13px] font-medium">
          タイトル
          <input
            maxLength={200}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className="h-9 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-3 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-[13px] font-medium">
          タグ（カンマ区切り）
          <input
            maxLength={200}
            value={tagsInput}
            onChange={(event) => setTagsInput(event.target.value)}
            className="h-9 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-3 text-sm"
          />
        </label>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-2 gap-3">
        <label className="flex min-h-0 flex-col gap-1 text-[13px] font-medium">
          Mermaid記法
          <textarea
            aria-label="Mermaid記法"
            value={source}
            onChange={(event) => setSource(event.target.value)}
            spellCheck={false}
            className="min-h-[320px] flex-1 resize-none rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] p-3 font-mono text-[13px] leading-relaxed"
          />
          <span className="text-right text-[11px] font-normal text-[var(--fg-subtle)]">
            {sourceBytes.toLocaleString()} / {MAX_SOURCE_BYTES.toLocaleString()} bytes
          </span>
        </label>
        <section className="flex min-h-0 flex-col gap-1" aria-label="Mermaidプレビュー">
          <div className="flex items-center justify-between text-[13px] font-medium">
            <span>プレビュー</span>
            {rendering && (
              <span className="text-xs font-normal text-[var(--fg-muted)]">描画中...</span>
            )}
          </div>
          <div className="flex min-h-[320px] flex-1 items-center justify-center overflow-auto rounded-[var(--radius)] border border-[var(--border)] bg-white p-4 text-slate-900">
            {previewSvg === "" ? (
              <span className="text-sm text-slate-500">プレビューを生成しています...</span>
            ) : (
              <div
                className="max-h-full max-w-full"
                dangerouslySetInnerHTML={{ __html: previewSvg }}
              />
            )}
          </div>
        </section>
      </div>

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

function documentKey(title: string, tags: string, source: string): string {
  return JSON.stringify([title, tags, source]);
}

function safeFileName(value: string): string {
  const sanitized = value.trim().replace(/[\\/:*?"<>|]/g, "-");
  return sanitized || "mermaid";
}
