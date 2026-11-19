/**
 * エディタのメニューの部品 (§5.1 ツールバーの倍率・ブーリアン、§5.8 右クリックのメニュー)。
 * 見た目と振る舞いを 1 つにまとめる。位置は呼ぶ側が決める (`className` / `style`)。
 *
 * - `role="menu"` / `menuitem` / `separator`。使えない項目は `aria-disabled` で出し (理由は `title`)、
 *   押しても閉じない。矢印のキーでは飛ばす
 * - 開いたらメニューそのもの (キーボードで開いたときは最初の使える項目) にフォーカスを置き、閉じるときに開く前の
 *   要素へ戻す。項目と区切りはマウスで押してもフォーカスを取らない
 * - 開いている間のキーは window の捕捉の段階で受けて、ほかへ渡さず既定の動きも止める (キャンバスのショートカットや
 *   ブラウザのすべて選択を効かせない)。↑↓ Home End で移り (切り取られたメニューは移った項目が見えるように中で
 *   スクロールする)、Enter / Space で選び (押しっぱなしの繰り返しでは選ばない)、Esc で閉じる。Tab は閉じて、
 *   フォーカスを開く前の要素へ戻してから既定の移動に任せる
 * - キーの対象がメニューの外 (ダイアログなど) か、モーダルが開いているときは、閉じてキーをそのまま通す
 * - 外を押す (`insideRef` の中は除く)、フォーカスがメニューの外へ移る、ウィンドウのフォーカスが外れる、項目を選ぶ、
 *   で閉じる。選んだときは閉じてから項目の `run` を呼ぶ
 */
import type { LucideIcon } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";

import { cn } from "@/lib/cn";

import { isModalOpen } from "../canvas/input";
import { keepFocus, nextEnabledIndex } from "./menuNavigation";

export interface MenuItem {
  type: "item";
  id: string;
  label: string;
  icon?: LucideIcon | undefined;
  /** 右に出すショートカットの表示 */
  shortcut?: string | undefined;
  /** 使えない表示にする */
  disabled?: boolean | undefined;
  /** ツールチップ (使えない理由など) */
  title?: string | undefined;
  run(): void;
}

export interface MenuSeparator {
  type: "separator";
  id: string;
}

export type MenuEntry = MenuItem | MenuSeparator;

export type MenuCloseReason = "select" | "escape" | "tab" | "outside" | "blur";

export interface MenuListProps {
  id?: string;
  /** 読み上げの名前 */
  label: string;
  entries: readonly MenuEntry[];
  /** 開いたときのフォーカス。`first` は最初の使える項目 (キーボードで開いたとき)、`menu` はメニューそのもの */
  initialFocus?: "first" | "menu";
  onClose(reason: MenuCloseReason): void;
  /** 押しても外とみなさない範囲 (開くボタンを含むまとまり)。省略はメニューだけ */
  insideRef?: RefObject<HTMLElement | null>;
  menuRef?: RefObject<HTMLDivElement | null>;
  className?: string;
  style?: CSSProperties;
}

