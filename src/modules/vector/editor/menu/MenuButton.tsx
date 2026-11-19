/**
 * ツールバーのメニューのボタン (§5.1。倍率とブーリアン)。押すとボタンの上にメニュー (`MenuList`) を開く。
 *
 * - マウスで押してもフォーカスを取らない。メニューを開いてもフォーカスは動かさない
 * - Tab で移ってきたときは Enter / Space / ↓ / ↑ で開き、最初の使える項目にフォーカスを置く。
 *   Esc で閉じたらボタンへ戻る
 * - 使えないときも出したまま `aria-disabled` にし、理由を `title` に出す (Tab で移れる)
 */
import { useId, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

import { MenuList, type MenuEntry } from "./MenuList";
import { keepFocus } from "./menuNavigation";

export interface MenuButtonProps {
  /** ボタンとメニューの読み上げの名前 */
  label: string;
  title?: string;
  disabled?: boolean;
  /** メニューの項目。開いている間の描画ごとに作る */
  entries: () => readonly MenuEntry[];
  /** メニューをボタンの右端にそろえるか左端にそろえるか */
  align?: "left" | "right";
  className?: string;
  menuClassName?: string;
  children: ReactNode;
}

export function MenuButton({
  label,
  title,
  disabled = false,
  entries,
  align = "right",
  className,
  menuClassName,
  children,
}: MenuButtonProps) {
  /** 開いているときは開いたときのフォーカスの置き方 */
  const [open, setOpen] = useState<"first" | "none" | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  // 使えなくなったら閉じる (また使えるようになっても開き直さない)
  if (disabled && open !== null) setOpen(null);
  const shown = open !== null && !disabled;

  return (
    <div ref={rootRef} className="relative">
      <Button
        variant="ghost"
        size="sm"
        className={cn(
          "aria-disabled:cursor-not-allowed aria-disabled:opacity-40 aria-disabled:hover:bg-transparent",
          className,
        )}
        aria-label={label}
        title={title}
        aria-haspopup="menu"
        aria-expanded={shown}
        aria-controls={shown ? menuId : undefined}
        aria-disabled={disabled ? true : undefined}
        onMouseDown={keepFocus}
        onClick={(event) => {
          if (disabled) return;
          // キーボード (Enter / Space) で押したときは detail が 0
          setOpen((current) => (current !== null ? null : event.detail === 0 ? "first" : "none"));
        }}
        onKeyDown={(event) => {
          if (disabled || shown) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen("first");
          }
        }}
      >
        {children}
      </Button>
      {shown && (
        <MenuList
          id={menuId}
          label={label}
          entries={entries()}
          initialFocus={open}
          insideRef={rootRef}
          onClose={() => setOpen(null)}
          className={cn(
            "absolute bottom-[calc(100%+8px)] z-20",
            align === "right" ? "right-0" : "left-0",
            menuClassName,
          )}
        />
      )}
    </div>
  );
}
