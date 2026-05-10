/**
 * Color 新規作成 / 編集ダイアログ (`docs/ui-design.md` §6.5 K-2)。
 *
 * `mode` で create / edit を切替。**HEX/RGB/HSL/OKLCH の 4 色空間を同時表示** し、
 * いずれかを編集すると他の 3 つも自動同期する (canonical = HEX、6 桁)。
 *
 * - HEX は保存時に大文字正規化 (`docs/data-model.md` §10.3「正規化済み (大文字)」)
 * - alpha (`#RRGGBBAA`) は Phase 1 では drop (将来検討)
 *
 * ## 双方向バインドの設計
 *
 * - canonical state: `hex: string` (常に `#RRGGBB` の妥当な値、初期値含む)
 * - 各色空間 input は **`ColorChannelInput`** で個別に管理:
 *   - 通常時は canonical hex から `format` で表示文字列を導出
 *   - ユーザーが入力中は内部 draft で表示 (まだパース不能でも入力を保持)
 *   - 入力が valid (parse 成功) なら canonical hex を更新 → 他 input も追従
 *   - blur 時は draft をクリア → canonical 由来の表示に戻る
 * - これにより「3 つを表示・1 つを編集」を `useEffect` の setState 連鎖なしで実現
 *
 * ## ショートカット
 * - `Cmd/Ctrl + S` / `Cmd/Ctrl + Enter`: 保存
 */
import { useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";

import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { createItem, updateItem } from "@/ipc/items";
import {
  formatHexDisplay,
  formatHslDisplay,
  formatOklchDisplay,
  formatRgbDisplay,
  parseHexInput,
  parseHslInput,
  parseOklchInput,
  parseRgbInput,
} from "@/lib/color";
import { cn } from "@/lib/cn";
import { formatInvokeError } from "@/lib/error";
import type { ColorPayloadV1, Item } from "@/lib/types";

const HEX6_REGEX = /^#[0-9A-Fa-f]{6}$/;

type DialogMode = { mode: "create"; projectId: string } | { mode: "edit"; item: Item };

type Props = {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
} & DialogMode;

export function ColorItemDialog(props: Props) {
  const title = props.mode === "create" ? "新規 Color" : "Color を編集";
  return (
    <Modal open={props.open} onClose={props.onClose} title={title} widthClassName="w-full max-w-xl">
      {props.open && <Content {...props} />}
    </Modal>
  );
}

function Content(props: Props) {
  const initial: ColorPayloadV1 | null =
    props.mode === "edit" ? (props.item.payload as ColorPayloadV1) : null;
  // canonical: 常に妥当な #RRGGBB に保つ (alpha は drop)。create 初期値は #3B82F6 (blue-600)
  const initialHex =
    initial?.hex != null && HEX6_REGEX.test(initial.hex.slice(0, 7))
      ? initial.hex.slice(0, 7).toUpperCase()
      : "#3B82F6";
  const [name, setName] = useState(props.mode === "edit" ? props.item.title : "");
  const [hex, setHex] = useState(initialHex);
  const [tagsInput, setTagsInput] = useState(
    props.mode === "edit" ? props.item.tags.join(", ") : "",
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = !submitting && name.trim().length > 0 && HEX6_REGEX.test(hex);

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const tags = tagsInput
        .split(",")
        .map((t) => t.trim().replace(/^#/, ""))
        .filter((t) => t.length > 0);
      const payload = { hex: hex.toUpperCase() };
      if (props.mode === "create") {
        await createItem({
          moduleId: "color",
          projectId: props.projectId,
          title: name.trim(),
          tags,
          payload,
        });
      } else {
        await updateItem({
          moduleId: "color",
          itemId: props.item.id,
          title: name.trim(),
          tags,
          payload,
        });
      }
      props.onSaved();
      props.onClose();
    } catch (err) {
      setError(formatInvokeError(err));
      setSubmitting(false);
    }
  };

  useHotkeys(
    "mod+s, mod+enter",
    (e) => {
      e.preventDefault();
      void handleSubmit();
    },
    { enableOnFormTags: true, enableOnContentEditable: true },
    [name, hex, tagsInput, props, canSubmit],
  );

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void handleSubmit();
      }}
      className="flex flex-col gap-3"
    >
      <div className="flex items-start gap-3">
        {/* swatch (200×200 想定だが Modal 幅に合わせて 96px) */}
        <div
          className="h-24 w-24 shrink-0 rounded-[var(--radius)] border border-[var(--border)]"
          style={{ background: hex }}
          aria-label={`プレビュー (${hex})`}
        />
        <div className="flex flex-1 flex-col gap-2">
          <Field label="名前" htmlFor="color-name">
            <input
              id="color-name"
              type="text"
              autoFocus
              required
              maxLength={120}
              placeholder="Brand Primary"
              className="h-8 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-2.5 text-sm text-[var(--fg)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={submitting}
            />
          </Field>
        </div>
      </div>

      {/* 4 色空間入力 (2x2 グリッド)。各 ColorChannelInput は draft で部分入力中の表示を保持し、
          parse 成功時のみ canonical hex を更新する */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <ColorChannelInput
          id="color-hex"
          label="HEX"
          placeholder="#3B82F6"
          hex={hex}
          format={formatHexDisplay}
          parse={parseHexInput}
          onCommit={setHex}
          disabled={submitting}
        />
        <ColorChannelInput
          id="color-rgb"
          label="RGB"
          placeholder="59, 130, 246"
          hex={hex}
          format={formatRgbDisplay}
          parse={parseRgbInput}
          onCommit={setHex}
          disabled={submitting}
        />
        <ColorChannelInput
          id="color-hsl"
          label="HSL"
          placeholder="217, 91%, 60%"
          hex={hex}
          format={formatHslDisplay}
          parse={parseHslInput}
          onCommit={setHex}
          disabled={submitting}
        />
        <ColorChannelInput
          id="color-oklch"
          label="OKLCH"
          placeholder="0.620 0.190 256"
          hex={hex}
          format={formatOklchDisplay}
          parse={parseOklchInput}
          onCommit={setHex}
          disabled={submitting}
        />
      </div>

      <Field label="タグ (カンマ区切り、`#` は省略可)" htmlFor="color-tags">
        <input
          id="color-tags"
          type="text"
          maxLength={200}
          placeholder="brand, ui"
          className="h-8 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-2.5 text-sm text-[var(--fg)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none"
          value={tagsInput}
          onChange={(e) => setTagsInput(e.target.value)}
          disabled={submitting}
        />
      </Field>

      {error != null && (
        <p role="alert" className="text-[13px] text-[var(--destructive)]">
          {error}
        </p>
      )}

      <div className="mt-1 flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={props.onClose} disabled={submitting}>
          キャンセル <span className="ml-1 text-[10px] text-[var(--fg-subtle)]">Esc</span>
        </Button>
        <Button type="submit" variant="primary" disabled={!canSubmit}>
          {submitting ? "保存中..." : "保存"}
          <span className="ml-1 text-[10px] opacity-70">⌘S</span>
        </Button>
      </div>
    </form>
  );
}

