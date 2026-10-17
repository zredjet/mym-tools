import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  File,
  Folder,
  FolderOpen,
  FolderSearch,
  Loader2,
  MoreHorizontal,
  RotateCw,
} from "lucide-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import { Button } from "@/components/ui/Button";
import { CopyButton, ToolError, ToolPage, ToolPanel } from "@/components/ui/ToolPage";
import {
  DIRSIZE_MAX_DIRS,
  type DirSizeNode,
  type DirSizeScanResult,
  cancelDirSizeOperation,
  dirSizeScan,
  revealDirSizePath,
} from "@/ipc/dirsize";
import { cn } from "@/lib/cn";
import { formatInvokeError } from "@/lib/error";
import { formatBytes } from "@/lib/formatBytes";

import { knownFolderHint, unreadableGuidance, type FolderHint } from "./knownFolders";
import {
  type SortKey,
  type TreeRow,
  buildVisibleRows,
  nodeKey,
  nodePath,
  otherSizeOf,
  resolveVisibleSelection,
  shareOf,
  sizeOf,
  sortedChildren,
} from "./tree";

const ROW_HEIGHT = 32;
const TREE_HEIGHT = 464;
const OVERSCAN = 6;
const EMPTY_NODES: DirSizeNode[] = [];

interface ActiveOperation {
  id: string;
  cancelling: boolean;
  files: number;
  dirs: number;
  logicalBytes: number;
  currentDir: string | null;
}

