/**
 * プロパティパネルの文字の節 (§5.3 / §5.7)。選択の中のテキストだけに当てる。
 *
 * フォント (候補の一覧と直接入力)、サイズ、太さ、斜体、行の高さ (自動は null)、字間、揃え、大きさの決め方。
 * 文書のフォントがその PC になければ注意を出す (描画は総称フォントになる)。
 * どの変更も同じ `DocRecipe` の中で `fitTextNodes` を通す (`text/textOps.ts`)。
 * 入力欄の確定の規則は `NumberField` と同じ (入力を始めた時点の対象に当てる。打っていなければ確定しない)。
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { AlertTriangle, ChevronDown, MoveVertical, RotateCcw, Type, WholeWord } from "lucide-react";

import { cn } from "@/lib/cn";

import { CANVAS_LIMITS } from "../../model/limits";
import type { CanvasNode, NodeId, TextAlign, TextNode, TextSizing } from "../../model/types";
import { canvasTextMeasurer } from "../../render/measureText";
import { editorStore } from "../../state/store";
import { fontDetector } from "../../text/fonts";
import { lineHeightOf } from "../../text/layout";
import {
  applyTextStyle,
  FONT_WEIGHTS,
  parseFontFamilyInput,
  type TextStylePatch,
} from "../../text/textOps";
import { isComposing } from "../fields/keys";
import { NumberField } from "../fields/NumberField";
import { CheckboxField, FieldGrid, IconButton, Section, Segmented } from "../fields/Section";
import { liveTargets } from "../fields/targets";
import { commonValue, MIXED, type Mixed } from "../fields/values";
import { useSelectedNodes } from "../selection";

const isText = (node: CanvasNode): node is TextNode => node.type === "text";

function applyStyle(targets: readonly NodeId[], patch: TextStylePatch) {
  editorStore.getState().apply((doc) => applyTextStyle(doc, targets, patch, canvasTextMeasurer));
}

const ALIGN_OPTIONS: readonly { value: TextAlign; label: string }[] = [
  { value: "left", label: "左" },
  { value: "center", label: "中央" },
  { value: "right", label: "右" },
];

const SIZING_OPTIONS: readonly { value: TextSizing; label: string }[] = [
  { value: "auto-width", label: "幅を自動" },
  { value: "auto-height", label: "高さを自動" },
  { value: "fixed", label: "固定" },
];

const SELECT_CLASS =
  "h-7 w-full min-w-0 rounded-[var(--radius-sm)] border border-transparent bg-[var(--bg-muted)] px-1.5 text-[12px] text-[var(--fg)] outline-none hover:border-[var(--border)] focus:border-[var(--accent)]";

/** 入力を始めてから確定・取消までの間に覚えておくもの。 */
interface FamilySession {
  targets: readonly NodeId[];
  initial: string;
  text: string;
}

function commitFamilySession(session: FamilySession | null): void {
  if (!session || session.text === session.initial) return;
  const family = parseFontFamilyInput(session.text);
  if (family === null) return;
  const targets = liveTargets(session.targets);
  if (targets.length === 0) return;
  applyStyle(targets, { fontFamily: family });
}

/**
 * フォント名の直接入力。Enter かフォーカスが外れたときに確定し、Esc で取り消す。
 * 日本語入力の変換中の Enter と Esc は変換の操作として扱う。読めない名前は確定せず元に戻す。
 */
function FontFamilyInput({
  value,
  targets,
}: {
  value: string | Mixed;
  targets: readonly NodeId[];
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const session = useRef<FamilySession | null>(null);
  const shown = value === MIXED ? "" : value;

  // 打ったまま欄が外れたら確定する (フォーカスのある要素が消えても blur は来ないため)
  useEffect(
    () => () => {
      const pending = session.current;
      session.current = null;
      commitFamilySession(pending);
    },
    [],
  );

  const finish = (commit: boolean) => {
    const pending = session.current;
    session.current = null;
    setDraft(null);
    if (commit) commitFamilySession(pending);
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
    <input
      type="text"
      aria-label="フォント名"
      className={cn(SELECT_CLASS, "flex-1 placeholder:text-[var(--fg-muted)]")}
      value={draft ?? shown}
      placeholder={value === MIXED ? "混在" : undefined}
      spellCheck={false}
      autoComplete="off"
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => {
        const text = event.target.value;
        if (session.current) session.current.text = text;
        else session.current = { targets: [...targets], initial: shown, text };
        setDraft(text);
      }}
      onBlur={() => finish(true)}
      onKeyDown={onKeyDown}
    />
  );
}

/**
 * その PC にある候補の一覧から選ぶボタン。見えない `<select>` を矢印のアイコンに重ね、一覧は OS の部品で出す。
 * 今のフォントが一覧になければ先頭に出す。
 */