export function MenuList({
  id,
  label,
  entries,
  initialFocus = "menu",
  onClose,
  insideRef,
  menuRef,
  className,
  style,
}: MenuListProps) {
  const ownRef = useRef<HTMLDivElement | null>(null);
  const rootRef = menuRef ?? ownRef;
  /** 強調している項目 (`entries` の添字)。-1 はなし */
  const [active, setActive] = useState(-1);
  /** 開く前にフォーカスのあった要素 (閉じるときに戻す) */
  const restoreRef = useRef<Element | null>(null);
  const latest = useRef({ entries, onClose, active });
  useLayoutEffect(() => {
    latest.current = { entries, onClose, active };
  });

  const itemElement = (index: number) =>
    rootRef.current?.querySelector<HTMLElement>(`[data-menu-index="${index}"]`) ?? null;

  const focusIndex = (index: number) => {
    setActive(index);
    latest.current.active = index;
    const root = rootRef.current;
    if (index < 0) {
      root?.focus({ preventScroll: true });
      return;
    }
    const element = itemElement(index);
    element?.focus({ preventScroll: true });
    // メニューの中だけをスクロールして、移った項目を見せる (エディタの外側はスクロールしない)
    if (root && element && element.offsetParent === root) {
      const top = element.offsetTop;
      const bottom = top + element.offsetHeight;
      if (top < root.scrollTop) root.scrollTop = top;
      else if (bottom > root.scrollTop + root.clientHeight)
        root.scrollTop = bottom - root.clientHeight;
    }
  };

  /** 閉じ始めたか (閉じる途中のフォーカスの移動などで、もう一度閉じない) */
  const closedRef = useRef(false);

  /** 閉じる。フォーカスがメニューの中にあれば開く前の要素へ戻す (外を押したときは押した先に任せる)。 */
  const finish = (reason: MenuCloseReason, run?: () => void) => {
    if (closedRef.current) return;
    closedRef.current = true;
    const root = rootRef.current;
    const focused = document.activeElement;
    if (reason !== "outside" && root && focused && root.contains(focused)) {
      const restore = restoreRef.current;
      if (restore instanceof HTMLElement && restore.isConnected && !root.contains(restore))
        restore.focus({ preventScroll: true });
      else if (focused instanceof HTMLElement) focused.blur();
    }
    latest.current.onClose(reason);
    run?.();
  };
  const finishRef = useRef(finish);
  useLayoutEffect(() => {
    finishRef.current = finish;
  });

  // 開いたときのフォーカス
  useLayoutEffect(() => {
    // StrictMode の 2 回目の実行では、フォーカスはもうメニューの中にある (開く前の要素を残す)
    const focused = document.activeElement;
    if (!(focused && rootRef.current?.contains(focused))) restoreRef.current = focused;
    if (initialFocus === "first") {
      const first = nextEnabledIndex(latest.current.entries, -1, 1);
      focusIndex(first);
    } else if (initialFocus === "menu") rootRef.current?.focus({ preventScroll: true });
    // 開いたときだけ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const isInside = (target: EventTarget | null) => {
      if (!(target instanceof Node)) return false;
      return (
        (rootRef.current?.contains(target) ?? false) ||
        (insideRef?.current?.contains(target) ?? false)
      );
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!isInside(event.target)) finishRef.current("outside");
    };
    // フォーカスがメニューの外へ移った (ダイアログが開いたなど)
    const onFocusIn = (event: FocusEvent) => {
      if (!isInside(event.target)) finishRef.current("outside");
    };
    const onKeyDown = (event: KeyboardEvent) => {
      // ダイアログが開いている、またはキーの対象がメニューの外なら、閉じてキーをそのまま通す
      if (isModalOpen() || !isInside(event.target)) {
        finishRef.current("outside");
        return;
      }
      // 開いている間のキーはメニューのもの (キャンバスやアプリのショートカット、ブラウザの既定の動きへ渡さない)
      event.stopPropagation();
      const { entries: list, active: current } = latest.current;
      switch (event.key) {
        case "Escape":
          event.preventDefault();
          finishRef.current("escape");
          return;
        case "ArrowDown":
        case "ArrowUp":
          event.preventDefault();
          focusIndex(nextEnabledIndex(list, current, event.key === "ArrowDown" ? 1 : -1));
          return;
        case "Home":
        case "End":
          event.preventDefault();
          focusIndex(nextEnabledIndex(list, -1, event.key === "Home" ? 1 : -1));
          return;
        case "Enter":
        case " ": {
          event.preventDefault();
          // 押しっぱなしの繰り返しでは選ばない (開いたボタンの Enter や手のひらの Space が続いて届く)
          if (event.repeat) return;
          const entry = list[current];
          if (entry?.type === "item" && !entry.disabled) finishRef.current("select", entry.run);
          return;
        }
        case "Tab":
          // 既定の移動 (開く前の要素から次へ) に任せる
          finishRef.current("tab");
          return;
        default:
          event.preventDefault();
      }
    };
    const onBlur = () => finishRef.current("blur");
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("focusin", onFocusIn, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("focusin", onFocusIn, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onBlur);
    };
    // 開いている間に 1 度だけ付ける (今の値は latest / finishRef から読む)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={rootRef}
      id={id}
      role="menu"
      aria-label={label}
      aria-orientation="vertical"
      tabIndex={-1}
      className={cn(
        "min-w-[200px] overflow-y-auto rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg)] p-1 shadow-[0_8px_24px_rgba(0,0,0,0.10)]",
        className,
      )}
      // メニューそのものにフォーカスを置いても枠を出さない (全体の `:focus-visible` は層の外なので、class では消えない)
      style={{ outline: "none", ...style }}
      onMouseDown={keepFocus}
      onContextMenu={(event) => event.preventDefault()}
    >
      {entries.map((entry, index) => {
        if (entry.type === "separator")
          return (
            <div
              key={entry.id}
              role="separator"
              className="mx-1 my-1 h-px bg-[var(--border)]"
              aria-hidden="true"
            />
          );
        const Icon = entry.icon;
        const highlighted = index === active && !entry.disabled;
        return (
          <button
            key={entry.id}
            type="button"
            role="menuitem"
            tabIndex={-1}
            data-menu-index={index}
            aria-disabled={entry.disabled ? true : undefined}
            title={entry.title}
            className={cn(
              "flex h-7 w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 text-left text-[13px] whitespace-nowrap",
              entry.disabled
                ? "cursor-not-allowed text-[var(--fg-subtle)]"
                : "cursor-default text-[var(--fg)]",
              highlighted && "bg-[var(--bg-muted)]",
            )}
            onMouseDown={keepFocus}
            onPointerMove={() => {
              if (!entry.disabled && latest.current.active !== index) {
                latest.current.active = index;
                setActive(index);
              }
            }}
            onPointerLeave={() => {
              if (latest.current.active === index) {
                latest.current.active = -1;
                setActive(-1);
              }
            }}
            onClick={() => {
              if (!entry.disabled) finish("select", entry.run);
            }}
          >
            {Icon && (
              <Icon
                size={14}
                aria-hidden="true"
                className={cn(
                  "shrink-0",
                  entry.disabled ? "text-[var(--fg-subtle)]" : "text-[var(--fg-muted)]",
                )}
              />
            )}
            <span className="min-w-0 flex-1 truncate">{entry.label}</span>
            {entry.shortcut && (
              <span
                className={cn(
                  "shrink-0 pl-4 text-[12px]",
                  entry.disabled ? "text-[var(--fg-subtle)]" : "text-[var(--fg-muted)]",
                )}
              >
                {entry.shortcut}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
