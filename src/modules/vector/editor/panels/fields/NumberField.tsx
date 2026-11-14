import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { cn } from "@/lib/cn";

import type { NodeId } from "../../model/types";
import { isComposing } from "./keys";
import { liveTargets } from "./targets";
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
  /**
   * 確定の対象のノード。入力を始めた時点の値を覚え、確定のときに残っているものだけを `onCommit` に渡す。
   * 残っていなければ確定しない。省略するとノードに関係しない欄 (ページの設定) として扱う
   */
  targets?: readonly NodeId[];
  /** 確定するときに残す小数点以下の桁数。既定は 0 (整数) */
  precision?: number;
  /** 値の後ろに出す単位 (%、° など) */
  suffix?: string;
  disabled?: boolean;
  className?: string;
  /** 確定した値 (範囲内で、`precision` に丸めてある) と対象 */
  onCommit(value: number, targets: readonly NodeId[]): void;
}

/** 入力を始めてから確定・取消までの間に覚えておくもの。 */
interface NumberSession {
  /** 入力を始めた時点の対象。null はノードに関係しない欄 */
  targets: readonly NodeId[] | null;
  onCommit(value: number, targets: readonly NodeId[]): void;
  range: NumberRange;
  precision: number;
  /** 入力を始めた時点に出ていた文字列 */
  initial: string;
  /** 今の入力 */
  text: string;
}

/** 入力を確定する。何も変えていない、読めない、範囲外、対象がなくなったときは何もしない。 */
function commitNumberSession(session: NumberSession | null): void {
  if (!session || session.text === session.initial) return;
  const parsed = parseNumberInput(session.text);
  if (parsed === null) return;
  const next = roundTo(parsed, session.precision);
  if (!inRange(next, session.range)) return;
  const targets = session.targets === null ? [] : liveTargets(session.targets);
  if (session.targets !== null && targets.length === 0) return;
  session.onCommit(next, targets);
}

/**
 * 数値の入力欄 (§5.3)。
 * - 入力中は文書を変えず、Enter かフォーカスが外れたときに確定する (確定 1 回 = 履歴 1 件)
 * - 確定は入力を始めた時点の対象に当てる。途中で選択が変わっても新しい選択には当てない。
 *   何も打っていなければ確定しない (Undo で値が変わっても、古い値を書き戻さない)。
 *   打ったまま欄が外れたとき (選択が空になったなど) は、その時点で確定する
 * - Esc で入力を取り消す。日本語入力の変換中の Enter と Esc は変換の操作として扱う
 * - 上下の矢印で ±1、Shift と一緒なら ±10 (範囲に収める)。「混在」で何も打っていなければ何もしない
 * - 範囲外や数値でない入力は確定せず、元の値に戻す
 */
export function NumberField({
  label,
  ariaLabel,
  value,
  targets,
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
  /** 打っている文字列。null は打っていない (今の値をそのまま出す) */
  const [draft, setDraft] = useState<string | null>(null);
  const session = useRef<NumberSession | null>(null);
  const shown = value === MIXED ? "" : formatNumber(value, precision);

  // 打ったまま欄が外れたら確定する (フォーカスのある要素が消えても blur は来ないため)
  useEffect(
    () => () => {
      const pending = session.current;
      session.current = null;
      commitNumberSession(pending);
    },
    [],
  );

  const finish = (commit: boolean) => {
    const pending = session.current;
    session.current = null;
    setDraft(null);
    if (commit) commitNumberSession(pending);
  };

  const step = (delta: number) => {
    const pending = session.current;
    const typed = pending ? parseNumberInput(pending.text) : null;
    const base = typed ?? (value === MIXED ? null : value);
    const stepTargets = pending ? pending.targets : (targets ?? null);
    finish(false);
    if (base === null) return;
    const next = clampToRange(roundTo(base + delta, precision), range);
    if (next === null) return;
    const live = stepTargets === null ? [] : liveTargets(stepTargets);
    if (stepTargets !== null && live.length === 0) return;
    onCommit(next, live);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isComposing(event)) return;
    switch (event.key) {
      case "Enter":
        event.preventDefault();
        finish(true);
        event.currentTarget.select();
        break;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        finish(false);
        event.currentTarget.blur();
        break;
      case "ArrowUp":
      case "ArrowDown": {
        event.preventDefault();
        const size = event.shiftKey ? 10 : 1;
        step(event.key === "ArrowUp" ? size : -size);
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
        value={draft ?? shown}
        placeholder={value === MIXED ? "混在" : undefined}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => {
          const text = event.target.value;
          if (session.current) session.current.text = text;
          else
            session.current = {
              targets: targets ? [...targets] : null,
              onCommit,
              range,
              precision,
              initial: shown,
              text,
            };
          setDraft(text);
        }}
        onBlur={() => finish(true)}
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