export function DirSizePage() {
  const [rootPath, setRootPath] = useState<string | null>(null);
  const [result, setResult] = useState<DirSizeScanResult | null>(null);
  const [operation, setOperation] = useState<ActiveOperation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("allocated");
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set([0]));
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const operationRef = useRef<ActiveOperation | null>(null);
  const mountedRef = useRef(true);
  const treeRef = useRef<HTMLDivElement>(null);
  const treeId = useId();

  const replaceOperation = useCallback((next: ActiveOperation | null) => {
    operationRef.current = next;
    setOperation(next);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const active = operationRef.current;
      if (active != null) void cancelDirSizeOperation(active.id).catch(() => undefined);
    };
  }, []);

  const scan = useCallback(
    async (path: string) => {
      if (!mountedRef.current || operationRef.current != null) return;
      const operationId = crypto.randomUUID();
      setRootPath(path);
      setResult(null);
      setError(null);
      setNotice(null);
      setExpanded(new Set([0]));
      setSelectedKey(null);
      setScrollTop(0);
      replaceOperation({
        id: operationId,
        cancelling: false,
        files: 0,
        dirs: 0,
        logicalBytes: 0,
        currentDir: null,
      });
      try {
        const scanned = await dirSizeScan({
          operationId,
          rootPath: path,
          onProgress: (progress) => {
            const current = operationRef.current;
            if (!mountedRef.current || current?.id !== operationId) return;
            if (progress.type === "scanning") {
              replaceOperation({
                ...current,
                files: progress.files,
                dirs: progress.dirs,
                logicalBytes: progress.logical_bytes,
                currentDir: progress.current_dir,
              });
            }
          },
        });
        if (mountedRef.current && isCurrentOperation(operationRef.current, operationId)) {
          setResult(scanned);
          setSelectedKey(nodeKey(0));
        }
      } catch (cause) {
        if (!mountedRef.current || !isCurrentOperation(operationRef.current, operationId)) return;
        if (isCancelledError(cause)) setNotice("走査をキャンセルしました。");
        else setError(formatDirSizeError(cause));
      } finally {
        if (mountedRef.current && isCurrentOperation(operationRef.current, operationId))
          replaceOperation(null);
      }
    },
    [replaceOperation],
  );

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "over" || event.payload.type === "enter") {
          setDragOver(true);
        } else if (event.payload.type === "drop") {
          setDragOver(false);
          const [first] = event.payload.paths;
          if (first != null) void scan(first);
        } else {
          setDragOver(false);
        }
      })
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch((cause: unknown) => {
        if (!disposed) setError(formatDirSizeError(cause));
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [scan]);

  const chooseFolder = useCallback(async () => {
    try {
      const selected = await openDialog({ multiple: false, directory: true });
      if (typeof selected === "string" && mountedRef.current) await scan(selected);
    } catch (cause) {
      if (mountedRef.current) setError(formatDirSizeError(cause));
    }
  }, [scan]);

  const cancelActive = useCallback(async () => {
    const active = operationRef.current;
    if (active == null) return;
    replaceOperation({ ...active, cancelling: true });
    try {
      await cancelDirSizeOperation(active.id);
    } catch (cause) {
      const current = operationRef.current;
      if (mountedRef.current && current?.id === active.id) {
        replaceOperation({ ...current, cancelling: false });
        setError(formatDirSizeError(cause));
      }
    }
  }, [replaceOperation]);

  const reveal = useCallback(async (path: string) => {
    try {
      await revealDirSizePath(path);
    } catch (cause) {
      if (mountedRef.current) setError(formatDirSizeError(cause));
    }
  }, []);

  const toggleExpanded = useCallback((id: number) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const nodes = result?.nodes ?? EMPTY_NODES;
  const children = useMemo(() => sortedChildren(nodes, sortKey), [nodes, sortKey]);
  const rows = useMemo(
    () => buildVisibleRows(nodes, children, expanded, sortKey),
    [children, expanded, nodes, sortKey],
  );
  const rowIndexes = useMemo(() => new Map(rows.map((row, index) => [row.key, index])), [rows]);
  const visibleSelectedKey = resolveVisibleSelection(selectedKey, rowIndexes, nodes);
  if (visibleSelectedKey !== selectedKey) setSelectedKey(visibleSelectedKey);
  const selectedIndex = visibleSelectedKey == null ? undefined : rowIndexes.get(visibleSelectedKey);
  const selectedRow = selectedIndex == null ? null : (rows[selectedIndex] ?? null);

  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endIndex = Math.min(
    rows.length,
    Math.ceil((scrollTop + TREE_HEIGHT) / ROW_HEIGHT) + OVERSCAN,
  );
  const virtualIndexes = Array.from(
    { length: Math.max(0, endIndex - startIndex) },
    (_, offset) => startIndex + offset,
  );
  if (selectedIndex != null && (selectedIndex < startIndex || selectedIndex >= endIndex)) {
    virtualIndexes.push(selectedIndex);
    virtualIndexes.sort((a, b) => a - b);
  }

  // 選択した行が見えるようにスクロールし、行数が減った時はスクロール位置を行の範囲へ戻す
  useLayoutEffect(() => {
    const tree = treeRef.current;
    if (tree == null) return;
    const height = tree.clientHeight || TREE_HEIGHT;
    let top = Math.min(tree.scrollTop, Math.max(0, rows.length * ROW_HEIGHT - height));
    if (selectedIndex != null) {
      const rowTop = selectedIndex * ROW_HEIGHT;
      if (rowTop < top) top = rowTop;
      else if (rowTop + ROW_HEIGHT > top + height) top = rowTop + ROW_HEIGHT - height;
    }
    tree.scrollTop = top;
    setScrollTop(top);
  }, [rows.length, selectedIndex]);

  const onTreeKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (rows.length === 0) return;
      const currentIndex = selectedIndex ?? 0;
      const row = rows[currentIndex]!;
      let nextIndex: number | null = null;
      let nextKey: string | null = null;
      if (event.key === "ArrowDown") nextIndex = Math.min(rows.length - 1, currentIndex + 1);
      else if (event.key === "ArrowUp") nextIndex = Math.max(0, currentIndex - 1);
      else if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = rows.length - 1;
      else if (event.key === "ArrowRight") {
        if (row.type === "node" && row.expandable) {
          if (!expanded.has(row.node.id)) toggleExpanded(row.node.id);
          else if (currentIndex + 1 < rows.length) nextIndex = currentIndex + 1;
        }
      } else if (event.key === "ArrowLeft") {
        if (row.type === "node" && row.expandable && expanded.has(row.node.id)) {
          toggleExpanded(row.node.id);
        } else {
          const parentId = row.type === "other" ? row.parent.id : row.node.parent_id;
          if (parentId != null) nextKey = nodeKey(parentId);
        }
      } else if (event.key === "Enter") {
        if (row.type === "node" && row.expandable) toggleExpanded(row.node.id);
      } else return;
      event.preventDefault();
      if (nextIndex != null) nextKey = rows[nextIndex]!.key;
      if (nextKey != null) setSelectedKey(nextKey);
    },
    [expanded, rows, selectedIndex, toggleExpanded],
  );

  const busy = operation != null;
  const isWindows = result?.separator === "\\";
  const revealLabel = isWindows ? "エクスプローラーで表示" : "Finder で表示";

  return (
    <ToolPage
      title="フォルダ容量"
      description="フォルダの中で容量を使っている場所を、大きい順にたどって調べます。読み取りだけで、ファイルは変更しません。"
    >
      <div className="flex min-h-0 flex-col gap-3 pb-6">
        <ToolPanel
          title="フォルダ"
          actions={
            <Button
              size="sm"
              variant="ghost"
              onClick={() => rootPath != null && void scan(rootPath)}
              disabled={busy || rootPath == null}
            >
              <RotateCw size={14} aria-hidden /> 再スキャン
            </Button>
          }
        >
          <div
            className={cn(
              "flex min-h-20 flex-col items-center justify-center gap-2 rounded-[var(--radius)] border border-dashed px-4 py-3 text-center transition-colors",
              dragOver
                ? "border-[var(--accent)] bg-[var(--bg-accent-soft)] text-[var(--accent)]"
                : "border-[var(--border)] bg-[var(--bg-muted)] text-[var(--fg-muted)]",
            )}
            aria-label="フォルダのドロップ領域"
          >
            {rootPath == null ? (
              <p className="text-[13px] font-medium">フォルダをここへドロップ</p>
            ) : (
              <p
                className="max-w-full truncate text-[13px] font-medium text-[var(--fg)]"
                title={rootPath}
              >
                {rootPath}
              </p>
            )}
            <Button size="sm" onClick={() => void chooseFolder()} disabled={busy}>
              <FolderOpen size={14} aria-hidden /> フォルダを選択
            </Button>
          </div>
          <p className="mt-2 text-[11px] text-[var(--fg-subtle)]">
            ローカルのフォルダだけを走査します。シンボリックリンク・ジャンクションと、別のボリュームには入りません。
          </p>
          {operation != null && (
            <ScanProgress operation={operation} onCancel={() => void cancelActive()} />
          )}
          {notice != null && (
            <p role="status" className="mt-3 text-[12px] text-[var(--fg-muted)]">
              {notice}
            </p>
          )}
          {error != null && (
            <div className="mt-3">
              <ToolError message={error} />
            </div>
          )}
        </ToolPanel>

        {result != null && result.nodes[0] != null && (
          <>
            <ScanSummary result={result} root={result.nodes[0]} isWindows={isWindows} />

            <div className="grid min-h-0 gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(260px,1fr)]">
              <ToolPanel
                title="ツリー"
                className="min-w-0"
                actions={
                  <div className="flex gap-1.5" role="group" aria-label="並べ替えの基準">
                    <SegmentButton
                      selected={sortKey === "logical"}
                      onClick={() => setSortKey("logical")}
                    >
                      サイズ
                    </SegmentButton>
                    <SegmentButton
                      selected={sortKey === "allocated"}
                      onClick={() => setSortKey("allocated")}
                    >
                      ディスク上
                    </SegmentButton>
                  </div>
                }
              >
                <TreeHeader sortKey={sortKey} />
                <div
                  ref={treeRef}
                  role="tree"
                  aria-label="フォルダ容量のツリー"
                  aria-activedescendant={
                    visibleSelectedKey == null ? undefined : `${treeId}-${visibleSelectedKey}`
                  }
                  tabIndex={0}
                  onFocus={(event) => {
                    if (event.target === event.currentTarget && visibleSelectedKey == null)
                      setSelectedKey(rows[0]?.key ?? null);
                  }}
                  onKeyDown={onTreeKeyDown}
                  onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
                  className="relative overflow-auto rounded-b-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none"
                  style={{ height: TREE_HEIGHT }}
                >
                  <div style={{ height: rows.length * ROW_HEIGHT, position: "relative" }}>
                    {virtualIndexes.map((index) => {
                      const row = rows[index]!;
                      return (
                        <TreeRowView
                          key={row.key}
                          row={row}
                          id={`${treeId}-${row.key}`}
                          top={index * ROW_HEIGHT}
                          sortKey={sortKey}
                          rootPath={result.root_path}
                          selected={visibleSelectedKey === row.key}
                          expanded={row.type === "node" && expanded.has(row.node.id)}
                          onSelect={() => {
                            setSelectedKey(row.key);
                            treeRef.current?.focus({ preventScroll: true });
                          }}
                          onToggle={() => {
                            if (row.type === "node" && row.expandable) toggleExpanded(row.node.id);
                          }}
                        />
                      );
                    })}
                  </div>
                </div>
              </ToolPanel>

              <ToolPanel title="詳細" className="min-w-0">
                {selectedRow == null ? (
                  <p className="text-[12px] text-[var(--fg-muted)]">行を選択してください。</p>
                ) : selectedRow.type === "node" ? (
                  <NodeDetails
                    result={result}
                    node={selectedRow.node}
                    parentSize={selectedRow.parentSize}
                    sortKey={sortKey}
                    isWindows={isWindows}
                    revealLabel={revealLabel}
                    busy={busy}
                    onReveal={(path) => void reveal(path)}
                    onScan={(path) => void scan(path)}
                  />
                ) : (
                  <OtherDetails
                    result={result}
                    parent={selectedRow.parent}
                    revealLabel={revealLabel}
                    busy={busy}
                    onReveal={(path) => void reveal(path)}
                    onScan={(path) => void scan(path)}
                  />
                )}
              </ToolPanel>
            </div>
          </>
        )}
      </div>
    </ToolPage>
  );
}

