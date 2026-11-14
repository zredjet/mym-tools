import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { cn } from "@/lib/cn";

import type { NodeId } from "../../model/types";
import { editorStore } from "../../state/store";
import type { DocRecipe } from "../../state/types";
import { isComposing } from "./keys";
import { liveTargets } from "./targets";
import { MIXED, parseHexInput, type Mixed } from "./values";

/** 色の選択を最後に動かしてから確定するまでの時間 (§5.3)。 */
export const COLOR_PICK_SETTLE_MS = 500;

export interface ColorFieldProps {
  /** 読み上げ用の名前 (「塗りの色」など) */
  ariaLabel: string;
  value: string | Mixed;
  /** 確定の対象のノード。入力を始めた時点のものを使う (§5.3) */
  targets: readonly NodeId[];
  /** 色を当てる変更。対象には、入力を始めた時点の対象のうち残っているものが渡る */
  toRecipe(hex: string, targets: readonly NodeId[]): DocRecipe;
  disabled?: boolean;
  className?: string;
}

interface TextSession {
  targets: readonly NodeId[];
  toRecipe: ColorFieldProps["toRecipe"];
  initial: string;
  text: string;
}

function commitTextSession(session: TextSession | null): void {
  if (!session || session.text === session.initial) return;
  const hex = parseHexInput(session.text);
  if (hex === null) return;
  const targets = liveTargets(session.targets);
  if (targets.length === 0) return;
  editorStore.getState().apply(session.toRecipe(hex, targets));
}

interface PickSession {
  targets: readonly NodeId[];
  toRecipe: ColorFieldProps["toRecipe"];
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * 色の入力欄。`#RRGGBB` の文字入力と、ブラウザ標準の色の選択 (`<input type="color">`)。
 * 不透明度は別の欄で持つ。
 *
 * - 文字入力は数値の欄と同じ規則 (Enter かフォーカスが外れたときに、入力を始めた時点の対象へ確定。
 *   Esc で取消。打っていなければ確定しない。読めない入力は元に戻す)
 * - 色の選択は、動かしている間をジェスチャーとして文書に当て、最後に動かしてから
 *   `COLOR_PICK_SETTLE_MS` 何もなければ履歴 1 件として確定する。WebKit は色を選ぶたびに
 *   `change` を出すので、`change` では確定しない。フォーカスが外れたときと欄が外れるときは
 *   すぐに確定する。途中でほかの操作がジェスチャーを終えたら、次の色から新しいジェスチャーにする
 */
export function ColorField({
  ariaLabel,
  value,
  targets,
  toRecipe,
  disabled,
  className,
}: ColorFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const text = useRef<TextSession | null>(null);
  const pick = useRef<PickSession | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  /** ネイティブのイベントから最新の props を読むため */
  const latest = useRef({ targets, toRecipe });
  const shown = value === MIXED ? "" : value.toUpperCase();

  useEffect(() => {
    latest.current = { targets, toRecipe };
  });

  useEffect(() => {
    const endPick = () => {
      const session = pick.current;
      if (!session) return;
      pick.current = null;
      if (session.timer !== null) clearTimeout(session.timer);
      if (editorStore.getState().gestureActive) editorStore.getState().commitGesture();
    };

    const onPick = () => {
      const element = picker.current;
      const hex = element ? parseHexInput(element.value) : null;
      if (hex === null) return;
      let session = pick.current;
      if (!session) {
        const live = liveTargets(latest.current.targets);
        if (live.length === 0) return;
        editorStore.getState().beginGesture();
        session = { targets: live, toRecipe: latest.current.toRecipe, timer: null };
        pick.current = session;
      }
      editorStore.getState().updateGesture(session.toRecipe(hex, session.targets));
      if (session.timer !== null) clearTimeout(session.timer);
      session.timer = setTimeout(endPick, COLOR_PICK_SETTLE_MS);
    };

    // ほかの操作 (apply、undo など) がジェスチャーを終えたら、欄の側も終える
    const unsubscribe = editorStore.subscribe((state, prev) => {
      const session = pick.current;
      if (!session || state.gestureActive || !prev.gestureActive) return;
      pick.current = null;
      if (session.timer !== null) clearTimeout(session.timer);
    });

    const element = picker.current;
    element?.addEventListener("input", onPick);
    element?.addEventListener("change", onPick);
    element?.addEventListener("blur", endPick);
    return () => {
      element?.removeEventListener("input", onPick);
      element?.removeEventListener("change", onPick);
      element?.removeEventListener("blur", endPick);
      unsubscribe();
      endPick();
      const pending = text.current;
      text.current = null;
      commitTextSession(pending);
    };
  }, []);

  const finish = (commit: boolean) => {
    const pending = text.current;
    text.current = null;
    setDraft(null);
    if (commit) commitTextSession(pending);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isComposing(event)) return;
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      finish(false);
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
        {/* 値の変化はネイティブのイベントで受ける (WebKit の change の出方に合わせるため) */}
        <input
          ref={picker}
          type="color"
          aria-label={`${ariaLabel}を選ぶ`}
          disabled={disabled}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          value={value === MIXED ? "#000000" : value.toLowerCase()}
          onChange={() => {}}
        />
      </span>
      <input
        type="text"
        aria-label={ariaLabel}
        className="w-full min-w-0 bg-transparent font-mono text-[var(--fg)] uppercase outline-none placeholder:text-[var(--fg-muted)] placeholder:normal-case focus-visible:outline-none"
        value={draft ?? shown}
        placeholder={value === MIXED ? "混在" : undefined}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
        maxLength={7}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => {
          const next = event.target.value;
          if (text.current) text.current.text = next;
          else text.current = { targets: [...targets], toRecipe, initial: shown, text: next };
          setDraft(next);
        }}
        onBlur={() => finish(true)}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
