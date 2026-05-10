/**
 * Color 新規作成 / 編集ダイアログ (`docs/ui-design.md` §6.5 K-2)。
 *
 * `mode` で create / edit を切替。**HEX/RGB/HSL/OKLCH の 4 色空間を同時表示** し、
 * いずれかを編集すると他の 3 つも自動同期する (canonical = HEX、6 桁または 8 桁)。
 *
 * - 保存値は大文字正規化 (`docs/data-model.md` §10.3)
 * - **alpha (`#RRGGBBAA`) は保存時に drop しない** (PR #43 codex P1):
 *   既存 8 桁データを開いて name / tags だけ編集 → 保存しても元の alpha を維持。
 *   ユーザーが色 input を触ると 6 桁化 (RGB / HSL / OKLCH 入力からは alpha 復元不能)
 *
 * ## 双方向バインドの設計
 *
 * - canonical state: `hex: string` (`#RRGGBB` または `#RRGGBBAA`、常に妥当な値)
 * - 各色空間 input は **`ColorChannelInput`** で個別に管理:
 *   - 通常時は canonical hex から `format` で表示文字列を導出
 *   - ユーザーが入力中は内部 draft で表示 (まだパース不能でも入力を保持)
 *   - 入力が valid (parse 成功) なら canonical hex を更新 → 他 input も追従
 *   - blur 時は draft をクリア → canonical 由来の表示に戻る
 *   - **invalid draft 中は親に通知** (PR #43 codex P2): 任意の channel が
 *     invalid 状態だと **保存ボタン / Cmd+S を disable** する (canonical hex は
 *     妥当でも、ユーザーが見ている入力と保存値が乖離するのを防ぐ)
 * - これにより `useEffect` の setState 連鎖なしで「3 つを表示・1 つを編集」を実現
 *
 * ## ショートカット
 * - `Cmd/Ctrl + S` / `Cmd/Ctrl + Enter`: 保存 (invalid channel 中は no-op)
 */
import { useCallback, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";

import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { createItem, updateItem } from "@/ipc/items";
import {
  formatHexDisplay,
  formatHslDisplay,
  formatOklchDisplay,
  formatRgbDisplay,
  isValidStorableHex,
  parseHexInput,
  parseHslInput,
  parseOklchInput,
  parseRgbInput,
} from "@/lib/color";
import { cn } from "@/lib/cn";
import { formatInvokeError } from "@/lib/error";
import type { ColorPayloadV1, Item } from "@/lib/types";

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
  // canonical: 既存 hex は **alpha 保持で開く** (PR #43 codex P1)。妥当でない値や
  // create 時は blue-600 (#3B82F6) で初期化
  const initialHex =
    initial?.hex != null && isValidStorableHex(initial.hex) ? initial.hex.toUpperCase() : "#3B82F6";
  const [name, setName] = useState(props.mode === "edit" ? props.item.title : "");
  const [hex, setHex] = useState(initialHex);
  const [tagsInput, setTagsInput] = useState(
    props.mode === "edit" ? props.item.tags.join(", ") : "",
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // PR #43 codex P2: 各 channel input が invalid draft を持っていれば true。
  // canSubmit / hotkey 保存実行時にチェック (invalid 中は保存できない)
  const [invalidChannels, setInvalidChannels] = useState<Record<string, boolean>>({});

  const handleInvalidChange = useCallback((id: string, invalid: boolean) => {
    setInvalidChannels((prev) => {
      if (Boolean(prev[id]) === invalid) return prev; // 変化なし → re-render 抑止
      return { ...prev, [id]: invalid };
    });
  }, []);

  const anyChannelInvalid = Object.values(invalidChannels).some(Boolean);
  const canSubmit =
    !submitting && name.trim().length > 0 && isValidStorableHex(hex) && !anyChannelInvalid;

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
          onInvalidChange={(v) => handleInvalidChange("hex", v)}
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
          onInvalidChange={(v) => handleInvalidChange("rgb", v)}
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
          onInvalidChange={(v) => handleInvalidChange("hsl", v)}
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
          onInvalidChange={(v) => handleInvalidChange("oklch", v)}
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
  /** canonical HEX (`#RRGGBB` または `#RRGGBBAA`) */
  hex: string;
  /** HEX → 表示文字列 */
  format: (hex: string) => string;
  /** ユーザー入力 → HEX (parse 失敗は null) */
  parse: (input: string) => string | null;
  /** parse 成功時に canonical hex を更新 */
  onCommit: (hex: string) => void;
  /** PR #43 codex P2: 親に invalid 状態を通知 (canSubmit / Cmd+S 抑止に使う) */
  onInvalidChange: (invalid: boolean) => void;
  disabled?: boolean;
}

/**
 * 1 色空間ぶんの input。
 *
 * - 通常時 (draft = null): canonical hex から `format` で導出した値を表示
 * - 編集中 (draft = string): ユーザーが入力した文字列を保持。parse 成功時のみ
 *   `onCommit` で canonical hex を更新する (失敗時は draft だけ更新、エラー表示)
 * - 各操作の直後に **`onInvalidChange`** で親に invalid 状態を通知 → 親側で
 *   保存ボタン / hotkey を抑止 (PR #43 codex P2)
 * - blur 時: draft を null に戻し、canonical 由来の表示に切替 (= valid)
 */
function ColorChannelInput({
  id,
  label,
  placeholder,
  hex,
  format,
  parse,
  onCommit,
  onInvalidChange,
  disabled,
}: ColorChannelInputProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const display = draft ?? format(hex);
  const isInvalidDraft = draft != null && parse(draft) == null;

  const handleChange = (val: string) => {
    setDraft(val);
    const parsed = parse(val);
    if (parsed != null) {
      onCommit(parsed);
      onInvalidChange(false);
    } else {
      onInvalidChange(true);
    }
  };

  const handleBlur = () => {
    setDraft(null);
    onInvalidChange(false); // canonical 由来の表示に戻る = valid
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
        onBlur={handleBlur}
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