function ScanProgress({
  operation,
  onCancel,
}: {
  operation: ActiveOperation;
  onCancel: () => void;
}) {
  return (
    <div className="mt-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-muted)] p-3">
      <div className="flex items-center justify-between gap-3">
        <p
          className="flex min-w-0 items-center gap-2 text-[12px] text-[var(--fg)]"
          aria-live="polite"
        >
          <Loader2 className="shrink-0 animate-spin" size={14} aria-hidden />
          <span className="truncate">
            {operation.files.toLocaleString()} ファイル · {operation.dirs.toLocaleString()} フォルダ
            · {formatBytes(operation.logicalBytes)}
          </span>
        </p>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={operation.cancelling}>
          {operation.cancelling ? "キャンセル中..." : "キャンセル"}
        </Button>
      </div>
      <p
        className="mt-1 truncate font-mono text-[11px] text-[var(--fg-subtle)]"
        title={operation.currentDir ?? undefined}
      >
        {operation.currentDir ?? "フォルダを確認しています..."}
      </p>
    </div>
  );
}

function ScanSummary({
  result,
  root,
  isWindows,
}: {
  result: DirSizeScanResult;
  root: DirSizeNode;
  isWindows: boolean;
}) {
  const skipped = [
    result.skipped.links > 0 && `辿らなかったリンク ${result.skipped.links.toLocaleString()} 件`,
    result.skipped.other_volumes > 0 &&
      `別のボリューム ${result.skipped.other_volumes.toLocaleString()} 件`,
    result.skipped.hard_links > 0 &&
      `2 回目以降のハードリンク ${result.skipped.hard_links.toLocaleString()} 件`,
    result.skipped.entries > 0 && `読めなかった項目 ${result.skipped.entries.toLocaleString()} 件`,
  ].filter((text): text is string => typeof text === "string");
  const unreadableRest = result.unreadable.count - result.unreadable.paths.length;
  return (
    <ToolPanel title="概要">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-[12px] sm:grid-cols-5">
        <Stat label="サイズ" value={formatBytes(root.logical)} />
        <Stat label="ディスク上" value={formatBytes(root.allocated)} />
        <Stat label="ファイル" value={`${result.total_files.toLocaleString()} 件`} />
        <Stat label="フォルダ" value={`${result.total_dirs.toLocaleString()} 件`} />
        <Stat label="所要時間" value={formatDuration(result.duration_ms)} />
      </dl>

      {result.volume != null && (
        <div className="mt-3 rounded-[var(--radius)] border border-[var(--border)] p-3">
          <dl className="grid grid-cols-3 gap-x-6 text-[12px]">
            <Stat label="ドライブの使用量" value={formatBytes(result.volume.used_bytes)} />
            <Stat label="集計できた量" value={formatBytes(root.allocated)} />
            <Stat
              label="見えなかった容量"
              value={formatBytes(Math.max(0, result.volume.used_bytes - root.allocated))}
            />
          </dl>
          <p className="mt-2 text-[11px] text-[var(--fg-subtle)]">
            ドライブの使用量と、この走査で集計できた「ディスク上」の差です。読めないフォルダ、ファイルシステムの管理領域、復元ポイントなどが含まれます。
          </p>
        </div>
      )}

      {result.limit_reached && (
        <p
          role="alert"
          className="mt-3 rounded-[var(--radius)] border border-amber-500/50 bg-amber-500/10 p-2 text-[12px] text-[var(--fg)]"
        >
          フォルダ数が上限 ({DIRSIZE_MAX_DIRS.toLocaleString()}
          件) に達したため、途中までの集計です。もっと下のフォルダを指定して走査してください。
        </p>
      )}

      {result.unreadable.count > 0 && (
        <details className="mt-3 rounded-[var(--radius)] border border-amber-500/50 bg-amber-500/10 p-2 text-[12px] text-[var(--fg)]">
          <summary className="cursor-pointer font-medium">
            <AlertTriangle size={13} className="mr-1 inline text-amber-600" aria-hidden />
            読めないフォルダ {result.unreadable.count.toLocaleString()} 件
          </summary>
          <p className="mt-1 text-[var(--fg-muted)]">{unreadableGuidance(isWindows)}</p>
          <ul className="mt-1 max-h-40 space-y-0.5 overflow-auto font-mono text-[11px]">
            {result.unreadable.paths.map((path) => (
              <li key={path} className="break-all">
                {path}
              </li>
            ))}
            {unreadableRest > 0 && (
              <li className="font-sans">ほか {unreadableRest.toLocaleString()} 件</li>
            )}
          </ul>
        </details>
      )}

      {skipped.length > 0 && (
        <p className="mt-2 text-[11px] text-[var(--fg-muted)]">
          数えていないもの: {skipped.join(" · ")}
        </p>
      )}
      <p className="mt-2 text-[11px] text-[var(--fg-subtle)]">
        「サイズ」はファイルの内容の大きさ、「ディスク上」は実際に使っている領域です。圧縮されたファイルや、iCloud・OneDrive
        で未ダウンロードのファイルは「ディスク上」が小さく、小さなファイルが多いと大きくなります。
      </p>
    </ToolPanel>
  );
}

