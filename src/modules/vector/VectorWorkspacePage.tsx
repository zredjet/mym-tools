/**
 * キャンバス (`vector`) の画面 (`docs/canvas-editor-design.md` §5.1 / §7)。
 *
 * 上の作品バー (作品の切替、新規、取込、タイトル、タグ、未保存の表示、保存、削除) と、その下の
 * エディタ (`EditorRoot`) からなる。エディタの状態はエディタの store (`editorStore`) が持ち、
 * この画面は作品の読み込み・保存と、ファイルの入出力の登録 (`canvasIo.ts`) を受け持つ。
 *
 * - 読み込み: payload v2 を `parsePayload` で文書にし、テキストの大きさを求め直してから `load` に渡し、
 *   全体を表示する。読めない payload はエラーを出し、エディタを出さない (編集させない)
 * - 保存: 本文の編集と進行中のジェスチャーを確定してから、`checkSavable` → `toPayload` で保存する。
 *   未保存かどうかは、保存した時点の `revision` とタイトル・タグで判定する
 * - 作品の切替・新規・削除・画面を離れる・ウィンドウを閉じる前に、本文の編集を終えてから未保存を確かめる。
 *   取込の途中は作品を切り替えない
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useBlocker, useLocation, useNavigate, useParams } from "react-router-dom";
import { useHotkeys } from "react-hotkeys-hook";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ChevronsDown, FileDown, FileInput, FilePlus2, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { createItem, updateItem, getItem, deleteItem, listItemSummaries } from "@/ipc/items";
import { registerCloseGuard } from "@/lib/windowClose";
import type { ItemSummary } from "@/lib/types";
import { modulePath } from "@/modules/registry";
import { EditorRoot } from "./editor/EditorRoot";
import {
  importFile,
  importFromPicker,
  setImportFileReader,
  useImportStatus,
} from "./editor/assets";
import { notifyImport } from "./editor/assets/importFile";
import { getImportStatus } from "./editor/assets/status";
import { isEditableTarget } from "./editor/canvas/input";
import { cancelPointerDrag, isPointerDragActive } from "./editor/canvas/pointerDrag";
import { getCanvasViewSize, zoomToFit } from "./editor/canvas/viewCommands";
import { setExportWriter } from "./editor/export";
import { createEmptyDocument } from "./editor/model/create";
import { checkSavable, parsePayload, toPayload } from "./editor/model/payload";
import type { CanvasDocument } from "./editor/model/types";
import { canvasTextMeasurer } from "./editor/render/measureText";
import { editorStore, useEditorStore } from "./editor/state/store";
import { DEFAULT_VIEW_OPTIONS, type Viewport } from "./editor/state/types";
import { commitTextEdit } from "./editor/text/editSession";
import { fitTextNodes } from "./editor/text/fit";
import { resetLastFrameSize } from "./editor/tools/create/frameSize";
import {
  describeInvokeError,
  dropPointOnCanvas,
  exportOriginalSvg,
  pickImportFile,
  readImportPath,
  writeExportFiles,
} from "./canvasIo";

const DEFAULT_TITLE = "新しいキャンバス";
/** store の初期の表示位置。`CanvasView` は、開いたときにこの位置なら全体を表示する */
const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };
const fieldClass =
  "h-8 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-2 text-sm text-[var(--fg)]";
const cleanTags = (value: string) => [
  ...new Set(
    value
      .split(/[,、]/)
      .map((tag) => tag.trim())
      .filter(Boolean),
  ),
];

/**
 * 編集の途中のものを文書に入れる。保存と、未保存の確認の前に呼ぶ (§4.2 / §4.4 / §4.7)。
 *
 * 1. キャンバスのポインターのドラッグは、途中で確定せずに取り消す (Esc と同じ。ツールの `onCancel`)
 * 2. エディタの中の入力欄 (プロパティの数値・色・フォント名、レイヤー名など。blur か Enter で文書に入る)
 *    にフォーカスがあれば、blur して打ちかけの値を入れる。本文の編集欄は 3. の `commitTextEdit` に任せる
 * 3. 本文の編集と、進行中のジェスチャー (色の選択など) を確定する。ジェスチャーを開いた側があとで
 *    更新しても、閉じたジェスチャーへの更新は無視される
 */
function flushEdits(): void {
  cancelPointerDrag();
  const focused = document.activeElement;
  if (
    focused instanceof HTMLElement &&
    focused.closest("[data-canvas-editor]") !== null &&
    !focused.matches("[data-canvas-text-editor]") &&
    isEditableTarget(focused)
  )
    focused.blur();
  commitTextEdit();
  const state = editorStore.getState();
  if (state.gestureActive) state.commitGesture();
}

