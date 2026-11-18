import { cn } from "@/lib/cn";

import { editorStore, useEditorStore } from "../../state/store";
import type { EditorStore } from "../../state/types";
import { Section } from "../fields/Section";
import { availableConvertActions, CONVERT_ACTIONS } from "./convertActions";
import type { ConvertAction, ConvertAvailability } from "./convertSupport";

interface ShownAction {
  action: ConvertAction;
  availability: ConvertAvailability;
}

/** 出す操作の要約 (購読の比較用)。`[id, 理由, 押せるか]` の並びの JSON。 */
let cache: { deps: readonly unknown[]; key: string } | null = null;
function shownKey(state: EditorStore): string {
  // 文書・選択・スコープ・点の編集が同じなら求め直さない (パンやホバーでも selector は呼ばれる)
  const deps = [state.doc, state.selection, state.scopeId, state.editingPathId, state.pageId];
  const hit = cache;
  if (hit && deps.every((d, i) => d === hit.deps[i])) return hit.key;
  const key = JSON.stringify(
    availableConvertActions(state).map(({ action, availability }) => [
      action.id,
      availability.enabled ? "" : availability.reason,
      availability.enabled,
    ]),
  );
  cache = { deps, key };
  return key;
}

function parseShown(key: string): ShownAction[] {
  const entries = JSON.parse(key) as [string, string, boolean][];
  return entries.flatMap(([id, reason, enabled]) => {
    const action = CONVERT_ACTIONS.find((a) => a.id === id);
    if (!action) return [];
    const availability: ConvertAvailability = enabled
      ? { enabled: true }
      : { enabled: false, reason };
    return [{ action, availability }];
  });
}

function titleOf({ action, availability }: ShownAction): string {
  const base = action.shortcut ? `${action.label} (${action.shortcut})` : action.label;
  return availability.enabled ? base : `${base} — ${availability.reason}`;
}

const buttonClass = cn(
  "inline-flex h-7 items-center rounded-[var(--radius-sm)] text-[12px] text-[var(--fg)]",
  "hover:bg-[var(--bg-muted)] disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent",
  "focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none",
);

/**
 * 「変換」の節 (§5.3)。登録口 (`convertActions.ts`) の操作のうち、今の選択に出すものを並べる。
 * ブーリアンの 4 つはアイコンだけのボタンを 1 行に、ほかは文字のボタンを 1 行ずつ。
 * 押せない操作は理由をツールチップに出す。出すものがなければ節ごと出さない。
 */
export function ConvertSection() {
  const key = useEditorStore(shownKey);
  const shown = parseShown(key);
  if (shown.length === 0) return null;
  const run = (action: ConvertAction) => action.run(editorStore);
  const icons = shown.filter((s) => s.action.variant === "icon");
  const rows = shown.filter((s) => s.action.variant !== "icon");
  return (
    <Section title="変換">
      {rows.map((item) => {
        const Icon = item.action.icon;
        return (
          <button
            key={item.action.id}
            type="button"
            aria-label={item.action.label}
            title={titleOf(item)}
            disabled={!item.availability.enabled}
            className={cn(buttonClass, "gap-2 px-1.5")}
            onClick={() => run(item.action)}
          >
            <Icon size={14} aria-hidden="true" className="shrink-0 text-[var(--fg-muted)]" />
            <span className="truncate">{item.action.label}</span>
          </button>
        );
      })}
      {icons.length > 0 && (
        <div role="group" aria-label="ブーリアン演算" className="flex items-center gap-0.5">
          {icons.map((item) => {
            const Icon = item.action.icon;
            return (
              <button
                key={item.action.id}
                type="button"
                aria-label={item.action.label}
                title={titleOf(item)}
                disabled={!item.availability.enabled}
                className={cn(
                  buttonClass,
                  "w-7 justify-center text-[var(--fg-muted)] hover:text-[var(--fg)]",
                )}
                onClick={() => run(item.action)}
              >
                <Icon size={14} aria-hidden="true" />
              </button>
            );
          })}
        </div>
      )}
    </Section>
  );
}