function TreeHeader({ sortKey }: { sortKey: SortKey }) {
  const active = "font-semibold text-[var(--fg)]";
  return (
    <div
      aria-hidden
      className="flex h-7 items-center gap-2 rounded-t-[var(--radius)] border border-b-0 border-[var(--border)] bg-[var(--bg-muted)] px-2 text-[11px] text-[var(--fg-muted)]"
    >
      <span className="min-w-0 flex-1">名前</span>
      <span className="hidden w-24 shrink-0 sm:block">割合</span>
      <span className={cn("w-20 shrink-0 text-right", sortKey === "logical" && active)}>
        サイズ
      </span>
      <span className={cn("w-20 shrink-0 text-right", sortKey === "allocated" && active)}>
        ディスク上
      </span>
      <span className="hidden w-16 shrink-0 text-right md:block">ファイル数</span>
    </div>
  );
}

function TreeRowView({
  row,
  id,
  top,
  sortKey,
  rootPath,
  selected,
  expanded,
  onSelect,
  onToggle,
}: {
  row: TreeRow;
  id: string;
  top: number;
  sortKey: SortKey;
  rootPath: string;
  selected: boolean;
  expanded: boolean;
  onSelect: () => void;
  onToggle: () => void;
}) {
  const isNode = row.type === "node";
  const node = isNode ? row.node : null;
  const unreadable = node?.unreadable === true;
  const logical = isNode ? row.node.logical : row.parent.other_logical;
  const allocated = isNode ? row.node.allocated : row.parent.other_allocated;
  const size = isNode ? sizeOf(row.node, sortKey) : otherSizeOf(row.parent, sortKey);
  const share = unreadable ? 0 : shareOf(size, row.parentSize);
  const label = isNode
    ? row.node.parent_id == null
      ? rootPath
      : row.node.name
    : `ほか ${row.parent.other_count.toLocaleString()} 項目`;
  let icon: ReactNode;
  if (unreadable) icon = <AlertTriangle size={13} className="shrink-0 text-amber-600" />;
  else if (!isNode)
    icon = <MoreHorizontal size={13} className="shrink-0 text-[var(--fg-subtle)]" />;
  else if (row.node.kind === "dir")
    icon = <Folder size={13} className="shrink-0 text-[var(--fg-muted)]" />;
  else icon = <File size={13} className="shrink-0 text-[var(--fg-subtle)]" />;
  return (
    <button
      type="button"
      role="treeitem"
      id={id}
      tabIndex={-1}
      aria-level={row.depth + 1}
      aria-posinset={row.positionInSet}
      aria-setsize={row.setSize}
      aria-selected={selected}
      aria-expanded={isNode && row.expandable ? expanded : undefined}
      onClick={onSelect}
      onDoubleClick={onToggle}
      className={cn(
        "absolute left-0 flex w-full items-center gap-2 overflow-hidden border-b border-[var(--border)] px-2 text-left text-[12px]",
        selected
          ? "bg-[var(--bg-accent-soft)] text-[var(--fg)]"
          : "bg-[var(--bg)] text-[var(--fg)] hover:bg-[var(--bg-muted)]",
        !isNode && "text-[var(--fg-muted)]",
      )}
      style={{ top, height: ROW_HEIGHT }}
    >
      <span
        className="flex min-w-0 flex-1 items-center gap-1"
        style={{ paddingLeft: row.depth * 16 }}
      >
        <span
          className="inline-flex size-4 shrink-0 items-center justify-center"
          onClick={(event) => {
            if (!isNode || !row.expandable) return;
            event.stopPropagation();
            onSelect();
            onToggle();
          }}
        >
          {isNode && row.expandable ? (
            expanded ? (
              <ChevronDown size={13} />
            ) : (
              <ChevronRight size={13} />
            )
          ) : null}
        </span>
        {icon}
        <span className="truncate">{label}</span>
        {unreadable && <span className="shrink-0 text-[11px] text-amber-700">読めない</span>}
      </span>
      <span className="hidden w-24 shrink-0 items-center gap-1.5 sm:flex">
        <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--border)]">
          <span
            className="block h-full rounded-full bg-[var(--accent)]"
            style={{ width: `${share}%` }}
          />
        </span>
        <span className="w-9 text-right text-[11px] text-[var(--fg-muted)] tabular-nums">
          {unreadable ? "" : formatShare(share)}
        </span>
      </span>
      <SizeCell value={unreadable ? null : logical} active={sortKey === "logical"} />
      <SizeCell value={unreadable ? null : allocated} active={sortKey === "allocated"} />
      <span className="hidden w-16 shrink-0 text-right text-[var(--fg-muted)] tabular-nums md:block">
        {node?.kind === "dir" && !unreadable ? node.file_count.toLocaleString() : ""}
      </span>
    </button>
  );
}

