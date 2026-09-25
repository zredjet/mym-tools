import { useCallback, useEffect, useRef, useState } from "react";
import { useBlocker, useLocation, useNavigate, useParams } from "react-router-dom";
import { useHotkeys } from "react-hotkeys-hook";
import { open, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { createItem, updateItem, getItem, deleteItem, listItemSummaries } from "@/ipc/items";
import { vectorEditorUrl, vectorReadFile, vectorReadImage, vectorWriteFile } from "@/ipc/vector";
import { formatInvokeError } from "@/lib/error";
import { registerCloseGuard } from "@/lib/windowClose";
import type { ItemSummary, VectorPayloadV1 } from "@/lib/types";
import { modulePath } from "@/modules/registry";
import { VectorBridge, vectorUrl, type VectorMessage } from "./bridge";
import { validateSvg } from "../../../scripts/svgedit/svg-policy.js";
import policy from "../../../scripts/svgedit/policy.json";

const EMPTY =
  '<svg xmlns="http://www.w3.org/2000/svg" xmlns:svg="http://www.w3.org/2000/svg" width="640" height="480"><g><title>レイヤー 1</title></g></svg>';
const DEFAULT_TITLE = "新しいベクター描画";
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
  const iframe = useRef<HTMLIFrameElement>(null);
  const bridge = useRef<VectorBridge | null>(null);
  const documentId = useRef(crypto.randomUUID());
  const liveRevision = useRef(0);
  const busyLock = useRef(false);
  const alive = useRef(true);
  const allowNavigation = useRef(false);
  const closeState = useRef({ dirty: false, busy: false });
  const actions = useRef<(action: string) => void>(() => {});
  const [url, setUrl] = useState("");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [currentId, setCurrentId] = useState(itemId);
  const [title, setTitle] = useState(DEFAULT_TITLE);
  const [tags, setTags] = useState("");
  const [baseline, setBaseline] = useState({ title: DEFAULT_TITLE, tags: "", revision: 0 });
  const [documents, setDocuments] = useState<ItemSummary[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [confirmation, setConfirmation] = useState<{ message: string; action: () => void } | null>(
    null,
  );
  const dirty =
    ready && (revision !== baseline.revision || title !== baseline.title || tags !== baseline.tags);
  // New/import/delete and first saves keep the URL, so a later navigation to
  // that URL does not remount this page. Reopen the route's document instead.
  const [handledNavigation, setHandledNavigation] = useState(navigationKey);
  if (handledNavigation !== navigationKey) {
    setHandledNavigation(navigationKey);
    if (currentId !== itemId) {
      const reopen = () => {
        setReady(false);
        setUrl("");
        setError(null);
        setStatus("");
        setCurrentId(itemId);
        setAttempt((value) => value + 1);
      };
      if (dirty || busy)
        setConfirmation({ message: "未保存の変更を破棄しますか？", action: reopen });
      else reopen();
    }
  }

  const refresh = useCallback(async () => {
    if (!projectId) return;
    const page = await listItemSummaries({ projectId, moduleId: "vector" });
    if (alive.current) {
      setDocuments(page);
      setHasMore(page.length === 100);
    }
  }, [projectId]);

  useEffect(() => {
    alive.current = true;
    if (!projectId) return;
    let cancelled = false;
    let client: VectorBridge | undefined;
    const onMessage = (message: VectorMessage) => {
      if (
        message.event === "changed" &&
        message.documentId === documentId.current &&
        Number.isSafeInteger(message.revision) &&
        message.revision! >= liveRevision.current
      ) {
        liveRevision.current = message.revision!;
        setRevision(message.revision!);
      } else if (
        message.event === "action" &&
        message.documentId === documentId.current &&
        message.action
      )
        actions.current(message.action);
    };
    void (async () => {
      const list = await listItemSummaries({ projectId, moduleId: "vector" });
      if (cancelled) return;
      if (landing && list[0]) {
        allowNavigation.current = true;
        navigate(modulePath(projectId, "vector", `/edit/${list[0].id}`), { replace: true });
        return;
      }
      setDocuments(list);
      setHasMore(list.length === 100);
      const item = itemId ? await getItem({ moduleId: "vector", itemId }) : null;
      if (item && item.project_id !== projectId)
        throw new Error("この作品は現在のプロジェクトに属していません。");
      const payload = item
        ? validateSvg((item.payload as VectorPayloadV1).svg, policy)
        : validateSvg(EMPTY, policy);
      const initialTitle = item?.title ?? DEFAULT_TITLE;
      const initialTags = item?.tags.join(", ") ?? "";
      const baseUrl = await vectorEditorUrl();
      if (cancelled) return;
      client = new VectorBridge(
        () => iframe.current?.contentWindow ?? null,
        new URL(baseUrl).origin,
        onMessage,
      );
      bridge.current = client;
      setTitle(initialTitle);
      setTags(initialTags);
      setUrl(vectorUrl(baseUrl, client.session));
      await client.ready;
      await client.request("load", documentId.current, { svg: payload.svg });
      if (cancelled) return;
      liveRevision.current = 0;
      setRevision(0);
      setBaseline({ title: initialTitle, tags: initialTags, revision: 0 });
      setReady(true);
    })().catch((cause) => {
      if (!cancelled) setError(formatInvokeError(cause));
    });
    return () => {
      cancelled = true;
      alive.current = false;
      client?.dispose();
      bridge.current = null;
    };
  }, [projectId, itemId, landing, navigate, attempt]);

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      !allowNavigation.current &&
      (dirty || busy) &&
      currentLocation.pathname !== nextLocation.pathname,
  );
  useEffect(() => {
    closeState.current = { dirty, busy };
  }, [dirty, busy]);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (!closeState.current.dirty && !closeState.current.busy) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", unload);
    // ウィンドウを閉じる要求は App の単一 listener が調停する (`src/lib/windowClose.ts`)
    const unregister = registerCloseGuard({
      shouldBlock: () =>
        !allowNavigation.current && (closeState.current.dirty || closeState.current.busy),
      onBlocked: (proceed) => {
        setConfirmation({
          message: "未保存の変更を破棄してウィンドウを閉じますか？",
          action: () => {
            allowNavigation.current = true;
            proceed();
          },
        });
      },
    });
    return () => {
      unregister();
      window.removeEventListener("beforeunload", unload);
    };
  }, []);

  const run = useCallback(
    async (task: () => Promise<void>) => {
      if (busyLock.current || !ready) return;
      busyLock.current = true;
      setBusy(true);
      setError(null);
      setStatus("");
      try {
        await task();
      } catch (cause) {
        if (alive.current) setError(formatInvokeError(cause));
      } finally {
        busyLock.current = false;
        if (alive.current) setBusy(false);
      }
    },
    [ready],
  );
  const request = useCallback((action: string, fields: Record<string, unknown> = {}) => {
    if (!bridge.current) throw new Error("エディタに接続できません。");
    return bridge.current.request(action, documentId.current, fields);
  }, []);
  const save = useCallback(
    () =>
      run(async () => {
        if (!projectId || !title.trim()) throw new Error("タイトルを入力してください。");
        const snapshot = await request("snapshot");
        if (snapshot.svg == null || !Number.isSafeInteger(snapshot.revision))
          throw new Error("保存データが不正です。");
        const payload = validateSvg(snapshot.svg, policy);
        const input = { moduleId: "vector", title: title.trim(), tags: cleanTags(tags), payload };
        let id = currentId;
        if (id) await updateItem({ ...input, itemId: id });
        else id = await createItem({ ...input, projectId });
        if (!alive.current) return;
        setCurrentId(id);
        // Compare against the requested snapshot, never the latest changed event.
        setBaseline({ title, tags, revision: snapshot.revision! });
        setStatus("保存しました");
        await refresh();
      }),
    [run, projectId, title, tags, currentId, request, refresh],
  );
  useHotkeys(
    "mod+s",
    (event) => {
      event.preventDefault();
      void save();
    },
    { enableOnFormTags: true },
    [save],
  );

  const replaceDocument = useCallback(async (svg: string, nextTitle: string, imported: boolean) => {
    validateSvg(svg, policy);
    const nextId = crypto.randomUUID();
    if (!bridge.current) throw new Error("エディタに接続できません。");
    await bridge.current.request("load", nextId, { svg });
    documentId.current = nextId;
    liveRevision.current = 0;
    setCurrentId(undefined);
    setTitle(nextTitle);
    setTags("");
    setRevision(0);
    setBaseline({ title: nextTitle, tags: "", revision: imported ? -1 : 0 });
    setStatus(
      imported
        ? "SVGを取り込みました。保存するとプロジェクトへ追加されます。"
        : "新しい文書を開きました",
    );
  }, []);
  const guard = useCallback(
    (action: () => void) => {
      if (busyLock.current) return;
      if (dirty) setConfirmation({ message: "未保存の変更を破棄しますか？", action });
      else action();
    },
    [dirty],
  );
  const newDocument = useCallback(
    () => guard(() => void run(() => replaceDocument(EMPTY, DEFAULT_TITLE, false))),
    [guard, run, replaceDocument],
  );
  const importFile = useCallback(
    () =>
      guard(
        () =>
          void run(async () => {
            const path = await open({
              multiple: false,
              filters: [{ name: "SVG", extensions: ["svg"] }],
            });
            if (!path) return;
            const payload = await vectorReadFile(path);
            const nextTitle =
              path
                .split(/[\\/]/)
                .pop()
                ?.replace(/\.svg$/i, "") || DEFAULT_TITLE;
            await replaceDocument(payload.svg, nextTitle, true);
            // draw.io の SVG などを取り込み用に変換した場合は、その内容を併せて示す
            if (payload.notices.length > 0) {
              setStatus(
                `SVGを取り込みました。保存するとプロジェクトへ追加されます。${payload.notices.join(" ")}`,
              );
            }
          }),
      ),
    [guard, run, replaceDocument],
  );
  const insertImage = () =>
    run(async () => {
      const path = await open({
        multiple: false,
        filters: [{ name: "画像", extensions: ["png", "jpg", "jpeg", "webp"] }],
      });
      if (path) {
        await request("insertImage", { data: await vectorReadImage(path) });
        setStatus("画像を挿入しました");
      }
    });
  const exportFile = useCallback(
    (format: "svg" | "png") =>
      run(async () => {
        const path = await saveDialog({
          defaultPath: `${title.replace(/[\\/:*?"<>|]/g, "_")}.${format}`,
          filters: [{ name: format.toUpperCase(), extensions: [format] }],
        });
        if (!path) return;
        const snapshot = await request(format === "png" ? "png" : "snapshot");
        const data = format === "png" ? snapshot.data : snapshot.svg;
        if (!data) throw new Error("出力データがありません。");
        if (format === "svg") validateSvg(data, policy);
        await vectorWriteFile(path, format, data);
        setStatus(`${format.toUpperCase()}を書き出しました`);
      }),
    [run, title, request],
  );
  useEffect(() => {
    actions.current = (action) => {
      if (action === "save") void save();
      else if (action === "import") importFile();
      else if (action === "new") newDocument();
      else if (action === "exportPng") void exportFile("png");
    };
  }, [save, importFile, newDocument, exportFile]);

  if (!projectId) return <p>プロジェクトを選択してください。</p>;
  return (
    <div className="flex h-full min-h-[560px] flex-col gap-2 px-[var(--page-pad)] py-3">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="mr-2 text-lg font-semibold">ベクター描画</h1>
        <select
          aria-label="作品を切り替え"
          className={fieldClass}
          value={currentId ?? ""}
          disabled={busy}
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
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const page = await listItemSummaries({
                  moduleId: "vector",
                  projectId,
                  offset: documents.length,
                });
                setDocuments((old) => [...old, ...page]);
                setHasMore(page.length === 100);
              })
            }
          >
            さらに読込
          </Button>
        )}
        <Button disabled={!ready || busy} onClick={newDocument}>
          新規
        </Button>
        <Button disabled={!ready || busy} onClick={importFile}>
          SVGを取り込む
        </Button>
        <Button disabled={!ready || busy} onClick={() => void insertImage()}>
          画像を挿入
        </Button>
        <Button disabled={!ready || busy} onClick={() => void exportFile("svg")}>
          SVG書出し
        </Button>
        <Button disabled={!ready || busy} onClick={() => void exportFile("png")}>
          PNG書出し
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
        <Button
          variant="primary"
          disabled={!ready || busy || !title.trim()}
          onClick={() => void save()}
        >
          保存
        </Button>
        <span className="text-xs text-[var(--fg-muted)]">
          {busy ? "処理中…" : dirty ? "未保存" : "保存済み"}
        </span>
        {currentId && (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() =>
              setConfirmation({
                message: "この作品を削除しますか？",
                action: () =>
                  void run(async () => {
                    await deleteItem({ moduleId: "vector", itemId: currentId });
                    await replaceDocument(EMPTY, DEFAULT_TITLE, false);
                    await refresh();
                  }),
              })
            }
          >
            削除
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-[var(--destructive)]">
          {error}
          {!ready && (
            <Button
              onClick={() => {
                setError(null);
                setUrl("");
                setAttempt((value) => value + 1);
              }}
            >
              再試行
            </Button>
          )}
        </p>
      )}
      <p role="status" className="min-h-4 text-xs text-[var(--fg-muted)]">
        {status ||
          (!ready
            ? "エディタを読み込んでいます…"
            : "SVG-Edit 7.4.2 · 完全オフライン · SVG/PNG 20MiB以下")}
      </p>
      {url && (
        <iframe
          ref={iframe}
          title="SVG-Edit オフラインエディタ"
          src={url}
          sandbox="allow-scripts allow-same-origin"
          className="min-h-0 flex-1 rounded-[var(--radius)] border border-[var(--border)] bg-white"
        />
      )}
      <Modal
        open={blocker.state === "blocked" || confirmation !== null}
        title="変更の確認"
        onClose={() => {
          setConfirmation(null);
          if (blocker.state === "blocked") blocker.reset();
        }}
      >
        <p className="text-sm">
          {busy
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
            disabled={busy}
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