function FontFamilyPicker({
  value,
  targets,
}: {
  value: string | Mixed;
  targets: readonly NodeId[];
}) {
  const groups = fontDetector.availableGroups();
  const listed = groups.some((group) => group.families.includes(value as string));
  return (
    <div
      title="候補から選ぶ"
      className={cn(
        "relative flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-[var(--fg-muted)]",
        "focus-within:ring-2 focus-within:ring-[var(--accent)] hover:bg-[var(--bg-muted)] hover:text-[var(--fg)]",
      )}
    >
      <ChevronDown size={14} aria-hidden />
      <select
        aria-label="フォントの候補"
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        value={value === MIXED || !listed ? "" : value}
        onChange={(event) => {
          const family = parseFontFamilyInput(event.target.value);
          const live = liveTargets(targets);
          if (family !== null && live.length > 0) applyStyle(live, { fontFamily: family });
        }}
      >
        <option value="" disabled>
          {value === MIXED ? "混在" : value}
        </option>
        {groups.map((group) => (
          <optgroup key={group.label} label={group.label}>
            {group.families.map((family) => (
              <option key={family} value={family}>
                {family}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}

export function TextSection() {
  const texts = useSelectedNodes().filter(isText);
  if (texts.length === 0) return null;
  const ids = texts.map((node) => node.id);
  const family = commonValue(texts.map((node) => node.fontFamily));
  const missing = [...new Set(texts.map((node) => node.fontFamily))].filter(
    (name) => !fontDetector.isAvailable(name),
  );
  const weight = commonValue(texts.map((node) => node.fontWeight));
  const lineHeights = texts.map((node) => node.lineHeight);
  const allAuto = lineHeights.every((value) => value === null);
  const anyExplicit = lineHeights.some((value) => value !== null);
  const align = commonValue(texts.map((node) => node.align));
  const sizing = commonValue(texts.map((node) => node.sizing));

  return (
    <Section title="文字">
      <div className="flex min-w-0 items-center gap-0.5">
        <FontFamilyInput value={family} targets={ids} />
        <FontFamilyPicker value={family} targets={ids} />
      </div>
      {missing.length > 0 && (
        <p
          role="note"
          className="flex items-start gap-1.5 text-[11px] leading-[1.45] text-[var(--fg-muted)]"
        >
          <AlertTriangle size={13} className="mt-px shrink-0 text-amber-600" aria-hidden />
          <span>
            {`${missing.map((name) => `「${name}」`).join("")}はこの PC にありません。代わりのフォントで表示しています。`}
          </span>
        </p>
      )}
      <FieldGrid>
        <NumberField
          label={<Type size={13} />}
          ariaLabel="フォントサイズ"
          precision={2}
          value={commonValue(texts.map((node) => node.fontSize))}
          min={CANVAS_LIMITS.minFontSize}
          max={CANVAS_LIMITS.maxFontSize}
          targets={ids}
          onCommit={(value, targets) => applyStyle(targets, { fontSize: value })}
        />
        <select
          aria-label="太さ"
          className={SELECT_CLASS}
          value={weight === MIXED ? "" : String(weight)}
          onChange={(event) => {
            const value = Number(event.target.value);
            const live = liveTargets(ids);
            if (FONT_WEIGHTS.some((option) => option.value === value) && live.length > 0)
              applyStyle(live, { fontWeight: value });
          }}
        >
          {weight === MIXED && (
            <option value="" disabled>
              混在
            </option>
          )}
          {FONT_WEIGHTS.map((option) => (
            <option key={option.value} value={String(option.value)}>
              {option.label}
            </option>
          ))}
        </select>
      </FieldGrid>
      <div className="flex min-w-0 items-center gap-0.5">
        <NumberField
          label={<MoveVertical size={13} />}
          ariaLabel="行の高さ"
          className="flex-1"
          precision={2}
          {...(allAuto ? { suffix: "自動" } : {})}
          value={commonValue(texts.map(lineHeightOf))}
          min={0}
          minExclusive
          max={CANVAS_LIMITS.maxLineHeight}
          targets={ids}
          onCommit={(value, targets) => applyStyle(targets, { lineHeight: value })}
        />
        <IconButton
          label="行の高さを自動にする"
          disabled={!anyExplicit}
          onClick={() => applyStyle(liveTargets(ids), { lineHeight: null })}
        >
          <RotateCcw size={13} />
        </IconButton>
      </div>
      <FieldGrid>
        <NumberField
          label={<WholeWord size={13} />}
          ariaLabel="字間"
          precision={2}
          suffix="px"
          value={commonValue(texts.map((node) => node.letterSpacing))}
          min={-CANVAS_LIMITS.maxLetterSpacing}
          max={CANVAS_LIMITS.maxLetterSpacing}
          targets={ids}
          onCommit={(value, targets) => applyStyle(targets, { letterSpacing: value })}
        />
        <CheckboxField
          label="斜体"
          checked={commonValue(texts.map((node) => node.italic))}
          onChange={(italic) => applyStyle(liveTargets(ids), { italic })}
        />
      </FieldGrid>
      <Segmented
        label="揃え"
        options={ALIGN_OPTIONS}
        value={align === MIXED ? null : align}
        onChange={(value) => applyStyle(liveTargets(ids), { align: value })}
      />
      <Segmented
        label="大きさの決め方"
        options={SIZING_OPTIONS}
        value={sizing === MIXED ? null : sizing}
        onChange={(value) => applyStyle(liveTargets(ids), { sizing: value })}
      />
    </Section>
  );
}
