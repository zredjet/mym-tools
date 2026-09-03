import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ChevronDown, ChevronRight, FileSearch2, Loader2, RotateCw, Trash2 } from "lucide-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import { Button } from "@/components/ui/Button";
import { ToolError, ToolPage, ToolPanel, inputClass } from "@/components/ui/ToolPage";
import { type NrbfNode, type NrbfSummary, cancelNrbfOperation, nrbfInspectFile } from "@/ipc/nrbf";
import { cn } from "@/lib/cn";
import { buildVisibleRows, searchNodes } from "@/modules/nrbf/tree";
import { createPresentationNodes } from "@/modules/nrbf/presentation";

const ROW_HEIGHT = 32;
const TREE_HEIGHT = 464;
const OVERSCAN = 6;

interface ActiveOperation {
  id: string;
  cancelling: boolean;
}

type SearchMode = "filter" | "jump";

export function NrbfInspectorPage() {
  const [path, setPath] = useState<string | null>(null);
  const [nodes, setNodes] = useState<NrbfNode[]>([]);
  const [summary, setSummary] = useState<NrbfSummary | null>(null);
  const [operation, setOperation] = useState<ActiveOperation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [expandByteArrays, setExpandByteArrays] = useState(false);
  const [rawMode, setRawMode] = useState(false);
  const [nameQuery, setNameQuery] = useState("");
  const [valueQuery, setValueQuery] = useState("");
  const [searchMode, setSearchMode] = useState<SearchMode>("filter");
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const operationRef = useRef<ActiveOperation | null>(null);
  const mountedRef = useRef(true);
  const treeRef = useRef<HTMLDivElement>(null);
  const pendingJumpIdRef = useRef<number | null>(null);

  const replaceOperation = useCallback((next: ActiveOperation | null) => {
    operationRef.current = next;
    setOperation(next);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const active = operationRef.current;
      if (active != null) void cancelNrbfOperation(active.id).catch(() => undefined);
    };
  }, []);

  const inspectPath = useCallback(
    async (nextPath: string) => {
      if (!mountedRef.current || operationRef.current != null) return;
      const operationId = crypto.randomUUID();
      setPath(nextPath);
      setNodes([]);
      setSummary(null);
      setError(null);
      setNameQuery("");
      setValueQuery("");
      pendingJumpIdRef.current = null;
      setExpandedIds(new Set());
      setSelectedId(null);
      setScrollTop(0);
      replaceOperation({ id: operationId, cancelling: false });
      const receivedNodes: NrbfNode[] = [];
      try {
        const completed = await nrbfInspectFile({
          operationId,
          path: nextPath,
          expandByteArrays,
          onProgress: (progress) => {
            if (!mountedRef.current || !isCurrentOperation(operationRef.current, operationId))
              return;
            if (progress.type === "nodes") {
              receivedNodes.push(...progress.nodes);
            } else if (progress.type === "done") setSummary(progress.summary);
          },
        });
        if (!mountedRef.current || !isCurrentOperation(operationRef.current, operationId)) return;
        setSummary(completed);
        setNodes([...receivedNodes]);
        if (receivedNodes.length > 0) {
          setSelectedId(receivedNodes[0]!.id);
          setExpandedIds(new Set([receivedNodes[0]!.id]));
        }
      } catch (cause) {
        if (
          !isCancelledError(cause) &&
          mountedRef.current &&
          isCurrentOperation(operationRef.current, operationId)
        )
          setError(formatNrbfError(cause));
      } finally {
        if (mountedRef.current && isCurrentOperation(operationRef.current, operationId))
          replaceOperation(null);
      }
    },
    [expandByteArrays, replaceOperation],
  );

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "over" || event.payload.type === "enter") setDragOver(true);
        else if (event.payload.type === "drop") {
          setDragOver(false);
          const first = event.payload.paths[0];
          if (first != null && operationRef.current == null) void inspectPath(first);
        } else setDragOver(false);
      })
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch((cause: unknown) => {
        if (!disposed) setError(formatNrbfError(cause));
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [inspectPath]);

  const chooseFile = useCallback(async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        directory: false,
        filters: [{ name: "BinaryFormatter NRBF", extensions: ["bin", "dat", "nrbf"] }],
      });
      if (typeof selected === "string") await inspectPath(selected);
    } catch (cause) {
      if (mountedRef.current) setError(formatNrbfError(cause));
    }
  }, [inspectPath]);

  const cancel = useCallback(async () => {
    const active = operationRef.current;
    if (active == null) return;
    replaceOperation({ ...active, cancelling: true });
    try {
      await cancelNrbfOperation(active.id);
    } catch (cause) {
      if (mountedRef.current && operationRef.current?.id === active.id) {
        replaceOperation({ ...active, cancelling: false });
        setError(formatNrbfError(cause));
      }
    }
  }, [replaceOperation]);

  const clear = useCallback(() => {
    setPath(null);
    setNodes([]);
    setSummary(null);
    setError(null);
    setNameQuery("");
    setValueQuery("");
    pendingJumpIdRef.current = null;
    setExpandedIds(new Set());
    setSelectedId(null);
  }, []);

  const presentationNodes = useMemo(
    () => createPresentationNodes(nodes, rawMode),
    [nodes, rawMode],
  );
  const nodesById = useMemo(() => {
    const result = new Map<number, NrbfNode>();
    for (const node of presentationNodes) result.set(node.id, node);
    return result;
  }, [presentationNodes]);
  const search = useMemo(
    () => searchNodes(presentationNodes, { name: nameQuery, value: valueQuery }),
    [nameQuery, presentationNodes, valueQuery],
  );
  const filteredSearch = searchMode === "filter" ? search : null;
  const rows = useMemo(
    () => buildVisibleRows(presentationNodes, expandedIds, filteredSearch),
    [expandedIds, filteredSearch, presentationNodes],
  );
  const parentIds = useMemo(() => {
    const result = new Set<number>();
    for (const node of presentationNodes) if (node.parentId != null) result.add(node.parentId);
    return result;
  }, [presentationNodes]);
  const selected = selectedId == null ? null : (nodesById.get(selectedId) ?? null);
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endIndex = Math.min(
    rows.length,
    Math.ceil((scrollTop + TREE_HEIGHT) / ROW_HEIGHT) + OVERSCAN,
  );
  const virtualRows = rows.slice(startIndex, endIndex);

  const selectNode = useCallback(
    (nodeId: number) => {
      setSelectedId(nodeId);
      setExpandedIds((current) => {
        const next = new Set(current);
        const seen = new Set<number>();
        let parentId = nodesById.get(nodeId)?.parentId ?? null;
        while (parentId != null && !seen.has(parentId)) {
          seen.add(parentId);
          next.add(parentId);
          parentId = nodesById.get(parentId)?.parentId ?? null;
        }
        return next;
      });
    },
    [nodesById],
  );

  const jumpToNode = useCallback(
    (nodeId: number) => {
      pendingJumpIdRef.current = nodeId;
      if (searchMode === "filter") {
        setNameQuery("");
        setValueQuery("");
      }
      selectNode(nodeId);
    },
    [searchMode, selectNode],
  );

  const jumpToSearchMatch = useCallback(
    (direction: -1 | 1) => {
      const matches = search?.orderedMatchIds ?? [];
      if (matches.length === 0) return;
      const currentIndex = selectedId == null ? -1 : matches.indexOf(selectedId);
      const nextIndex =
        currentIndex < 0
          ? direction === 1
            ? 0
            : matches.length - 1
          : (currentIndex + direction + matches.length) % matches.length;
      const nodeId = matches[nextIndex]!;
      pendingJumpIdRef.current = nodeId;
      selectNode(nodeId);
    },
    [search, selectNode, selectedId],
  );

  const currentMatchIndex =
    search == null || selectedId == null ? -1 : search.orderedMatchIds.indexOf(selectedId);

  useEffect(() => {
    const nodeId = pendingJumpIdRef.current;
    if (nodeId == null) return;
    const index = rows.findIndex((row) => row.node.id === nodeId);
    if (index < 0 || treeRef.current == null) return;
    pendingJumpIdRef.current = null;
    if (typeof treeRef.current.scrollTo === "function")
      treeRef.current.scrollTo({ top: index * ROW_HEIGHT, behavior: "smooth" });
    else treeRef.current.scrollTop = index * ROW_HEIGHT;
  }, [rows]);

  const onTreeKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (rows.length === 0) return;
      const currentIndex = Math.max(
        0,
        rows.findIndex((row) => row.node.id === selectedId),
      );
      const current = rows[currentIndex]!.node;
      let nextId: number | null = null;
      if (event.key === "ArrowDown")
        nextId = rows[Math.min(rows.length - 1, currentIndex + 1)]!.node.id;
      else if (event.key === "ArrowUp") nextId = rows[Math.max(0, currentIndex - 1)]!.node.id;
      else if (event.key === "ArrowRight" && parentIds.has(current.id)) {
        setExpandedIds((ids) => new Set(ids).add(current.id));
      } else if (event.key === "ArrowLeft") {
        if (expandedIds.has(current.id)) {
          setExpandedIds((ids) => {
            const next = new Set(ids);
            next.delete(current.id);
            return next;
          });
        } else nextId = current.parentId;
      } else if (event.key === "Enter" && current.referenceTargetId != null) {
        jumpToNode(current.referenceTargetId);
      } else return;
      event.preventDefault();
      if (nextId != null) selectNode(nextId);
    },
    [expandedIds, jumpToNode, parentIds, rows, selectNode, selectedId],
  );

  return (
    <ToolPage
      title="BinaryFormatter解析"
      description="BinaryFormatterのNRBFデータを型ロードせず、読み取り専用で調査します。"
    >
      <div className="flex min-h-0 flex-col gap-3 pb-6">
        <ToolPanel
          title={summary?.fileName ?? "NRBFファイル"}
          actions={
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => void chooseFile()} disabled={operation != null}>
                <FileSearch2 size={14} aria-hidden /> ファイルを選択
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => path != null && void inspectPath(path)}
                disabled={operation != null || path == null}
              >
                <RotateCw size={14} aria-hidden /> 再読込
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={clear}
                disabled={operation != null || path == null}
              >
                <Trash2 size={14} aria-hidden /> クリア
              </Button>
            </div>
          }
        >
          <div className="mb-3">
            <Check
              label="byte配列を展開（最大50,000要素）"
              checked={expandByteArrays}
              onChange={setExpandByteArrays}
              disabled={operation != null}
            />
            <p className="mt-1 text-[11px] text-[var(--fg-muted)]">
              有効にすると、次回の読込・再読込でbyte配列の各要素を表示します。
            </p>
          </div>
          <button
            type="button"
            onClick={() => void chooseFile()}
            disabled={operation != null}
            className={cn(
              "flex min-h-16 w-full items-center justify-center rounded-[var(--radius)] border border-dashed px-4 text-[12px] transition-colors",
              dragOver
                ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]"
                : "border-[var(--border)] bg-[var(--bg-muted)] text-[var(--fg-muted)]",
            )}
          >
            {path ?? "単一の .bin / .dat / .nrbf ファイルを選択またはドロップ"}
          </button>
          {operation != null ? (
            <div className="mt-3 flex items-center gap-3 text-[12px] text-[var(--fg-muted)]">
              <Loader2 className="animate-spin" size={14} aria-hidden /> 解析中…
              <Button
                size="sm"
                variant="destructive"
                onClick={() => void cancel()}
                disabled={operation.cancelling}
              >
                {operation.cancelling ? "キャンセル中..." : "キャンセル"}
              </Button>
            </div>
          ) : null}
          <ToolError message={error} />
          {summary != null ? (
            <p className="mt-2 text-[11px] text-[var(--fg-muted)]">
              {formatBytes(summary.fileSizeBytes)} · {summary.nodeCount.toLocaleString()}ノード ·{" "}
              {summary.durationMs}ms
              {summary.rootType != null ? ` · ${summary.rootType}` : ""}
            </p>
          ) : null}
        </ToolPanel>

        {nodes.length > 0 ? (
          <>
            <ToolPanel title="検索と表示">
              <div className="grid gap-3 md:grid-cols-[140px_minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end">
                <label className="flex flex-col gap-1 text-[11px] text-[var(--fg-muted)]">
                  検索方法
                  <select
                    aria-label="検索方法"
                    className={cn(inputClass, "w-full")}
                    value={searchMode}
                    onChange={(event) => setSearchMode(event.target.value as SearchMode)}
                  >
                    <option value="filter">絞り込み</option>
                    <option value="jump">ジャンプ</option>
                  </select>
                </label>
                <label className="flex min-w-0 flex-col gap-1 text-[11px] text-[var(--fg-muted)]">
                  項目名
                  <input
                    aria-label="項目名を検索"
                    className={cn(inputClass, "w-full")}
                    value={nameQuery}
                    onChange={(event) => setNameQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && searchMode === "jump") {
                        event.preventDefault();
                        jumpToSearchMatch(1);
                      }
                    }}
                  />
                </label>
                <label className="flex min-w-0 flex-col gap-1 text-[11px] text-[var(--fg-muted)]">
                  値
                  <input
                    aria-label="値を検索"
                    className={cn(inputClass, "w-full")}
                    value={valueQuery}
                    onChange={(event) => setValueQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && searchMode === "jump") {
                        event.preventDefault();
                        jumpToSearchMatch(1);
                      }
                    }}
                  />
                </label>
                <div className="pb-2">
                  <Check label="Raw表示" checked={rawMode} onChange={setRawMode} />
                </div>
              </div>
              {search != null ? (
                <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-[var(--fg-muted)]">
                  <p role="status">
                    {search.totalMatches.toLocaleString()}件一致
                    {searchMode === "jump" && search.orderedMatchIds.length > 0
                      ? ` · ${currentMatchIndex < 0 ? "—" : currentMatchIndex + 1} / ${search.orderedMatchIds.length.toLocaleString()}`
                      : ""}
                    {search.truncated
                      ? "（先頭1,000件まで対象。検索条件を絞り込んでください）"
                      : ""}
                  </p>
                  {searchMode === "jump" ? (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => jumpToSearchMatch(-1)}
                        disabled={search.orderedMatchIds.length === 0}
                        aria-label="前の一致へ"
                      >
                        前へ
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => jumpToSearchMatch(1)}
                        disabled={search.orderedMatchIds.length === 0}
                        aria-label="次の一致へ"
                      >
                        次へ
                      </Button>
                    </>
                  ) : null}
                </div>
              ) : null}
            </ToolPanel>

            <div className="grid min-h-0 gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(260px,1fr)]">
              <ToolPanel title="ツリー" className="min-w-0">
                <div
                  ref={treeRef}
                  role="tree"
                  aria-label="NRBFデータツリー"
                  tabIndex={0}
                  onKeyDown={onTreeKeyDown}
                  onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
                  className="relative overflow-auto rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none"
                  style={{ height: TREE_HEIGHT }}
                >
                  <div style={{ height: rows.length * ROW_HEIGHT, position: "relative" }}>
                    {virtualRows.map((row, offset) => {
                      const index = startIndex + offset;
                      const expandable = parentIds.has(row.node.id);
                      const expanded = filteredSearch != null || expandedIds.has(row.node.id);
                      return (
                        <button
                          key={row.node.id}
                          type="button"
                          role="treeitem"
                          aria-level={row.depth + 1}
                          aria-selected={selectedId === row.node.id}
                          aria-expanded={expandable ? expanded : undefined}
                          onClick={() => selectNode(row.node.id)}
                          onDoubleClick={() => {
                            if (!expandable) return;
                            setExpandedIds((ids) => toggleSet(ids, row.node.id));
                          }}
                          className={cn(
                            "absolute left-0 flex w-full items-center gap-1 overflow-hidden border-b border-[var(--border)] px-2 text-left font-mono text-[12px]",
                            selectedId === row.node.id
                              ? "bg-[var(--accent-soft)] text-[var(--fg)]"
                              : "bg-[var(--bg)] text-[var(--fg)] hover:bg-[var(--bg-muted)]",
                          )}
                          style={{
                            top: index * ROW_HEIGHT,
                            height: ROW_HEIGHT,
                            paddingLeft: 8 + row.depth * 18,
                          }}
                        >
                          <span
                            className="inline-flex size-4 shrink-0 items-center justify-center"
                            onClick={(event) => {
                              if (!expandable || filteredSearch != null) return;
                              event.stopPropagation();
                              setExpandedIds((ids) => toggleSet(ids, row.node.id));
                            }}
                          >
                            {expandable ? (
                              expanded ? (
                                <ChevronDown size={13} />
                              ) : (
                                <ChevronRight size={13} />
                              )
                            ) : null}
                          </span>
                          <span className="shrink-0 text-[var(--fg-muted)]">
                            {kindLabel(row.node.kind)}
                          </span>
                          <span className="truncate">
                            <Highlight
                              text={rawMode ? row.node.rawName : row.node.displayName}
                              query={nameQuery}
                              active={search?.matchIds.has(row.node.id) ?? false}
                            />
                          </span>
                          {row.node.formattedValue != null ? (
                            <span className="truncate text-[var(--fg-muted)]">
                              :{" "}
                              <Highlight
                                text={row.node.formattedValue}
                                query={valueQuery}
                                active={search?.matchIds.has(row.node.id) ?? false}
                              />
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </ToolPanel>

              <ToolPanel title="詳細" className="min-w-0">
                {selected == null ? (
                  <p className="text-[12px] text-[var(--fg-muted)]">ノードを選択してください。</p>
                ) : (
                  <NodeDetails node={selected} rawMode={rawMode} onJump={jumpToNode} />
                )}
              </ToolPanel>
            </div>
            {summary != null && summary.warnings.length > 0 ? (
              <ToolPanel title={`警告 · ${summary.warnings.length}`}>
                <ul className="list-disc space-y-1 pl-5 text-[12px] text-[var(--fg-muted)]">
                  {summary.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </ToolPanel>
            ) : null}
          </>
        ) : null}
      </div>
    </ToolPage>
  );
}

function NodeDetails({
  node,
  rawMode,
  onJump,
}: {
  node: NrbfNode;
  rawMode: boolean;
  onJump: (id: number) => void;
}) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-[12px]">
      <Detail label="名前" value={rawMode ? node.rawName : node.displayName} />
      <Detail label="種別" value={node.kind} />
      <Detail label="値" value={node.formattedValue ?? "—"} />
      <Detail label="型" value={node.typeName ?? "—"} />
      {rawMode ? <Detail label="Raw名" value={node.rawName} /> : null}
      {rawMode ? <Detail label="Assembly" value={node.assemblyName ?? "—"} /> : null}
      {rawMode ? <Detail label="Record ID" value={node.recordId ?? "—"} /> : null}
      {rawMode ? <Detail label="Shape" value={node.shape?.join(" × ") ?? "—"} /> : null}
      {node.referenceTargetId != null ? (
        <>
          <dt className="text-[var(--fg-muted)]">参照先</dt>
          <dd>
            <Button size="sm" onClick={() => onJump(node.referenceTargetId!)}>
              #{node.referenceTargetId}へ移動
            </Button>
          </dd>
        </>
      ) : null}
    </dl>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-[var(--fg-muted)]">{label}</dt>
      <dd className="font-mono break-all text-[var(--fg)]">{value}</dd>
    </>
  );
}

function Check({
  label,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        "flex items-center gap-2 text-[12px] text-[var(--fg)]",
        disabled && "opacity-60",
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}

function Highlight({
  text,
  query,
  active,
}: {
  text: string;
  query: string;
  active: boolean;
}): ReactNode {
  if (!active || query.trim() === "") return text;
  const index = text.toLocaleLowerCase().indexOf(query.trim().toLocaleLowerCase());
  if (index < 0) return <mark className="bg-[var(--warning)]/30 text-inherit">{text}</mark>;
  return (
    <>
      {text.slice(0, index)}
      <mark className="bg-[var(--warning)]/30 text-inherit">
        {text.slice(index, index + query.trim().length)}
      </mark>
      {text.slice(index + query.trim().length)}
    </>
  );
}

function toggleSet(current: Set<number>, id: number): Set<number> {
  const next = new Set(current);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

function kindLabel(kind: NrbfNode["kind"]): string {
  return { object: "{}", array: "[]", scalar: "=", null: "∅", reference: "↗", unsupported: "!" }[
    kind
  ];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

function isCancelledError(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { code?: unknown }).code === "cancelled"
  );
}

function isCurrentOperation(operation: ActiveOperation | null, operationId: string): boolean {
  return operation?.id === operationId;
}

function formatNrbfError(cause: unknown): string {
  if (typeof cause === "string") return cause;
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "object" && cause !== null) {
    const value = cause as { message?: unknown };
    if (typeof value.message === "string") return value.message;
    if (typeof value.message === "object" && value.message !== null) {
      const reason = (value.message as { reason?: unknown }).reason;
      if (typeof reason === "string") return reason;
    }
  }
  return "NRBFファイルを解析できませんでした。";
}