/** Rust の Eager-on-Read が v1 を v2 へ変換できなかった (行は v1 のまま残っている)。 */
const isUpgradeFailure = (cause: unknown) =>
  typeof cause === "object" &&
  cause !== null &&
  (cause as { code?: unknown }).code === "payload_upgrade_failed";

/** 作品を開けなかった理由 (Rust の Eager-on-Read が v1 を v2 へ変換できなかった場合を含む)。 */
function describeOpenError(cause: unknown): string {
  if (isUpgradeFailure(cause))
    return `この作品は新しい形式に変換できないため開けません。元のデータは変えずに残しています。理由: ${describeInvokeError(cause)}`;
  return describeInvokeError(cause);
}

/**
 * 作品を開けなかったこと。`rescuable` は、変換できない v1 の作品で、元の SVG を書き出せる
 * (`vector_export_original_svg`、ADR-0027)。
 */
interface Failure {
  message: string;
  rescuable: boolean;
}

export function VectorWorkspaceRoute() {
  const location = useLocation();
  const { projectId, itemId } = useParams();
  return (
    <VectorWorkspacePage
      key={`${projectId}:${location.pathname}`}
      projectId={projectId}
      itemId={itemId}
      landing={!location.pathname.endsWith("/new") && !itemId}
      navigationKey={location.key}
    />
  );
}

/** `loading`: 読み込み中 / `ready`: エディタで編集中 / `failed`: 開けなかった (エディタを出さない) */
type Phase = "loading" | "ready" | "failed";

interface Baseline {
  title: string;
  tags: string;
  revision: number;
}