function SizeCell({ value, active }: { value: number | null; active: boolean }) {
  return (
    <span
      className={cn(
        "w-20 shrink-0 text-right tabular-nums",
        active ? "text-[var(--fg)]" : "text-[var(--fg-muted)]",
      )}
    >
      {value == null ? "—" : formatBytes(value)}
    </span>
  );
}

function NodeDetails({
  result,
  node,
  parentSize,
  sortKey,
  isWindows,
  revealLabel,
  busy,
  onReveal,
  onScan,
}: {
  result: DirSizeScanResult;
  node: DirSizeNode;
  parentSize: number;
  sortKey: SortKey;
  isWindows: boolean;
  revealLabel: string;
  busy: boolean;
  onReveal: (path: string) => void;
  onScan: (path: string) => void;
}) {
  const { path, exact } = nodePath(result, node.id);
  const isRoot = node.parent_id == null;
  const parentName = isRoot ? null : (result.nodes[node.parent_id!]?.name ?? null);
  const hint =
    node.kind === "dir" && !isRoot ? knownFolderHint(node.name, parentName, isWindows) : null;
  return (
    <div className="space-y-3 text-[12px] text-[var(--fg)]">
      <div>
        <p className="font-semibold break-all">{isRoot ? result.root_path : node.name}</p>
        <p className="mt-0.5 font-mono text-[11px] break-all text-[var(--fg-muted)]">{path}</p>
        {!exact && (
          <p className="mt-1 text-[11px] text-amber-700">
            名前に表せない文字が含まれるため、このパスは正確ではありません。
          </p>
        )}
      </div>
      {hint != null && <HintBox hint={hint} />}
      {node.unreadable && (
        <p className="rounded-[var(--radius)] border border-amber-500/50 bg-amber-500/10 p-2">
          {unreadableGuidance(isWindows)}
        </p>
      )}
      {!node.unreadable && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <DetailRow label="サイズ" value={formatExactBytes(node.logical)} />
          <DetailRow label="ディスク上" value={formatExactBytes(node.allocated)} />
          {node.kind === "dir" && (
            <>
              <DetailRow label="ファイル" value={`${node.file_count.toLocaleString()} 件`} />
              <DetailRow label="フォルダ" value={`${node.dir_count.toLocaleString()} 件`} />
            </>
          )}
          {!isRoot && (
            <DetailRow
              label="親に占める割合"
              value={`${formatShare(shareOf(sizeOf(node, sortKey), parentSize))} (${
                sortKey === "logical" ? "サイズ" : "ディスク上"
              })`}
            />
          )}
          {node.other_count > 0 && (
            <DetailRow
              label="まとめた項目"
              value={`${node.other_count.toLocaleString()} 件 · ${formatBytes(otherSizeOf(node, sortKey))}`}
            />
          )}
        </dl>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => onReveal(path)} disabled={!exact}>
          <FolderSearch size={13} aria-hidden /> {revealLabel}
        </Button>
        <CopyButton text={path} label="パスをコピー" />
        {node.kind === "dir" && !isRoot && !node.unreadable && (
          <Button size="sm" variant="ghost" onClick={() => onScan(path)} disabled={busy || !exact}>
            <RotateCw size={13} aria-hidden /> このフォルダを走査
          </Button>
        )}
      </div>
    </div>
  );
}

