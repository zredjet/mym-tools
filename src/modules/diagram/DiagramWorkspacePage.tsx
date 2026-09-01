import { useCallback, useEffect, useRef, useState } from "react";
import { Download, FileInput, FilePlus2, Save } from "lucide-react";
import { useHotkeys } from "react-hotkeys-hook";
import { useBlocker, useLocation, useNavigate, useParams } from "react-router-dom";
import { open, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";

import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import {
  diagramEditorUrl as requestDiagramEditorUrl,
  diagramReadFile,
  diagramWriteFile,
} from "@/ipc/diagram";
import { createItem, getItem, listAllItems, updateItem } from "@/ipc/items";
import { formatInvokeError } from "@/lib/error";
import type { DiagramPayloadV1, Item } from "@/lib/types";
import { modulePath } from "@/modules/registry";

import {
  drawioEditorUrl,
  drawioExportMessage,
  drawioLoadMessage,
  drawioTargetOrigin,
  isTrustedDrawioOrigin,
  parseDrawioMessage,
  type DrawioExportFormat,
} from "./drawioBridge";

const MAX_DIAGRAM_BYTES = 1024 * 1024;
const EMPTY_DIAGRAM =
  '<mxfile host="MyMyTools"><diagram name="Page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';

type LoadKind = "initial" | "import";
interface PendingTextRequest {
  id: string;
  xml: string;
}

interface PendingExportRequest {
  id: string;
  format: DrawioExportFormat;
  path: string;
}

export function DiagramLandingPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (projectId == null) return;
    let cancelled = false;
    void listAllItems({ moduleId: "diagram", projectId })
      .then((items) => {
        if (cancelled) return;
        const recent = [...items].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
        navigate(modulePath(projectId, "diagram", recent ? `/edit/${recent.id}` : "/new"), {
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
      {error ?? "直近のダイアグラムを読み込んでいます..."}
    </div>
  );
}

export function DiagramWorkspaceRoute() {
  const { itemId } = useParams<{ itemId?: string }>();
  const location = useLocation();
  return <DiagramWorkspacePage key={`${itemId ?? "new"}:${location.pathname}`} />;
}

export function DiagramWorkspacePage() {
  const { projectId, itemId } = useParams<{ projectId: string; itemId?: string }>();
  const navigate = useNavigate();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const allowNavigation = useRef(false);
  const initialized = useRef(false);
  const loadKind = useRef<LoadKind>("initial");
  const pendingText = useRef<PendingTextRequest | null>(null);
  const pendingExport = useRef<PendingExportRequest | null>(null);
  const exportInFlight = useRef(false);
  const [editorUrl, setEditorUrl] = useState<string | null>(null);
  const [editorOrigin, setEditorOrigin] = useState<string | null>(null);
  const [documents, setDocuments] = useState<Item[]>([]);
  const [title, setTitle] = useState(itemId == null ? "新しいダイアグラム" : "");
  const [tagsInput, setTagsInput] = useState("");
  const [xml, setXml] = useState(EMPTY_DIAGRAM);
  const [baseline, setBaseline] = useState(() =>
    documentKey("新しいダイアグラム", "", EMPTY_DIAGRAM),
  );
  const [loading, setLoading] = useState(itemId != null);
  const [editorReady, setEditorReady] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [exportingFormat, setExportingFormat] = useState<DrawioExportFormat | null>(null);
  const [status, setStatus] = useState("エディタを起動しています...");
  const [error, setError] = useState<string | null>(null);

  const refreshDocuments = useCallback(async () => {
    if (projectId == null) return;
    const items = await listAllItems({ moduleId: "diagram", projectId });
    setDocuments([...items].sort((a, b) => b.updated_at.localeCompare(a.updated_at)));
  }, [projectId]);

  useEffect(() => {
    if (projectId == null) return;
    let cancelled = false;
    void listAllItems({ moduleId: "diagram", projectId })
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
    let cancelled = false;
    void requestDiagramEditorUrl()
      .then((baseUrl) => {
        if (cancelled) return;
        const url = drawioEditorUrl(baseUrl);
        setEditorUrl(url);
        setEditorOrigin(drawioTargetOrigin(url));
      })
      .catch((cause) => {
        if (!cancelled) setError(formatInvokeError(cause));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (itemId == null) return;
    let cancelled = false;
    void getItem({ moduleId: "diagram", itemId })
      .then((item) => {
        if (cancelled) return;
        const payload = item.payload as Partial<DiagramPayloadV1>;
        const nextXml = payload.xml ?? EMPTY_DIAGRAM;
        const nextTags = item.tags.join(", ");
        setTitle(item.title);
        setTagsInput(nextTags);
        setXml(nextXml);
        setBaseline(documentKey(item.title, nextTags, nextXml));
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

  const postToEditor = useCallback(
    (message: object | string) => {
      const target = iframeRef.current?.contentWindow;
      if (target == null || editorOrigin == null) {
        throw new Error("ダイアグラムエディタが準備できていません。");
      }
      target.postMessage(
        typeof message === "string" ? message : JSON.stringify(message),
        editorOrigin,
      );
    },
    [editorOrigin],
  );

  const persist = useCallback(
    async (nextXml: string, text: string) => {
      if (
        projectId == null ||
        submitting ||
        title.trim() === "" ||
        utf8Size(nextXml) > MAX_DIAGRAM_BYTES ||
        utf8Size(text) > MAX_DIAGRAM_BYTES
      ) {
        setError("タイトル、XML、検索用テキストを確認してください（各1MiB以下）。");
        return;
      }
      setSubmitting(true);
      setError(null);
      const tags = parseTags(tagsInput);
      const normalizedTitle = title.trim();
      const payload: DiagramPayloadV1 = { xml: nextXml, text };
      try {
        let savedId = itemId;
        if (savedId == null) {
          savedId = await createItem({
            moduleId: "diagram",
            projectId,
            title: normalizedTitle,
            tags,
            payload,
          });
        } else {
          await updateItem({
            moduleId: "diagram",
            itemId: savedId,
            title: normalizedTitle,
            tags,
            payload,
          });
        }
        setTitle(normalizedTitle);
        setTagsInput(tags.join(", "));
        setXml(nextXml);
        setBaseline(documentKey(normalizedTitle, tags.join(", "), nextXml));
        setStatus("保存しました");
        await refreshDocuments();
        if (itemId == null) {
          allowNavigation.current = true;
          navigate(modulePath(projectId, "diagram", `/edit/${savedId}`), { replace: true });
        }
      } catch (cause) {
        setError(formatInvokeError(cause));
      } finally {
        setSubmitting(false);
      }
    },
    [itemId, navigate, projectId, refreshDocuments, submitting, tagsInput, title],
  );

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (
        event.source !== iframeRef.current?.contentWindow ||
        editorOrigin == null ||
        !isTrustedDrawioOrigin(event.origin, editorOrigin)
      ) {
        return;
      }
      const message = parseDrawioMessage(event.data);
      if (message == null) {
        setError("ダイアグラムエディタから不正なメッセージを拒否しました。");
        return;
      }
      if (message.event === "init") {
        if (initialized.current) {
          setError("ダイアグラムエディタの重複initを拒否しました。");
          return;
        }
        initialized.current = true;
        loadKind.current = "initial";
        postToEditor(drawioLoadMessage(xml, title));
        return;
      }
      if (!initialized.current) {
        setError("init前のダイアグラムイベントを拒否しました。");
        return;
      }

      if (message.event === "load") {
        const loadedXml = message.xml ?? xml;
        if (utf8Size(loadedXml) > MAX_DIAGRAM_BYTES) {
          setError("ダイアグラムXMLが1MiBを超えたため拒否しました。");
          return;
        }
        setXml(loadedXml);
        setEditorReady(true);
        setStatus(loadKind.current === "import" ? "取込内容を編集中（未保存）" : "編集できます");
        return;
      }

      if (message.event === "autosave") {
        if (utf8Size(message.xml) > MAX_DIAGRAM_BYTES) {
          setError("ダイアグラムXMLが1MiBを超えたため変更を拒否しました。");
          return;
        }
        setXml(message.xml);
        setStatus("未保存の変更があります");
        return;
      }

      if (message.event === "save") {
        if (utf8Size(message.xml) > MAX_DIAGRAM_BYTES) {
          setError("ダイアグラムXMLは1MiB以下にしてください。保存を中止しました。");
          return;
        }
        setXml(message.xml);
        const requestId = crypto.randomUUID();
        pendingText.current = { id: requestId, xml: message.xml };
        postToEditor({ action: "textContent", requestId });
        setStatus("検索用テキストを取得しています...");
        return;
      }

      if (message.event === "textContent") {
        const pending = pendingText.current;
        if (pending == null || message.requestId !== pending.id) {
          setError("順序が不正なtextContentイベントを拒否しました。");
          return;
        }
        pendingText.current = null;
        if (utf8Size(message.data) > MAX_DIAGRAM_BYTES) {
          setError("検索用テキストが1MiBを超えたため保存を中止しました。");
          return;
        }
        void persist(pending.xml, message.data);
        return;
      }

      if (message.event === "export") {
        const pending = pendingExport.current;
        if (
          pending == null ||
          message.requestId !== pending.id ||
          (message.format != null && message.format !== pending.format)
        ) {
          setError("順序が不正なexportイベントを拒否しました。");
          return;
        }
        pendingExport.current = null;
        void diagramWriteFile({ path: pending.path, format: pending.format, data: message.data })
          .then(() => setStatus(`${pending.format.toUpperCase()}を書き出しました`))
          .catch((cause) => setError(formatInvokeError(cause)))
          .finally(() => {
            exportInFlight.current = false;
            setExportingFormat(null);
          });
        return;
      }

      if (message.event === "openLink") {
        let url: URL;
        try {
          url = new URL(message.href);
        } catch {
          setError("無効なリンクを拒否しました。");
          return;
        }
        if (!["http:", "https:"].includes(url.protocol)) {
          setError("HTTP(S)以外のリンクを拒否しました。");
          return;
        }
        if (window.confirm(`外部ブラウザで開きますか?\n${url.toString()}`)) {
          void openUrl(url).catch((cause) => setError(formatInvokeError(cause)));
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [editorOrigin, persist, postToEditor, tagsInput, title, xml]);

  const dirty = documentKey(title, tagsInput, xml) !== baseline;
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

  const requestSave = useCallback(() => {
    if (!editorReady || submitting || title.trim() === "") return;
    setError(null);
    setStatus("保存データを取得しています...");
    postToEditor({ action: "invokeAction", actionName: "save" });
  }, [editorReady, postToEditor, submitting, title]);

  useHotkeys(
    "mod+s",
    (event) => {
      event.preventDefault();
      requestSave();
    },
    { enableOnFormTags: true },
    [requestSave],
  );

  const importDiagram = async () => {
    try {
      const path = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "draw.io diagram", extensions: ["drawio", "xml"] }],
      });
      if (path == null) return;
      const importedXml = await diagramReadFile(path);
      const importedTitle = fileStem(path);
      setTitle(importedTitle || title);
      setXml(importedXml);
      loadKind.current = "import";
      postToEditor(drawioLoadMessage(importedXml, importedTitle || title));
    } catch (cause) {
      setError(formatInvokeError(cause));
    }
  };

  const exportDrawio = async () => {
    try {
      const path = await saveDialog({
        defaultPath: `${safeFileName(title)}.drawio`,
        filters: [{ name: "draw.io diagram", extensions: ["drawio"] }],
      });
      if (path == null) return;
      await diagramWriteFile({ path, format: "drawio", data: xml });
      setStatus(".drawioを書き出しました");
    } catch (cause) {
      setError(formatInvokeError(cause));
    }
  };

  const exportImage = async (format: DrawioExportFormat) => {
    if (exportInFlight.current) return;
    exportInFlight.current = true;
    setExportingFormat(format);
    try {
      const path = await saveDialog({
        defaultPath: `${safeFileName(title)}.${format}`,
        filters: [{ name: format.toUpperCase(), extensions: [format] }],
      });
      if (path == null) {
        exportInFlight.current = false;
        setExportingFormat(null);
        return;
      }
      const requestId = crypto.randomUUID();
      pendingExport.current = { id: requestId, format, path };
      postToEditor(drawioExportMessage(format, requestId));
      setStatus(`${format.toUpperCase()}を生成しています...`);
    } catch (cause) {
      pendingExport.current = null;
      exportInFlight.current = false;
      setExportingFormat(null);
      setError(formatInvokeError(cause));
    }
  };

  if (projectId == null)
    return <div className="p-6 text-sm">プロジェクトが選択されていません。</div>;
  if (loading)
    return (
      <div className="p-6 text-sm text-[var(--fg-muted)]">ダイアグラムを読み込んでいます...</div>
    );

  return (
    <div className="flex h-full min-h-[560px] flex-col px-[var(--page-pad)] py-3">
      <header className="mb-2 flex flex-wrap items-center gap-2">
        <h1 className="mr-1 text-lg font-semibold">ダイアグラム</h1>
        <label className="sr-only" htmlFor="diagram-document">
          ドキュメント
        </label>
        <select
          id="diagram-document"
          value={itemId ?? "__new"}
          onChange={(event) => {
            const id = event.target.value;
            navigate(modulePath(projectId, "diagram", id === "__new" ? "/new" : `/edit/${id}`));
          }}
          className="h-8 min-w-44 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-2 text-sm"
        >
          <option value="__new">新規キャンバス</option>
          {documents.map((document) => (
            <option key={document.id} value={document.id}>
              {document.title}
            </option>
          ))}
        </select>
        <Button onClick={() => navigate(modulePath(projectId, "diagram", "/new"))}>
          <FilePlus2 size={14} /> 新規
        </Button>
        <Button disabled={!editorReady} onClick={() => void importDiagram()}>
          <FileInput size={14} /> 取込
        </Button>
        <Button
          disabled={!editorReady || exportingFormat != null}
          onClick={() => void exportDrawio()}
        >
          <Download size={14} /> .drawio
        </Button>
        <Button
          disabled={!editorReady || exportingFormat != null}
          onClick={() => void exportImage("svg")}
        >
          {exportingFormat === "svg" ? "SVG生成中..." : "SVG"}
        </Button>
        <Button
          disabled={!editorReady || exportingFormat != null}
          onClick={() => void exportImage("png")}
        >
          {exportingFormat === "png" ? "PNG生成中..." : "PNG"}
        </Button>
        <span className="ml-auto text-xs text-[var(--fg-muted)]">{dirty ? "未保存" : status}</span>
        <Button
          variant="primary"
          disabled={!editorReady || submitting || title.trim() === ""}
          onClick={requestSave}
        >
          <Save size={14} /> {submitting ? "保存中..." : "保存"}
          <span className="text-[10px] opacity-70">⌘S</span>
        </Button>
      </header>

      <div className="mb-2 grid grid-cols-[minmax(180px,2fr)_minmax(140px,1fr)] gap-2">
        <label className="flex items-center gap-2 text-[13px] font-medium">
          <span className="shrink-0">タイトル</span>
          <input
            maxLength={200}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className="h-8 min-w-0 flex-1 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-2 text-sm"
          />
        </label>
        <label className="flex items-center gap-2 text-[13px] font-medium">
          <span className="shrink-0">タグ</span>
          <input
            maxLength={200}
            value={tagsInput}
            onChange={(event) => setTagsInput(event.target.value)}
            placeholder="design, flow"
            className="h-8 min-w-0 flex-1 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-2 text-sm"
          />
        </label>
      </div>

      {error != null && (
        <div
          role="alert"
          className="mb-2 rounded-[var(--radius)] bg-[var(--bg-muted)] px-3 py-2 text-sm text-[var(--destructive)]"
        >
          {error}
        </div>
      )}

      {editorUrl == null ? (
        <div className="flex min-h-[420px] flex-1 items-center justify-center rounded-[var(--radius)] border border-[var(--border)] bg-white text-sm text-slate-500">
          オフラインエディタを起動しています...
        </div>
      ) : (
        <iframe
          ref={iframeRef}
          title="draw.io オフラインエディタ"
          src={editorUrl}
          sandbox="allow-scripts allow-same-origin"
          referrerPolicy="no-referrer"
          className="min-h-[420px] flex-1 rounded-[var(--radius)] border border-[var(--border)] bg-white"
        />
      )}

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

function documentKey(title: string, tags: string, xml: string): string {
  return JSON.stringify([title, tags, xml]);
}

function utf8Size(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function fileStem(path: string): string {
  return (
    path
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.(?:drawio|xml)$/i, "") ?? ""
  );
}

function safeFileName(value: string): string {
  const sanitized = value.trim().replace(/[\\/:*?"<>|]/g, "-");
  return sanitized || "diagram";
}
