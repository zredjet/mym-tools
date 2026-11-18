import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { cn } from "@/lib/cn";

import { CANVAS_LIMITS } from "../../model/limits";
import type { NodeId } from "../../model/types";
import { formatDash, parseDashInput } from "./dash";
import { isComposing } from "./keys";
import { liveTargets } from "./targets";
import { MIXED, type Mixed } from "./values";

interface DashSession {
  targets: readonly NodeId[];
  onCommit(dash: number[], targets: readonly NodeId[]): void;
  /** 入力を始めた時点に出ていた文字列。「混在」なら null (空の入力も実線として当てる) */
  initial: string | null;
  text: string;
}

/** 入力を確定する。何も変えていない、規則に合わない、対象がなくなったときは何もしない。 */
function commitDashSession(session: DashSession | null): void {
  if (!session || session.text === session.initial) return;
  const dash = parseDashInput(session.text);
  if (dash === null) return;
  const targets = liveTargets(session.targets);
  if (targets.length === 0) return;
  session.onCommit(dash, targets);
}

/**
 * 破線の欄 (§8.11)。数値をスペースかカンマで区切って入れる (例 `4 2`)。空は実線。
 * 確定の規則は `NumberField` と同じ: Enter かフォーカスが外れたときに、入力を始めた時点の対象へ当てる
 * (履歴 1 件)。Esc で取り消す。§8.3.2 の規則と上限に合わない入力は当てず、打っている間は欄を赤くする。
 * 「混在」のときは、打ってから空にして確定しても実線として当てる (全部を実線にそろえられるように)。
 */
export function DashField({
  ariaLabel,
  value,
  targets,
  onCommit,
}: {
  ariaLabel: string;
  /** 並び (空は実線) か「混在」 */
  value: readonly number[] | Mixed;
  targets: readonly NodeId[];
  onCommit(dash: number[], targets: readonly NodeId[]): void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const session = useRef<DashSession | null>(null);
  const shown = value === MIXED ? null : formatDash(value);
  const rejected = draft !== null && parseDashInput(draft) === null;

  useEffect(
    () => () => {
      const pending = session.current;
      session.current = null;
      commitDashSession(pending);
    },
    [],
  );

  const finish = (commit: boolean) => {
    const pending = session.current;
    session.current = null;
    setDraft(null);
    if (commit) commitDashSession(pending);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isComposing(event)) return;
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
      event.currentTarget.select();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      finish(false);
      event.currentTarget.blur();
    }
  };

  return (
    <label
      className={cn(
        "flex h-7 min-w-0 items-center gap-1 rounded-[var(--radius-sm)] border border-transparent",
        "bg-[var(--bg-muted)] px-1.5 text-[12px] focus-within:border-[var(--accent)]",
        "focus-within:bg-[var(--bg)] hover:border-[var(--border)]",
        rejected &&
          "border-[var(--destructive)] focus-within:border-[var(--destructive)] hover:border-[var(--destructive)]",
      )}
      title={
        rejected
          ? `${CANVAS_LIMITS.maxDashLength} 以下の 0 以上の数値を ${CANVAS_LIMITS.maxDashCount} 個まで (合計は 0 より大きく) 入れてください。確定されず元の値に戻ります`
          : "長さと間隔をスペースかカンマで区切って入れます (例 4 2)。空は実線"
      }
    >
      <input
        type="text"
        aria-label={ariaLabel}
        aria-invalid={rejected || undefined}
        className="w-full min-w-0 bg-transparent text-[var(--fg)] tabular-nums outline-none placeholder:text-[var(--fg-muted)] focus-visible:outline-none"
        value={draft ?? shown ?? ""}
        placeholder={value === MIXED ? "混在" : "実線"}
        spellCheck={false}
        autoComplete="off"
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => {
          const text = event.target.value;
          if (session.current) session.current.text = text;
          else session.current = { targets: [...targets], onCommit, initial: shown, text };
          setDraft(text);
        }}
        onBlur={() => finish(true)}
        onKeyDown={onKeyDown}
      />
    </label>
  );
}
