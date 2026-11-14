import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { cn } from "@/lib/cn";

import { isComposing } from "./keys";
import {
  clampToRange,
  formatNumber,
  inRange,
  MIXED,
  parseNumberInput,
  roundTo,
  type Mixed,
  type NumberRange,
} from "./values";

export interface NumberFieldProps extends NumberRange {
  /** 欄の頭に出す短い名前 (X、W など) かアイコン。空なら出さない */
  label: ReactNode;
  /** 読み上げ用の名前 */
  ariaLabel: string;
  value: number | Mixed;
  /** 確定するときに残す小数点以下の桁数。既定は 0 (整数) */
  precision?: number;
  /** 値の後ろに出す単位 (%、° など) */
  suffix?: string;
  disabled?: boolean;
  className?: string;
  /** 確定した値。範囲内で、`precision` に丸めてある */
  onCommit(value: number): void;
}

/**
 * 数値の入力欄 (§5.3)。
 * - 入力中は文書を変えず、Enter かフォーカスが外れたときに確定する (確定 1 回 = 履歴 1 件)
 * - Esc で入力を取り消す。日本語入力の変換中の Enter と Esc は変換の操作として扱う
 * - 上下の矢印で ±1、Shift と一緒なら ±10 (範囲に収める)。「混在」のときは何もしない
 * - 範囲外や数値でない入力は確定せず、元の値に戻す
 */
export function NumberField({
  label,
  ariaLabel,
  value,
  min,
  max,
  minExclusive,
  precision = 0,
  suffix,
  disabled,
  className,
  onCommit,
}: NumberFieldProps) {
  const range: NumberRange = minExclusive ? { min, max, minExclusive } : { min, max };
  /** 編集中の文字列。null は編集していない (値をそのまま出す) */
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  const shown = value === MIXED ? "" : formatNumber(value, precision);
  const text = draft ?? shown;

  const commit = (input: string) => {
    setDraft(null);
    if (input === shown) return;
    const parsed = parseNumberInput(input);
    if (parsed === null) return;
    const next = roundTo(parsed, precision);
    if (!inRange(next, range)) return;
    if (value !== MIXED && next === value) return;
    onCommit(next);
  };

  const step = (delta: number, input: string) => {
    const parsed = input === shown ? null : parseNumberInput(input);
    const base = parsed ?? (value === MIXED ? null : value);
    setDraft(null);
    if (base === null) return;
    const next = clampToRange(roundTo(base + delta, precision), range);
    if (next === null || (value !== MIXED && next === value)) return;
    onCommit(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isComposing(event)) return;
    switch (event.key) {
      case "Enter":
        event.preventDefault();
        commit(text);
        event.currentTarget.select();
        break;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        cancelled.current = true;
        setDraft(null);
        event.currentTarget.blur();
        break;
      case "ArrowUp":
      case "ArrowDown": {
        event.preventDefault();
        const size = event.shiftKey ? 10 : 1;
        step(event.key === "ArrowUp" ? size : -size, text);
        break;
      }
    }
  };

  return (
    <label
      className={cn(
        "flex h-7 min-w-0 items-center gap-1 rounded-[var(--radius-sm)] border border-transparent",
        "bg-[var(--bg-muted)] px-1.5 text-[12px] focus-within:border-[var(--accent)]",
        "focus-within:bg-[var(--bg)] hover:border-[var(--border)]",
        disabled && "opacity-60",
        className,
      )}
    >
      {label !== "" && (
        <span
          aria-hidden="true"
          className="flex shrink-0 items-center text-[var(--fg-subtle)] select-none"
        >
          {label}
        </span>
      )}
      <input
        type="text"
        inputMode="decimal"
        aria-label={ariaLabel}
        className="w-full min-w-0 bg-transparent text-[var(--fg)] tabular-nums outline-none placeholder:text-[var(--fg-muted)] focus-visible:outline-none"
        value={text}
        placeholder={value === MIXED ? "混在" : undefined}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
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
      {suffix !== undefined && (
        <span aria-hidden="true" className="shrink-0 text-[var(--fg-subtle)] select-none">
          {suffix}
        </span>
      )}
    </label>
  );
}