function OtherDetails({
  result,
  parent,
  revealLabel,
  busy,
  onReveal,
  onScan,
}: {
  result: DirSizeScanResult;
  parent: DirSizeNode;
  revealLabel: string;
  busy: boolean;
  onReveal: (path: string) => void;
  onScan: (path: string) => void;
}) {
  const { path, exact } = nodePath(result, parent.id);
  const parentLabel = parent.parent_id == null ? result.root_path : parent.name;
  return (
    <div className="space-y-3 text-[12px] text-[var(--fg)]">
      <p className="font-semibold">ほか {parent.other_count.toLocaleString()} 項目</p>
      <p className="text-[var(--fg-muted)]">
        「{parentLabel}」の中で、大きい順の上位 {result.top_limit.toLocaleString()}
        件に入らなかった項目をまとめています。中身はこのフォルダを走査すると確かめられます。
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <DetailRow label="サイズ" value={formatExactBytes(parent.other_logical)} />
        <DetailRow label="ディスク上" value={formatExactBytes(parent.other_allocated)} />
      </dl>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => onReveal(path)} disabled={!exact}>
          <FolderSearch size={13} aria-hidden /> {revealLabel}
        </Button>
        {parent.parent_id != null && (
          <Button size="sm" variant="ghost" onClick={() => onScan(path)} disabled={busy || !exact}>
            <RotateCw size={13} aria-hidden /> このフォルダを走査
          </Button>
        )}
      </div>
    </div>
  );
}

