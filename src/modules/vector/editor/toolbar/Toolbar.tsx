/**
 * キャンバス下中央に浮かせるツールバーと倍率の表示 (§5.1)。
 * 並びは 選択、フレーム、矩形、楕円、線、テキスト、画像、手のひら、倍率。
 *
 * ボタンはマウスで押してもフォーカスを取らない (キャンバスのショートカットと Space の手のひらを妨げないため)。
 * Tab で移ってきたときはキーボードで押せる。
 */
import { ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState, type MouseEvent } from "react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { getCanvasViewSize, runViewCommand, type ViewCommand } from "../canvas/viewCommands";
import { canvasTextMeasurer } from "../render/measureText";
import { editorStore, useEditorStore } from "../state/store";
import { formatZoom, TOOLBAR_TOOLS, ZOOM_ITEMS } from "./toolbarItems";

/** マウスで押したときにフォーカスを取らない。 */
function keepFocus(event: MouseEvent) {
  event.preventDefault();
}

function ZoomMenu() {
  const zoom = useEditorStore((state) => state.viewport.zoom);
  const hasSelection = useEditorStore((state) => state.selection.length > 0);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  const run = (command: ViewCommand) => {
    runViewCommand(command, {
      store: editorStore,
      size: getCanvasViewSize(),
      measurer: canvasTextMeasurer,
    });
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative">
      <Button
        variant="ghost"
        size="sm"
        className="w-[72px] justify-between px-2 tabular-nums"
        aria-label="倍率"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onMouseDown={keepFocus}
        onClick={() => setOpen((value) => !value)}
      >
        {formatZoom(zoom)}
        <ChevronDown size={14} aria-hidden="true" />
      </Button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="倍率"
          className="absolute right-0 bottom-[calc(100%+8px)] min-w-[200px] rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg)] p-1 shadow-[0_8px_24px_rgba(0,0,0,0.10)]"
        >
          {ZOOM_ITEMS.map((item) => {
            const disabled = item.command === "zoomToSelection" && !hasSelection;
            return (
              <button
                key={item.command}
                type="button"
                role="menuitem"
                disabled={disabled}
                onMouseDown={keepFocus}
                onClick={() => run(item.command)}
                className="flex h-7 w-full items-center justify-between gap-4 rounded-[var(--radius-sm)] px-2 text-[13px] text-[var(--fg)] hover:bg-[var(--bg-muted)] disabled:cursor-not-allowed disabled:text-[var(--fg-subtle)] disabled:hover:bg-transparent"
              >
                <span>{item.label}</span>
                <span className="text-[12px] text-[var(--fg-muted)]">{item.shortcut}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function Toolbar() {
  const toolId = useEditorStore((state) => state.toolId);
  return (
    <div
      role="toolbar"
      aria-label="ツール"
      className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-0.5 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg)] p-1 shadow-[0_8px_24px_rgba(0,0,0,0.10)]"
    >
      {TOOLBAR_TOOLS.map((tool) => {
        const Icon = tool.icon;
        const active = tool.id === toolId;
        const title = tool.shortcut ? `${tool.label} (${tool.shortcut})` : tool.label;
        return (
          <Button
            key={tool.id}
            variant="ghost"
            size="sm"
            aria-label={tool.label}
            aria-pressed={active}
            title={title}
            className={cn(
              "w-7 px-0",
              active &&
                "bg-[var(--bg-accent-soft)] !text-[var(--accent)] hover:bg-[var(--bg-accent-soft)]",
            )}
            onMouseDown={keepFocus}
            onClick={() => editorStore.getState().setTool(tool.id)}
          >
            <Icon size={16} aria-hidden="true" />
          </Button>
        );
      })}
      <div className="mx-1 h-5 w-px bg-[var(--border)]" aria-hidden="true" />
      <ZoomMenu />
    </div>
  );
}