function VectorWorkspacePage({
  projectId,
  itemId,
  landing,
  navigationKey,
}: {
  projectId: string | undefined;
  itemId: string | undefined;
  landing: boolean;
  navigationKey: string;
}) {
  const navigate = useNavigate();
  const busyLock = useRef(false);
  const alive = useRef(true);
  const allowNavigation = useRef(false);
  /** 確認のモーダルが開いているか (OS からのドロップの中で見る) */
  const modalOpenRef = useRef(false);
  const [phase, setPhase] = useState<Phase>("loading");
  const [busy, setBusy] = useState(false);
  const revision = useEditorStore((state) => state.revision);
  /** 本文を編集中で、まだ確定していない変更がある (編集を終えると revision が増える) */
  const pendingText = useEditorStore(
    (state) => state.editingTextId !== null && state.gestureActive,
  );
  const importing = useImportStatus().busy;
  const [currentId, setCurrentId] = useState(itemId);
  const [title, setTitle] = useState(DEFAULT_TITLE);
  const [tags, setTags] = useState("");
  const [baseline, setBaseline] = useState<Baseline>({
    title: DEFAULT_TITLE,
    tags: "",
    revision: 0,
  });
  const [documents, setDocuments] = useState<ItemSummary[]>([]);
  const [hasMore, setHasMore] = useState(false);
  /** 操作 (保存、削除、取込など) のエラー */
  const [error, setError] = useState<string | null>(null);
  /** 作品を開けなかった理由 (`phase === "failed"` の間だけ。操作のエラーとは別に出す) */
  const [failure, setFailure] = useState<Failure | null>(null);
  const [status, setStatus] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [confirmation, setConfirmation] = useState<{ message: string; action: () => void } | null>(
    null,
  );
  const ready = phase === "ready";
  const working = busy || importing;
  const dirty =
    ready && (revision !== baseline.revision || title !== baseline.title || tags !== baseline.tags);

  // 未保存の確認はイベントの中で行うので、最新の値を ref に写しておく
  const latest = useRef({ phase, title, tags, baseline, working, currentId });
  useEffect(() => {
    latest.current = { phase, title, tags, baseline, working, currentId };
  });
  /** 本文の編集とジェスチャーを確定してから、未保存の変更があるか確かめる。 */
  const hasUnsavedChanges = useCallback(() => {
    const now = latest.current;
    if (now.phase !== "ready") return false;
    flushEdits();
    return (
      editorStore.getState().revision !== now.baseline.revision ||
      now.title !== now.baseline.title ||
      now.tags !== now.baseline.tags
    );
  }, []);

  /** 文書をエディタで開く。テキストの大きさを求め直してから `load` に渡し、全体を表示する (§7)。 */
  const openDocument = useCallback(
    (doc: CanvasDocument, meta: { id: string | undefined; title: string; tags: string }) => {
      commitTextEdit();
      const store = editorStore.getState();
      store.load(fitTextNodes(doc, null, canvasTextMeasurer));
      // `load` は表示位置を残すので、既定に戻してから全体を表示する (100% まで)。キャンバスがまだ
      // 無ければ、開いたときに `CanvasView` が (表示位置が既定なので) 全体を表示する
      store.setViewport(DEFAULT_VIEWPORT);
      const size = getCanvasViewSize();
      if (document.querySelector("[data-canvas-view]") && size.width > 0 && size.height > 0)
        zoomToFit({ store: editorStore, size, measurer: canvasTextMeasurer }, 1);
      setCurrentId(meta.id);
      setTitle(meta.title);
      setTags(meta.tags);
      setBaseline({
        title: meta.title,
        tags: meta.tags,
        revision: editorStore.getState().revision,
      });
      setError(null);
      setFailure(null);
      setPhase("ready");
    },
    [],
  );

  // 新規・削除・最初の保存は URL を変えないので、あとでその URL へ移動してもこの画面は作り直されない。
  // そのときは URL の作品を開き直す。編集の途中のものを入れてから (`hasUnsavedChanges`) 未保存を確かめる
  const handledNavigation = useRef(navigationKey);
  useEffect(() => {
    if (handledNavigation.current === navigationKey) return;
    handledNavigation.current = navigationKey;
    if (latest.current.currentId === itemId) return;
    const reopen = () => {
      setPhase("loading");
      setError(null);
      setFailure(null);
      setStatus("");
      setCurrentId(itemId);
      setAttempt((value) => value + 1);
    };
    if (latest.current.working || hasUnsavedChanges())
      setConfirmation({ message: "未保存の変更を破棄しますか？", action: reopen });
    else reopen();
  }, [navigationKey, itemId, hasUnsavedChanges]);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    const page = await listItemSummaries({ projectId, moduleId: "vector" });
    if (alive.current) {
      setDocuments(page);
      setHasMore(page.length === 100);
    }
  }, [projectId]);

  // エディタを開くたびに、フレームのクリックの大きさと表示の設定 (ルーラー、グリッドなど) を
  // 既定へ戻す (§5.5 / §5.6)。画面を離れたら、作品 (大きな画像を含みうる) と履歴を store から外す
  useEffect(() => {
    resetLastFrameSize();
    editorStore.getState().setView(DEFAULT_VIEW_OPTIONS);
    return () => {
      commitTextEdit();
      editorStore.getState().load(createEmptyDocument());
      editorStore.getState().setViewport(DEFAULT_VIEWPORT);
    };
  }, []);

  // ファイルの取込と書き出しを、ファイルのダイアログと Rust の IPC につなぐ (§4.8 / §4.9)
  useEffect(() => {
    const unregisterReader = setImportFileReader(pickImportFile);
    const unregisterWriter = setExportWriter(writeExportFiles);
    return () => {
      unregisterReader();
      unregisterWriter();
    };
  }, []);

  useEffect(() => {
    alive.current = true;
    if (!projectId) return;
    let cancelled = false;
    /** 開こうとした作品の一覧の行 (作品を読めなかったときにタイトルを出す) */
    let known: ItemSummary | undefined;
    void (async () => {
      const list = await listItemSummaries({ projectId, moduleId: "vector" });
      if (cancelled) return;
      known = list.find((entry) => entry.id === itemId);
      if (landing && list[0]) {
        // 入口 (/) から直近の作品へ移すときだけ確認を飛ばす。移したら戻す (残さない)
        allowNavigation.current = true;
        void Promise.resolve(
          navigate(modulePath(projectId, "vector", `/edit/${list[0].id}`), { replace: true }),
        ).finally(() => {
          allowNavigation.current = false;
        });
        return;
      }
      setDocuments(list);
      setHasMore(list.length === 100);
      if (!itemId) {
        openDocument(createEmptyDocument(), { id: undefined, title: DEFAULT_TITLE, tags: "" });
        return;
      }
      const item = await getItem({ moduleId: "vector", itemId });
      if (cancelled) return;
      if (item.project_id !== projectId)
        throw new Error("この作品は現在のプロジェクトに属していません。");
      const parsed = parsePayload(item.payload);
      if (!parsed.ok) {
        // 読めない作品は編集させない (保存で上書きしない)。タイトルと削除は出す
        const itemTags = item.tags.join(", ");
        setCurrentId(item.id);
        setTitle(item.title);
        setTags(itemTags);
        setBaseline({ title: item.title, tags: itemTags, revision: 0 });
        setFailure({ message: `この作品は読み込めません: ${parsed.error}`, rescuable: false });
        setPhase("failed");
        return;
      }
      openDocument(parsed.doc, { id: item.id, title: item.title, tags: item.tags.join(", ") });
    })().catch((cause) => {
      if (cancelled) return;
      // 開けなかった作品のタイトルを、新しい作品の既定のタイトルのまま見せない
      setTitle(known?.title ?? "");
      setTags(known?.tags.join(", ") ?? "");
      setFailure({
        message: describeOpenError(cause),
        rescuable: isUpgradeFailure(cause) && itemId !== undefined,
      });
      setPhase("failed");
    });
    return () => {
      cancelled = true;
      alive.current = false;
    };
  }, [projectId, itemId, landing, navigate, attempt, openDocument]);

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      !allowNavigation.current &&
      currentLocation.pathname !== nextLocation.pathname &&
      (latest.current.working || hasUnsavedChanges()),
  );
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (!latest.current.working && !hasUnsavedChanges()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", unload);
    // ウィンドウを閉じる要求は App の単一 listener が調停する (`src/lib/windowClose.ts`)
    const unregister = registerCloseGuard({
      shouldBlock: () =>
        !allowNavigation.current && (latest.current.working || hasUnsavedChanges()),
      onBlocked: (proceed) => {
        // 閉じ直しの間は `windowClose.ts` の `closeConfirmed` がガードを飛ばす。閉じるのに失敗しても
        // 以後の確認が効くよう、ここでは `allowNavigation` を立てない
        setConfirmation({
          message: "未保存の変更を破棄してウィンドウを閉じますか？",
          action: proceed,
        });
      },
    });
    return () => {
      unregister();
      window.removeEventListener("beforeunload", unload);
    };
  }, [hasUnsavedChanges]);

  const run = useCallback(async (task: () => Promise<void>, { requireReady = true } = {}) => {
    if (busyLock.current || (requireReady && latest.current.phase !== "ready")) return;
    busyLock.current = true;
    setBusy(true);
    setError(null);
    setStatus("");
    try {
      await task();
    } catch (cause) {
      if (alive.current) setError(describeInvokeError(cause));
    } finally {
      busyLock.current = false;
      if (alive.current) setBusy(false);
    }
  }, []);

  const save = useCallback(
    () =>
      run(async () => {
        if (!projectId || !title.trim()) throw new Error("タイトルを入力してください。");
        // 本文の編集と進行中のジェスチャーを確定してから文書を取り出す (§4.2)
        flushEdits();
        const state = editorStore.getState();
        const problem = checkSavable(state.doc);
        if (problem !== null) throw new Error(`保存できません: ${problem}`);
        const payload = toPayload(state.doc);
        const saved: Baseline = { title, tags, revision: state.revision };
        const input = { moduleId: "vector", title: title.trim(), tags: cleanTags(tags), payload };
        let id = currentId;
        if (id) await updateItem({ ...input, itemId: id });
        else id = await createItem({ ...input, projectId });
        if (!alive.current) return;
        setCurrentId(id);
        // 保存の途中の編集は、次の未保存の内容として残す (取り出した時点の revision と比べる)
        setBaseline(saved);
        setStatus("保存しました");
        await refresh();
      }),
    [run, projectId, title, tags, currentId, refresh],
  );

  /** 未保存の変更を破棄してよいか確かめてから `action` を行う。処理中と取込の途中は何もしない。 */
  const guard = useCallback(
    (action: () => void) => {
      if (busyLock.current) return;
      if (getImportStatus().busy) {
        setStatus("取り込みが終わるまでお待ちください。");
        return;
      }
      if (hasUnsavedChanges()) setConfirmation({ message: "未保存の変更を破棄しますか？", action });
      else action();
    },
    [hasUnsavedChanges],
  );
  const newDocument = useCallback(() => {
    if (latest.current.phase === "loading") return;
    guard(() => {
      openDocument(createEmptyDocument(), { id: undefined, title: DEFAULT_TITLE, tags: "" });
      setStatus("新しい作品を開きました");
    });
  }, [guard, openDocument]);

  // ポインターのドラッグの途中は、保存と新規のキーを受けない (§4.4。ドラッグを途中で確定しない)
  useHotkeys(
    "mod+s",
    (event) => {
      event.preventDefault();
      if (isPointerDragActive()) return;
      if (confirmation === null && blocker.state !== "blocked") void save();
    },
    { enableOnFormTags: true },
    [save, confirmation, blocker.state],
  );
  useHotkeys(
    "mod+n",
    (event) => {
      event.preventDefault();
      if (isPointerDragActive()) return;
      if (confirmation === null && blocker.state !== "blocked") newDocument();
    },
    { enableOnFormTags: true },
    [newDocument, confirmation, blocker.state],
  );

  /** 作品バーの「取込」: 今の作品に画像や SVG を置く (ツールバーの「画像」と同じ、§4.8)。 */
  const importIntoDocument = () => {
    const state = editorStore.getState();
    if (state.toolId !== "select") state.setTool("select");
    void importFromPicker(editorStore);
  };

  // OS からのドロップ (Tauri の webview のイベント。HTML5 のドラッグ&ドロップは使わない)。
  // ファイルを読む間も作品を切り替えないよう、画面の処理中として扱う
  const dropRef = useRef<(paths: string[], position: { x: number; y: number }) => void>(() => {});
  useEffect(() => {
    dropRef.current = (paths, position) => {
      const path = paths[0];
      if (path === undefined || latest.current.phase !== "ready") return;
      // 確認のモーダルの間は受け付けない (「破棄しますか？」の裏で文書を変えない)
      if (modalOpenRef.current) {
        notifyImport(editorStore, {
          tone: "error",
          message: "確認を閉じてから、もう一度ドロップしてください。",
        });
        return;
      }
      if (busyLock.current || getImportStatus().busy) {
        notifyImport(editorStore, {
          tone: "error",
          message:
            "ほかの処理の途中のため、取り込みませんでした。終わってからもう一度試してください。",
        });
        return;
      }
      const at = dropPointOnCanvas(position, editorStore.getState().viewport);
      void run(async () => {
        let file;
        try {
          file = await readImportPath(path);
        } catch (cause) {
          notifyImport(editorStore, {
            tone: "error",
            message: `ファイルを読み込めません: ${describeInvokeError(cause)}`,
          });
          return;
        }
        if (!alive.current) return;
        await importFile(editorStore, file, at ? { at } : {});
      });
    };
  });
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "over" || event.payload.type === "enter") setDragOver(true);
        else if (event.payload.type === "drop") {
          setDragOver(false);
          dropRef.current(event.payload.paths, event.payload.position);
        } else setDragOver(false);
      })
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch((cause: unknown) => {
        if (!disposed) setError(describeInvokeError(cause));
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const modalOpen = blocker.state === "blocked" || confirmation !== null;
  useEffect(() => {
    modalOpenRef.current = modalOpen;
  });

  if (!projectId) return <p>プロジェクトを選択してください。</p>;
  return (
    <div className="flex h-full min-h-[560px] flex-col gap-2 px-[var(--page-pad)] py-3">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="mr-2 text-lg font-semibold">キャンバス</h1>
        <select
          aria-label="作品を切り替え"
          className={fieldClass}
          value={currentId ?? ""}
          disabled={working || phase === "loading"}
          onChange={(event) => {
            if (event.currentTarget.value)
              navigate(modulePath(projectId, "vector", `/edit/${event.currentTarget.value}`));
          }}
        >
          <option value="">新しい作品</option>
          {currentId && !documents.some((item) => item.id === currentId) && (
            <option value={currentId}>{baseline.title}</option>
          )}
          {documents.map((item) => (
            <option key={item.id} value={item.id}>
              {item.title}
            </option>
          ))}
        </select>
        {hasMore && (
          <Button
            disabled={working}
            onClick={() =>
              void run(
                async () => {
                  const page = await listItemSummaries({
                    moduleId: "vector",
                    projectId,
                    offset: documents.length,
                  });
                  setDocuments((old) => [...old, ...page]);
                  setHasMore(page.length === 100);
                },
                { requireReady: false },
              )
            }
          >
            <ChevronsDown size={14} aria-hidden /> さらに読込
          </Button>
        )}
        <Button
          disabled={phase === "loading" || working}
          title="新しい作品を開く (⌘N)"
          onClick={newDocument}
        >
          <FilePlus2 size={14} aria-hidden /> 新規
        </Button>
        <Button
          disabled={!ready || working}
          title="画像 (PNG / JPEG / WebP) や SVG ファイルを、今の作品に置く"
          onClick={importIntoDocument}
        >
          <FileInput size={14} aria-hidden /> 取込
        </Button>
        <span role="status" className="ml-auto min-w-0 truncate text-xs text-[var(--fg-muted)]">
          {status}
        </span>
        <span className="text-xs text-[var(--fg-muted)]">
          {working
            ? "処理中…"
            : dirty || pendingText
              ? "未保存"
              : ready
                ? "保存済み"
                : phase === "loading"
                  ? "読み込み中…"
                  : ""}
        </span>
        <Button
          variant="primary"
          disabled={!ready || working || !title.trim()}
          title="プロジェクトに保存する (⌘S)"
          onClick={() => void save()}
        >
          <Save size={14} aria-hidden /> 保存
          <span className="text-[10px] opacity-70">⌘S</span>
        </Button>
      </header>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm">
          タイトル
          <input
            className={`${fieldClass} w-64`}
            disabled={!ready}
            value={title}
            onChange={(event) => setTitle(event.currentTarget.value)}
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          タグ
          <input
            className={`${fieldClass} w-48`}
            placeholder="カンマ区切り"
            disabled={!ready}
            value={tags}
            onChange={(event) => setTags(event.currentTarget.value)}
          />
        </label>
        {currentId && phase !== "loading" && (
          <Button
            variant="ghost"
            disabled={working}
            onClick={() => {
              flushEdits();
              setConfirmation({
                message: failure?.rescuable
                  ? "この作品を削除しますか？ 削除すると元に戻せません。先に「元の SVG を書き出す」で中身を取り出せます。"
                  : "この作品を削除しますか？",
                action: () =>
                  void run(
                    async () => {
                      await deleteItem({ moduleId: "vector", itemId: currentId });
                      if (!alive.current) return;
                      openDocument(createEmptyDocument(), {
                        id: undefined,
                        title: DEFAULT_TITLE,
                        tags: "",
                      });
                      setStatus("削除しました");
                      await refresh();
                    },
                    { requireReady: false },
                  ),
              });
            }}
          >
            <Trash2 size={14} aria-hidden /> 削除
          </Button>
        )}
      </div>
      {phase === "failed" && failure && (
        <div role="alert" className="flex items-center gap-2 text-sm text-[var(--destructive)]">
          <span className="min-w-0 break-words">{failure.message}</span>
          {failure.rescuable && currentId && (
            <Button
              className="shrink-0"
              disabled={working}
              onClick={() =>
                void run(
                  async () => {
                    if (await exportOriginalSvg(currentId, title))
                      if (alive.current) setStatus("元の SVG を書き出しました");
                  },
                  { requireReady: false },
                )
              }
            >
              <FileDown size={14} aria-hidden /> 元の SVG を書き出す
            </Button>
          )}
          <Button
            className="shrink-0"
            disabled={working}
            onClick={() => {
              setError(null);
              setFailure(null);
              setPhase("loading");
              setAttempt((value) => value + 1);
            }}
          >
            再試行
          </Button>
        </div>
      )}
      {error && (
        <div role="alert" className="flex items-center gap-2 text-sm text-[var(--destructive)]">
          <span className="min-w-0 break-words">{error}</span>
        </div>
      )}
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-[var(--radius)] border border-[var(--border)]">
        {ready ? (
          <EditorRoot />
        ) : (
          <p className="p-6 text-sm text-[var(--fg-muted)]">
            {phase === "loading"
              ? "作品を読み込んでいます…"
              : "この作品は開けません。ほかの作品を選ぶか、新規で作り直してください。"}
          </p>
        )}
        {dragOver && ready && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 rounded-[var(--radius)] ring-2 ring-[var(--accent)] ring-inset"
          />
        )}
      </div>
      <Modal
        open={modalOpen}
        title="変更の確認"
        onClose={() => {
          setConfirmation(null);
          if (blocker.state === "blocked") blocker.reset();
        }}
      >
        <p className="text-sm">
          {working
            ? "処理が完了するまでお待ちください。"
            : (confirmation?.message ?? "未保存の変更を破棄して移動しますか？")}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button
            onClick={() => {
              setConfirmation(null);
              if (blocker.state === "blocked") blocker.reset();
            }}
          >
            戻る
          </Button>
          <Button
            variant="destructive"
            disabled={working}
            onClick={() => {
              if (confirmation) {
                const action = confirmation.action;
                setConfirmation(null);
                action();
              } else if (blocker.state === "blocked") blocker.proceed();
            }}
          >
            続行
          </Button>
        </div>
      </Modal>
    </div>
  );
}