function HintBox({ hint }: { hint: FolderHint }) {
  return (
    <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-muted)] p-2">
      <p className="font-medium">{hint.title}</p>
      <p className="mt-0.5 text-[var(--fg-muted)]">{hint.description}</p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] text-[var(--fg-muted)]">{label}</dt>
      <dd className="text-[14px] font-semibold text-[var(--fg)] tabular-nums">{value}</dd>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-[var(--fg-muted)]">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </>
  );
}

function SegmentButton({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        "inline-flex h-7 items-center rounded-[var(--radius)] border px-2.5 text-[12px] transition-colors",
        selected
          ? "border-[var(--accent)] bg-[var(--bg-accent-soft)] text-[var(--accent)]"
          : "border-[var(--border)] bg-[var(--bg)] text-[var(--fg)] hover:bg-[var(--bg-muted)]",
      )}
    >
      {children}
    </button>
  );
}

function formatExactBytes(bytes: number): string {
  return bytes < 1024
    ? `${bytes.toLocaleString()} B`
    : `${formatBytes(bytes)} (${bytes.toLocaleString()} B)`;
}

function formatShare(percent: number): string {
  return percent > 0 && percent < 1 ? "<1%" : `${Math.round(percent)}%`;
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} 秒`;
}

function isCurrentOperation(operation: ActiveOperation | null, operationId: string): boolean {
  return operation?.id === operationId;
}

function isCancelledError(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { code?: unknown }).code === "cancelled"
  );
}

function formatDirSizeError(cause: unknown): string {
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    const message = (cause as { message?: unknown }).message;
    if (typeof message === "object" && message !== null && "reason" in message) {
      const reason = (message as { reason?: unknown }).reason;
      if (typeof reason === "string") return reason;
    }
  }
  return formatInvokeError(cause);
}
