import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { cn } from "@/lib/cn";

import { editorStore } from "../../state/store";
import type { DocRecipe } from "../../state/types";
import { isComposing } from "./keys";
import { MIXED, parseHexInput, type Mixed } from "./values";

export interface ColorFieldProps {
  /** 読み上げ用の名前 (「塗りの色」など) */
  ariaLabel: string;
  value: string | Mixed;
  /** 色を当てる変更。文字の入力では `apply`、色の選択ではジェスチャーとして当てる */
  toRecipe(hex: string): DocRecipe;
  disabled?: boolean;
  className?: string;
}

/**
 * 色の入力欄。`#RRGGBB` の文字入力と、ブラウザ標準の色の選択 (`<input type="color">`)。
 * 不透明度は別の欄で持つ。
 *
 * - 文字入力は Enter かフォーカスが外れたときに確定する。Esc で取り消す。読めない入力は元に戻す
 * - 色の選択は、動かしている間はジェスチャーとして文書に当て (履歴に積まない)、
 *   選択を閉じたとき (`change`) に 1 件だけ履歴に積む
 */
export function ColorField({ ariaLabel, value, toRecipe, disabled, className }: ColorFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  const picker = useRef<HTMLInputElement>(null);
  const previewing = useRef(false);
  const shown = value === MIXED ? "" : value.toUpperCase();
  const text = draft ?? shown;

  // React の onChange は `input` イベントなので、選択を閉じたときの `change` は自分で拾う
  useEffect(() => {
    const element = picker.current;
    if (!element) return;
    const finish = () => {
      if (!previewing.current) return;
      previewing.current = false;
      editorStore.getState().commitGesture();
    };
    element.addEventListener("change", finish);
    element.addEventListener("blur", finish);
    return () => {
      element.removeEventListener("change", finish);
      element.removeEventListener("blur", finish);
      finish();
    };
  }, []);

  const commit = (input: string) => {
    setDraft(null);
    if (input === shown) return;
    const hex = parseHexInput(input);
    if (hex === null || hex === shown) return;
    editorStore.getState().apply(toRecipe(hex));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isComposing(event)) return;
    if (event.key === "Enter") {
      event.preventDefault();
      commit(text);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancelled.current = true;
      setDraft(null);
      event.currentTarget.blur();
    }
  };

  return (
    <div
      className={cn(
        "flex h-7 min-w-0 items-center gap-1 rounded-[var(--radius-sm)] border border-transparent",
        "bg-[var(--bg-muted)] px-1 text-[12px] focus-within:border-[var(--accent)]",
        "focus-within:bg-[var(--bg)] hover:border-[var(--border)]",
        disabled && "opacity-60",
        className,
      )}
    >
      <span
        className={cn(
          "relative h-4 w-4 shrink-0 overflow-hidden rounded-[var(--radius-sm)] border border-[var(--border-strong)]",
          value === MIXED &&
            "bg-[repeating-linear-gradient(45deg,var(--bg)_0_3px,var(--border-strong)_3px_6px)]",
        )}
        style={value === MIXED ? undefined : { backgroundColor: value }}
      >
        <input
          ref={picker}
          type="color"
          aria-label={`${ariaLabel}を選ぶ`}
          disabled={disabled}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          value={value === MIXED ? "#000000" : value.toLowerCase()}
          onChange={(event) => {
            const hex = parseHexInput(event.target.value);
            if (hex === null) return;
            const store = editorStore.getState();
            if (!previewing.current) {
              previewing.current = true;
              store.beginGesture();
            }
            editorStore.getState().updateGesture(toRecipe(hex));
          }}
        />
      </span>
      <input
        type="text"
        aria-label={ariaLabel}
        className="w-full min-w-0 bg-transparent font-mono text-[var(--fg)] uppercase outline-none placeholder:text-[var(--fg-muted)] placeholder:normal-case focus-visible:outline-none"
        value={text}
        placeholder={value === MIXED ? "混在" : undefined}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
        maxLength={7}
        onFocus={(event) => {
          cancelled.current = false;
          setDraft(shown);
          event.currentTarget.select();
        }}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (cancelled.current) {
            cancelled.current = false;
            setDraft(null);
            return;
          }
          if (draft !== null) commit(draft);
        }}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
