/**
 * キャンバス下中央に浮かせるツールバーと倍率の表示 (§5.1)。
 * 並びは 選択、フレーム、矩形、楕円、多角形、星、線、ペン、鉛筆、テキスト、画像、手のひら、ブーリアン、倍率で、
 * まとまり (`ToolGroup`) の間に区切りの線を置く。ブーリアンと倍率はメニューを開くボタン (`menu/MenuButton.tsx`)。
 *
 * ボタンはマウスで押してもフォーカスを取らない (キャンバスのショートカットと Space の手のひらを妨げないため)。
 * Tab で移ってきたときはキーボードで押せる。
 */
import { ChevronDown } from "lucide-react";
import { Fragment, useState } from "react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { getCanvasViewSize, runViewCommand, type ViewCommand } from "../canvas/viewCommands";
import { importFromPicker } from "../assets/importFile";
import { ImportNotice } from "../assets/ImportNotice";
import { useImportFileReader } from "../assets/reader";
import { useImportStatus } from "../assets/status";
import { MenuButton } from "../menu/MenuButton";
import type { MenuEntry } from "../menu/MenuList";
import { keepFocus } from "../menu/menuNavigation";
import type { BooleanOp } from "../model/types";
import {
  BOOLEAN_CONVERT_ACTIONS,
  BOOLEAN_OP_ICONS,
  BOOLEAN_OPS,
} from "../panels/sections/convertActions";
import { canvasTextMeasurer } from "../render/measureText";
import { editorStore, useEditorStore } from "../state/store";
import { booleanButtonBlockReason, formatZoom, TOOLBAR_TOOLS, ZOOM_ITEMS } from "./toolbarItems";

function ZoomMenu() {
  const zoom = useEditorStore((state) => state.viewport.zoom);
  const hasSelection = useEditorStore((state) => state.selection.length > 0);
  const run = (command: ViewCommand) =>
    runViewCommand(command, {
      store: editorStore,
      size: getCanvasViewSize(),
      measurer: canvasTextMeasurer,
    });
  return (
    <MenuButton
      label="倍率"
      className="w-[72px] justify-between px-2 tabular-nums"
      entries={() =>
        ZOOM_ITEMS.map(
          (item): MenuEntry => ({
            type: "item",
            id: item.command,
            label: item.label,
            shortcut: item.shortcut,
            disabled: item.command === "zoomToSelection" && !hasSelection,
            run: () => run(item.command),
          }),
        )
      }
    >
      {formatZoom(zoom)}
      <ChevronDown size={14} aria-hidden="true" />
    </MenuButton>
  );
}

/**
 * ブーリアンのボタン (§5.1)。最後にこのメニューで選んだ演算のアイコンと ▾ を出し、押すと 4 つの演算の
 * メニューを開く。選ぶと「変換」の節・ショートカットと同じ関数 (`booleanSelection`) で作る。
 * 作れない選択と点の編集中は使えない表示にして、理由をツールチップに出す。
 * 最後に選んだ演算は、ツールバーを出している間 (エディタを開いている間) だけ覚える。既定は合体。
 */
function BooleanMenu() {
  const [lastOp, setLastOp] = useState<BooleanOp>("union");
  const reason = useEditorStore(booleanButtonBlockReason);
  const Icon = BOOLEAN_OP_ICONS[lastOp];
  return (
    <MenuButton
      label="ブーリアン演算"
      title={reason === null ? "ブーリアン演算" : `ブーリアン演算 — ${reason}`}
      disabled={reason !== null}
      align="left"
      className="gap-0.5 px-1"
      entries={() =>
        BOOLEAN_OPS.map((op): MenuEntry => {
          const action = BOOLEAN_CONVERT_ACTIONS[op];
          return {
            type: "item",
            id: op,
            label: action.label,
            icon: action.icon,
            shortcut: action.shortcut,
            run: () => {
              setLastOp(op);
              action.run(editorStore);
            },
          };
        })
      }
    >
      <Icon size={16} aria-hidden="true" data-op={lastOp} />
      <ChevronDown size={12} aria-hidden="true" />
    </MenuButton>
  );
}

/**
 * 「画像」のボタン: このツールに切り替えず、すぐファイル選択を開いて表示範囲の中央に置く (§4.8)。
 * 取り消したら何もしない (選択ツールのまま)。
 */
function startImageImport() {
  const state = editorStore.getState();
  if (state.toolId !== "select") state.setTool("select");
  void importFromPicker(editorStore);
}

/** まとまりの間の区切りの線。 */
function Separator() {
  return <div className="mx-1 h-5 w-px bg-[var(--border)]" aria-hidden="true" />;
}

export function Toolbar() {
  const toolId = useEditorStore((state) => state.toolId);
  const reader = useImportFileReader();
  const { busy } = useImportStatus();
  return (
    <>
      <ImportNotice />
      <div
        role="toolbar"
        aria-label="ツール"
        className="absolute bottom-3 left-1/2 z-10 flex w-max max-w-[calc(100%-24px)] -translate-x-1/2 flex-wrap items-center justify-center gap-0.5 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg)] p-1 shadow-[0_8px_24px_rgba(0,0,0,0.10)]"
      >
        {TOOLBAR_TOOLS.map((tool, index) => {
          const Icon = tool.icon;
          const active = tool.id === toolId;
          const title = tool.shortcut ? `${tool.label} (${tool.shortcut})` : tool.label;
          const newGroup = index > 0 && TOOLBAR_TOOLS[index - 1]?.group !== tool.group;
          return (
            <Fragment key={tool.id}>
              {newGroup && <Separator />}
              <Button
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
                disabled={tool.id === "image" && (!reader || busy)}
                onMouseDown={keepFocus}
                onClick={() =>
                  tool.id === "image" ? startImageImport() : editorStore.getState().setTool(tool.id)
                }
              >
                <Icon size={16} aria-hidden="true" />
              </Button>
            </Fragment>
          );
        })}
        <Separator />
        <BooleanMenu />
        <Separator />
        <ZoomMenu />
      </div>
    </>
  );
}
