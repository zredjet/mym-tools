import { useDraggable, useDroppable } from "@dnd-kit/core";
import { ChevronDown, ChevronRight, Eye, EyeOff, Lock, LockOpen } from "lucide-react";
import { memo, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";

import { cn } from "@/lib/cn";

import { DEFAULT_NODE_NAMES } from "../../model/create";
import { updateNodes } from "../../model/transform";
import { getNode } from "../../model/tree";
import type { NodeId } from "../../model/types";
import { editorStore, useEditorStore } from "../../state/store";
import { isComposing } from "../fields/keys";
import { commitLayerName, NODE_TYPE_ICONS } from "./layerActions";
import type { DropZone, LayerRow as LayerRowData } from "./layerTree";

/** 1 段の字下げ (px)。 */
const INDENT = 12;

export interface LayerRowProps {
  row: LayerRowData;
  /** この行の上に落とそうとしている位置 */
  dropZone: DropZone | null;
  /** ドラッグ中の行 (薄く出す) */
  dragging: boolean;
  onSelect(id: NodeId, modifiers: { shift: boolean; toggle: boolean }): void;
  onToggleExpanded(id: NodeId): void;
}

/**
 * レイヤーパネルの 1 行。自分のノードだけを購読し、ほかのノードの変更では描き直さない。
 * 行全体がドラッグの取っ手 (4 px 動かすまではクリック)。
 */
export const LayerRow = memo(function LayerRow({
  row,
  dropZone,
  dragging,
  onSelect,
  onToggleExpanded,
}: LayerRowProps) {
  const { id, depth } = row;
  const node = useEditorStore((s) => getNode(s.doc, id));
  const selected = useEditorStore((s) => s.selection.includes(id));
  const hovered = useEditorStore((s) => s.hoveredId === id);
  const [editing, setEditing] = useState(false);
  const element = useRef<HTMLDivElement | null>(null);

  const drag = useDraggable({ id, disabled: editing });
  const drop = useDroppable({ id });

  useEffect(() => {
    if (selected) element.current?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);

  if (!node) return null;
  const Icon = NODE_TYPE_ICONS[node.type];
  const displayName = node.name === "" ? DEFAULT_NODE_NAMES[node.type] : node.name;

  const setRef = (el: HTMLDivElement | null) => {
    element.current = el;
    drag.setNodeRef(el);
    drop.setNodeRef(el);
  };

  const toggle = (patch: { visible: boolean } | { locked: boolean }) => (event: MouseEvent) => {
    event.stopPropagation();
    editorStore.getState().apply((doc) => updateNodes(doc, [id], patch));
  };

  const stop = (event: { stopPropagation(): void }) => event.stopPropagation();

  return (
    <div
      ref={setRef}
      {...drag.attributes}
      {...drag.listeners}
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={selected}
      aria-expanded={row.hasChildren ? row.expanded : undefined}
      aria-label={displayName}
      data-layer-id={id}
      className={cn(
        "group relative flex h-[var(--row-h)] shrink-0 cursor-default items-center gap-1 pr-1 text-[13px] select-none",
        "focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none focus-visible:ring-inset",
        selected
          ? "bg-[var(--bg-accent-soft)] text-[var(--accent)]"
          : hovered
            ? "bg-[var(--bg-muted)] text-[var(--fg)]"
            : "text-[var(--fg)]",
        dragging && "opacity-50",
        dropZone === "inside" && "ring-2 ring-[var(--accent)] ring-inset",
      )}
      style={{ paddingLeft: 4 + depth * INDENT }}
      onClick={(event) =>
        onSelect(id, { shift: event.shiftKey, toggle: event.metaKey || event.ctrlKey })
      }
      onDoubleClick={() => setEditing(true)}
      onPointerEnter={() => editorStore.getState().setHovered(id)}
      onPointerLeave={() => {
        if (editorStore.getState().hoveredId === id) editorStore.getState().setHovered(null);
      }}
      onKeyDown={(event: KeyboardEvent) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(id, { shift: event.shiftKey, toggle: event.metaKey || event.ctrlKey });
        } else if (event.key === "F2") {
          event.preventDefault();
          setEditing(true);
        }
      }}
    >
      {row.hasChildren ? (
        <button
          type="button"
          tabIndex={-1}
          aria-label={row.expanded ? "閉じる" : "開く"}
          className="flex h-5 w-4 shrink-0 items-center justify-center text-[var(--fg-muted)] hover:text-[var(--fg)]"
          onPointerDown={stop}
          onDoubleClick={stop}
          onClick={(event) => {
            event.stopPropagation();
            onToggleExpanded(id);
          }}
        >
          {row.expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
      ) : (
        <span className="w-4 shrink-0" />
      )}
      <Icon
        size={14}
        aria-hidden="true"
        className={cn("shrink-0", selected ? "text-[var(--accent)]" : "text-[var(--fg-muted)]")}
      />
      {editing ? (
        <NameInput
          initial={node.name}
          onDone={(value) => {
            setEditing(false);
            if (value !== null) commitLayerName(id, value);
          }}
        />
      ) : (
        <span
          className={cn(
            "min-w-0 flex-1 truncate pl-0.5",
            !node.visible && "opacity-50",
            node.name === "" && "text-[var(--fg-muted)]",
          )}
        >
          {displayName}
        </span>
      )}
      <button
        type="button"
        tabIndex={-1}
        aria-label={node.visible ? "非表示にする" : "表示する"}
        aria-pressed={!node.visible}
        title={node.visible ? "非表示にする" : "表示する"}
        className={cn(
          "flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-[var(--fg-muted)] hover:bg-[var(--bg-muted)] hover:text-[var(--fg)]",
          node.visible && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
        )}
        onPointerDown={stop}
        onDoubleClick={stop}
        onClick={toggle({ visible: !node.visible })}
      >
        {node.visible ? <Eye size={14} /> : <EyeOff size={14} />}
      </button>
      <button
        type="button"
        tabIndex={-1}
        aria-label={node.locked ? "ロックを解除する" : "ロックする"}
        aria-pressed={node.locked}
        title={node.locked ? "ロックを解除する" : "ロックする"}
        className={cn(
          "flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-[var(--fg-muted)] hover:bg-[var(--bg-muted)] hover:text-[var(--fg)]",
          !node.locked && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
        )}
        onPointerDown={stop}
        onDoubleClick={stop}
        onClick={toggle({ locked: !node.locked })}
      >
        {node.locked ? <Lock size={14} /> : <LockOpen size={14} />}
      </button>
      {(dropZone === "before" || dropZone === "after") && (
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute right-1 h-0.5 rounded-full bg-[var(--accent)]",
            dropZone === "before" ? "-top-px" : "-bottom-px",
          )}
          style={{ left: 4 + depth * INDENT + 16 }}
        />
      )}
    </div>
  );
});

/**
 * 名前の編集欄。Enter で確定、Esc で取消、フォーカスが外れたら確定。
 * 日本語入力の変換中の Enter と Esc は変換の操作として扱う。
 */
function NameInput({ initial, onDone }: { initial: string; onDone(value: string | null): void }) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (result: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(result);
  };
  return (
    <input
      type="text"
      aria-label="レイヤーの名前"
      // 編集を始めたらすぐに入力できるようにする
      autoFocus
      className="h-6 min-w-0 flex-1 rounded-[var(--radius-sm)] border border-[var(--accent)] bg-[var(--bg)] px-1 text-[13px] text-[var(--fg)] outline-none"
      value={value}
      spellCheck={false}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setValue(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (isComposing(event)) return;
        if (event.key === "Enter") {
          event.preventDefault();
          finish(value);
        } else if (event.key === "Escape") {
          event.preventDefault();
          finish(null);
        }
      }}
      onBlur={() => finish(value)}
    />
  );
}