interface ColorChannelInputProps {
  id: string;
  label: string;
  placeholder: string;
  /** canonical HEX (`#RRGGBB`、6 桁) */
  hex: string;
  /** HEX → 表示文字列 */
  format: (hex: string) => string;
  /** ユーザー入力 → HEX (parse 失敗は null) */
  parse: (input: string) => string | null;
  /** parse 成功時に canonical hex を更新 */
  onCommit: (hex: string) => void;
  disabled?: boolean;
}

/**
 * 1 色空間ぶんの input。
 *
 * - 通常時 (draft = null): canonical hex から `format` で導出した値を表示
 * - 編集中 (draft = string): ユーザーが入力した文字列を保持。parse 成功時のみ
 *   `onCommit` で canonical hex を更新する (失敗時は draft だけ更新、エラー表示)
 * - blur 時: draft を null に戻し、canonical 由来の表示に切替
 */
function ColorChannelInput({
  id,
  label,
  placeholder,
  hex,
  format,
  parse,
  onCommit,
  disabled,
}: ColorChannelInputProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const display = draft ?? format(hex);
  const isInvalidDraft = draft != null && parse(draft) == null;

  const handleChange = (val: string) => {
    setDraft(val);
    const parsed = parse(val);
    if (parsed != null) onCommit(parsed);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[12px] font-medium text-[var(--fg)]">
        {label}
      </label>
      <input
        id={id}
        type="text"
        placeholder={placeholder}
        className={cn(
          "h-7 rounded-[var(--radius)] border bg-[var(--bg)] px-2 font-mono text-[12px] text-[var(--fg)]",
          "focus-visible:ring-2 focus-visible:outline-none",
          isInvalidDraft
            ? "border-[var(--destructive)] focus-visible:ring-[var(--destructive)]"
            : "border-[var(--border)] focus-visible:ring-[var(--accent)]",
        )}
        value={display}
        onChange={(e) => handleChange(e.target.value)}
        onBlur={() => setDraft(null)}
        disabled={disabled}
      />
    </div>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-[13px] font-medium text-[var(--fg)]">
        {label}
      </label>
      {children}
    </div>
  );
}
