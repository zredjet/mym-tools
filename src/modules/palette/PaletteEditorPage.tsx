import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, GripVertical, Lock, Redo2, Save, Shuffle, Undo2, Unlock } from "lucide-react";
import { useHotkeys } from "react-hotkeys-hook";
import { useBlocker, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  type DragEndEvent,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { createItem, getItem, updateItem } from "@/ipc/items";
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
import type { HarmonyRule, PaletteColors, PaletteIndex, PalettePayloadV1 } from "@/lib/types";
import { modulePath } from "@/modules/registry";

import {
  commitHistory,
  createHistory,
  redoHistory,
  snapshotKey,
  undoHistory,
  type PaletteHistory,
  type PaletteSnapshot,
} from "./paletteHistory";
import {
  generateHarmony,
  HARMONY_LABELS,
  HARMONY_RULES,
  hexToHsv,
  hsvToHex,
  moveIndex,
  randomizePalette,
  reorderColors,
  updateHarmonyColor,
} from "./paletteMath";

const DEFAULT_SNAPSHOT: PaletteSnapshot = {
  colors: generateHarmony("#3B82F6", "analogous", 2),
  harmony: "analogous",
  baseIndex: 2,
  locked: [false, false, false, false, false],
};

type ColorMode = "hex" | "rgb" | "hsl" | "oklch";

/** itemId が変わる編集遷移では state を持ち越さず、新しい編集セッションとして初期化する。 */
export function PaletteEditorRoute() {
  const { itemId } = useParams<{ itemId?: string }>();
  const location = useLocation();
  return <PaletteEditorPage key={`${itemId ?? "new"}:${location.search}`} />;
}

export function PaletteEditorPage() {
  const { projectId, itemId } = useParams<{ projectId: string; itemId?: string }>();
  const navigate = useNavigate();
  const [history, setHistory] = useState<PaletteHistory>(() => createHistory(DEFAULT_SNAPSHOT));
  const [selectedIndex, setSelectedIndex] = useState<PaletteIndex>(2);
  const [name, setName] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [baseline, setBaseline] = useState(() => documentKey("", "", DEFAULT_SNAPSHOT));
  const [loading, setLoading] = useState(itemId != null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invalidColorInput, setInvalidColorInput] = useState(false);
  const [invalidStripInputs, setInvalidStripInputs] = useState<
    [boolean, boolean, boolean, boolean, boolean]
  >([false, false, false, false, false]);
  const [copiedIndex, setCopiedIndex] = useState<PaletteIndex | null>(null);
  const allowNavigation = useRef(false);
  const wheelStart = useRef<PaletteSnapshot | null>(null);
  const wheelColorIndex = useRef<PaletteIndex>(2);
  const present = history.present;

  useEffect(() => {
    if (itemId == null) return;
    let cancelled = false;
    void (async () => {
      try {
        const item = await getItem({ moduleId: "palette", itemId });
        const payload = item.payload as PalettePayloadV1;
        const snapshot: PaletteSnapshot = {
          colors: [...payload.colors] as PaletteColors,
          harmony: payload.harmony,
          baseIndex: payload.base_index,
          locked: [false, false, false, false, false],
        };
        if (!cancelled) {
          setHistory(createHistory(snapshot));
          setSelectedIndex(payload.base_index);
          setName(item.title);
          setTagsInput(item.tags.join(", "));
          setBaseline(documentKey(item.title, item.tags.join(", "), snapshot));
          setError(null);
          setInvalidStripInputs([false, false, false, false, false]);
        }
      } catch (cause) {
        if (!cancelled) setError(formatInvokeError(cause));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [itemId]);

  const currentKey = documentKey(name, tagsInput, present);
  const dirty = currentKey !== baseline;
  const hasInvalidColorInput = invalidColorInput || invalidStripInputs.some(Boolean);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    return (
      dirty &&
      !allowNavigation.current &&
      (currentLocation.pathname !== nextLocation.pathname ||
        currentLocation.search !== nextLocation.search)
    );
  });

  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const commit = useCallback((next: PaletteSnapshot) => {
    setHistory((current) => commitHistory(current, next));
  }, []);

  const applyColor = useCallback(
    (index: PaletteIndex, hex: string, preserveHarmony: boolean) => {
      const nextColors = preserveHarmony
        ? updateHarmonyColor(
            present.colors,
            index,
            hex,
            present.harmony,
            present.baseIndex,
            present.locked,
          )
        : updateHarmonyColor(present.colors, index, hex, "custom", index, present.locked);
      commit({
        ...present,
        colors: nextColors,
        harmony: preserveHarmony ? present.harmony : "custom",
        baseIndex: preserveHarmony ? present.baseIndex : index,
      });
    },
    [commit, present],
  );

  const chooseHarmony = (harmony: HarmonyRule) => {
    if (harmony === "custom") {
      commit({ ...present, harmony });
      return;
    }
    const generated = generateHarmony(present.colors[selectedIndex], harmony, selectedIndex);
    const colors = generated.map((color, index) =>
      present.locked[index] ? present.colors[index]! : color,
    ) as PaletteColors;
    commit({ ...present, colors, harmony, baseIndex: selectedIndex });
  };

  const toggleLock = (index: PaletteIndex) => {
    const locked = [...present.locked] as PaletteSnapshot["locked"];
    locked[index] = !locked[index];
    commit({ ...present, locked });
  };

  const handleRandom = () => {
    commit({
      ...present,
      colors: randomizePalette(present.colors, present.harmony, present.baseIndex, present.locked),
    });
  };

  const savePalette = useCallback(
    async (proceedAfterSave = false): Promise<boolean> => {
      if (projectId == null || submitting || hasInvalidColorInput || name.trim() === "")
        return false;
      setSubmitting(true);
      setError(null);
      const tags = parseTags(tagsInput);
      const payload: PalettePayloadV1 = {
        colors: present.colors.map((color) => color.toUpperCase()) as PaletteColors,
        harmony: present.harmony,
        base_index: present.baseIndex,
      };
      try {
        let createdId: string | null = null;
        if (itemId == null) {
          createdId = await createItem({
            moduleId: "palette",
            projectId,
            title: name.trim(),
            tags,
            payload,
          });
        } else {
          await updateItem({
            moduleId: "palette",
            itemId,
            title: name.trim(),
            tags,
            payload,
          });
        }
        const nextBaseline = documentKey(name.trim(), tags.join(", "), present);
        setName(name.trim());
        setTagsInput(tags.join(", "));
        setBaseline(nextBaseline);
        if (!proceedAfterSave && createdId != null) {
          allowNavigation.current = true;
          navigate(modulePath(projectId, "palette", `/edit/${createdId}`), { replace: true });
          queueMicrotask(() => {
            allowNavigation.current = false;
          });
        }
        return true;
      } catch (cause) {
        setError(formatInvokeError(cause));
        return false;
      } finally {
        setSubmitting(false);
      }
    },
    [hasInvalidColorInput, itemId, name, navigate, present, projectId, submitting, tagsInput],
  );

  const updateStripValidity = useCallback((index: PaletteIndex, invalid: boolean) => {
    setInvalidStripInputs((current) => {
      if (current[index] === invalid) return current;
      const next = [...current] as [boolean, boolean, boolean, boolean, boolean];
      next[index] = invalid;
      return next;
    });
  }, []);

  const selectColor = useCallback((index: PaletteIndex) => {
    setSelectedIndex(index);
    setInvalidColorInput(false);
  }, []);

  useHotkeys(
    "mod+s",
    (event) => {
      event.preventDefault();
      void savePalette();
    },
    { enableOnFormTags: true, enableOnContentEditable: true },
    [savePalette],
  );
  useHotkeys("mod+z", (event) => {
    if (isTextInput(event.target)) return;
    event.preventDefault();
    setHistory(undoHistory);
  });
  useHotkeys("mod+shift+z", (event) => {
    if (isTextInput(event.target)) return;
    event.preventDefault();
    setHistory(redoHistory);
  });
  useHotkeys("mod+n", (event) => {
    event.preventDefault();
    if (projectId != null) {
      navigate(`${modulePath(projectId, "palette")}?session=${Date.now()}`);
    }
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const handleDragEnd = (event: DragEndEvent) => {
    if (event.over == null) return;
    const from = Number(event.active.id) as PaletteIndex;
    const to = Number(event.over.id) as PaletteIndex;
    if (from === to) return;
    commit({
      colors: reorderColors(present.colors, from, to),
      harmony: "custom",
      baseIndex: moveIndex(present.baseIndex, from, to),
      locked: arrayMove(present.locked, from, to) as PaletteSnapshot["locked"],
    });
    setSelectedIndex((index) => moveIndex(index, from, to));
  };

  const copyColor = async (index: PaletteIndex) => {
    try {
      await navigator.clipboard.writeText(present.colors[index]);
      setCopiedIndex(index);
      window.setTimeout(() => setCopiedIndex(null), 1500);
      setError(null);
    } catch (cause) {
      setError(formatInvokeError(cause));
    }
  };

  const beginWheel = (index: PaletteIndex) => {
    wheelStart.current = history.present;
    wheelColorIndex.current = index;
  };
  const previewWheel = (hex: string) => {
    setHistory((current) => ({
      ...current,
      present: {
        ...current.present,
        colors: updateHarmonyColor(
          current.present.colors,
          wheelColorIndex.current,
          hex,
          current.present.harmony,
          current.present.baseIndex,
          current.present.locked,
        ),
      },
    }));
  };
  const finishWheel = () => {
    const start = wheelStart.current;
    wheelStart.current = null;
    if (start == null) return;
    setHistory((current) => {
      if (snapshotKey(start) === snapshotKey(current.present)) return current;
      return {
        past: [...current.past.slice(-99), start],
        present: current.present,
        future: [],
      };
    });
  };

  if (projectId == null) {
    return (
      <div className="p-6 text-sm text-[var(--fg-muted)]">プロジェクトが選択されていません。</div>
    );
  }
  if (loading) {
    return <div className="p-6 text-sm text-[var(--fg-subtle)]">パレットを読み込んでいます...</div>;
  }

  return (
    <div className="flex h-full min-h-[520px] flex-col overflow-hidden bg-[var(--bg)]">
      <PaletteNav projectId={projectId} active="create" />
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center justify-between border-b border-[var(--border)] px-4">
          <div>
            <h1 className="text-sm font-semibold text-[var(--fg)]">
              {itemId == null ? "パレットを作成" : "パレットを編集"}
            </h1>
            <p className="text-[11px] text-[var(--fg-subtle)]">
              5 colors · {HARMONY_LABELS[present.harmony]}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <ToolbarButton
              label="元に戻す"
              disabled={history.past.length === 0}
              onClick={() => setHistory(undoHistory)}
            >
              <Undo2 size={14} />
            </ToolbarButton>
            <ToolbarButton
              label="やり直す"
              disabled={history.future.length === 0}
              onClick={() => setHistory(redoHistory)}
            >
              <Redo2 size={14} />
            </ToolbarButton>
            <ToolbarButton
              label="ランダム生成"
              disabled={present.locked.every(Boolean)}
              onClick={handleRandom}
            >
              <Shuffle size={14} />
              Random
            </ToolbarButton>
          </div>
        </div>

        {error != null && (
          <div
            role="alert"
            className="shrink-0 border-b border-[var(--destructive)] bg-[var(--destructive)]/10 px-4 py-1.5 text-[12px] text-[var(--destructive)]"
          >
            {error}
          </div>
        )}

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(250px,34%)_minmax(0,1fr)]">
          <section
            className="min-h-0 overflow-y-auto border-r border-[var(--border)] px-4 py-3"
            aria-label="配色コントロール"
          >
            <ColorWheel
              colors={present.colors}
              selectedIndex={selectedIndex}
              locked={present.locked}
              onSelect={selectColor}
              onStart={beginWheel}
              onPreview={previewWheel}
              onFinish={finishWheel}
              onKeyboardChange={(index, hex) => applyColor(index, hex, true)}
            />
            <fieldset className="mt-4">
              <legend className="mb-2 text-[11px] font-semibold tracking-wide text-[var(--fg-subtle)] uppercase">
                Color harmony
              </legend>
              <div
                className="grid grid-cols-2 gap-1.5"
                role="radiogroup"
                aria-label="カラーハーモニー"
              >
                {HARMONY_RULES.map((rule) => (
                  <button
                    key={rule}
                    type="button"
                    role="radio"
                    aria-checked={present.harmony === rule}
                    onClick={() => chooseHarmony(rule)}
                    className={cn(
                      "min-h-7 rounded-[var(--radius)] border px-2 py-1 text-left text-[11px] transition-colors",
                      present.harmony === rule
                        ? "border-[var(--accent)] bg-[var(--bg-accent-soft)] text-[var(--accent)]"
                        : "border-[var(--border)] text-[var(--fg-muted)] hover:bg-[var(--bg-muted)]",
                    )}
                  >
                    {HARMONY_LABELS[rule]}
                  </button>
                ))}
              </div>
            </fieldset>
            <SelectedColorEditor
              key={selectedIndex}
              hex={present.colors[selectedIndex]}
              disabled={present.locked[selectedIndex]}
              onDirectCommit={(hex) => applyColor(selectedIndex, hex, false)}
              onHarmonyCommit={(hex) => applyColor(selectedIndex, hex, true)}
              onInvalidChange={setInvalidColorInput}
            />
          </section>

          <section className="min-w-0 bg-[var(--bg-muted)]/40 p-3" aria-label="カラーパレット">
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext items={[0, 1, 2, 3, 4]} strategy={horizontalListSortingStrategy}>
                <div className="grid h-full min-h-[280px] grid-cols-5 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg)] shadow-sm">
                  {present.colors.map((hex, index) => (
                    <PaletteStrip
                      key={index}
                      index={index as PaletteIndex}
                      hex={hex}
                      selected={selectedIndex === index}
                      locked={present.locked[index]!}
                      copied={copiedIndex === index}
                      onSelect={() => selectColor(index as PaletteIndex)}
                      onToggleLock={() => toggleLock(index as PaletteIndex)}
                      onCopy={() => void copyColor(index as PaletteIndex)}
                      onHexCommit={(next) => applyColor(index as PaletteIndex, next, false)}
                      onInvalidChange={updateStripValidity}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          </section>
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void savePalette();
          }}
          className="grid shrink-0 grid-cols-[minmax(180px,1fr)_minmax(160px,0.7fr)_auto] items-end gap-3 border-t border-[var(--border)] bg-[var(--bg)] px-4 py-3"
        >
          <LabeledInput
            label="パレット名"
            value={name}
            onChange={setName}
            placeholder="My Color Theme"
            required
          />
          <LabeledInput
            label="タグ"
            value={tagsInput}
            onChange={setTagsInput}
            placeholder="brand, ui"
          />
          <Button
            type="submit"
            variant="primary"
            disabled={submitting || hasInvalidColorInput || name.trim() === ""}
          >
            <Save size={14} aria-hidden /> {submitting ? "保存中..." : "保存"}
            <span className="text-[10px] opacity-70">⌘S</span>
          </Button>
        </form>
      </div>

      <Modal
        open={blocker.state === "blocked"}
        onClose={() => blocker.reset?.()}
        title="未保存の変更があります"
      >
        <p className="text-[13px] text-[var(--fg-muted)]">
          移動する前に、現在のパレットを保存しますか?
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => blocker.reset?.()}>
            キャンセル
          </Button>
          <Button variant="secondary" onClick={() => blocker.proceed?.()}>
            破棄して移動
          </Button>
          <Button
            variant="primary"
            disabled={name.trim() === "" || hasInvalidColorInput || submitting}
            onClick={() => {
              void savePalette(true).then((saved) => {
                if (saved) blocker.proceed?.();
              });
            }}
          >
            保存して移動
          </Button>
        </div>
      </Modal>
    </div>
  );
}

function PaletteNav({ projectId, active }: { projectId: string; active: "create" | "saved" }) {
  const navigate = useNavigate();
  return (
    <nav
      className="flex h-10 shrink-0 items-end gap-5 border-b border-[var(--border)] px-4"
      aria-label="パレット"
    >
      <NavButton
        active={active === "create"}
        onClick={() => navigate(modulePath(projectId, "palette"))}
      >
        作成
      </NavButton>
      <NavButton
        active={active === "saved"}
        onClick={() => navigate(modulePath(projectId, "palette", "/saved"))}
      >
        保存済み
      </NavButton>
    </nav>
  );
}

export { PaletteNav };

function NavButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={cn(
        "h-10 border-b-2 px-1 text-[13px] font-medium",
        active
          ? "border-[var(--accent)] text-[var(--accent)]"
          : "border-transparent text-[var(--fg-muted)] hover:text-[var(--fg)]",
      )}
    >
      {children}
    </button>
  );
}

function ToolbarButton({
  label,
  children,
  ...props
}: { label: string; children: React.ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="inline-flex h-7 items-center gap-1.5 rounded-[var(--radius)] px-2 text-[12px] text-[var(--fg-muted)] hover:bg-[var(--bg-muted)] hover:text-[var(--fg)] disabled:opacity-40"
      {...props}
    >
      {children}
    </button>
  );
}

function ColorWheel({
  colors,
  selectedIndex,
  locked,
  onSelect,
  onStart,
  onPreview,
  onFinish,
  onKeyboardChange,
}: {
  colors: PaletteColors;
  selectedIndex: PaletteIndex;
  locked: readonly boolean[];
  onSelect: (index: PaletteIndex) => void;
  onStart: (index: PaletteIndex) => void;
  onPreview: (hex: string) => void;
  onFinish: () => void;
  onKeyboardChange: (index: PaletteIndex, hex: string) => void;
}) {
  const wheelRef = useRef<HTMLDivElement>(null);
  const draggingIndex = useRef<PaletteIndex | null>(null);
  const updateFromPointer = (clientX: number, clientY: number) => {
    const index = draggingIndex.current;
    const wheel = wheelRef.current;
    if (index == null || wheel == null || locked[index]) return;
    const rect = wheel.getBoundingClientRect();
    const radius = Math.min(rect.width, rect.height) / 2;
    const dx = clientX - (rect.left + rect.width / 2);
    const dy = clientY - (rect.top + rect.height / 2);
    const current = hexToHsv(colors[index]);
    const h = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
    const s = Math.min(1, Math.hypot(dx, dy) / radius);
    onPreview(hsvToHex({ h, s, v: current.v }));
  };
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-semibold tracking-wide text-[var(--fg-subtle)] uppercase">
          Color wheel
        </span>
        <span className="font-mono text-[11px] text-[var(--fg-muted)]">
          {colors[selectedIndex]}
        </span>
      </div>
      <div
        ref={wheelRef}
        className="relative mx-auto aspect-square w-full max-w-[220px] touch-none rounded-full ring-1 ring-[var(--border)]"
        style={{
          background:
            "radial-gradient(circle, white 0%, transparent 78%), conic-gradient(from -90deg, #ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000)",
        }}
        onPointerDown={(event) => {
          if (locked[selectedIndex]) return;
          draggingIndex.current = selectedIndex;
          event.currentTarget.setPointerCapture(event.pointerId);
          onStart(selectedIndex);
          updateFromPointer(event.clientX, event.clientY);
        }}
        onPointerMove={(event) => updateFromPointer(event.clientX, event.clientY)}
        onPointerUp={(event) => {
          if (draggingIndex.current == null) return;
          draggingIndex.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          onFinish();
        }}
        onPointerCancel={() => {
          draggingIndex.current = null;
          onFinish();
        }}
      >
        {colors.map((hex, index) => {
          const hsv = hexToHsv(hex);
          const angle = ((hsv.h - 90) * Math.PI) / 180;
          const distance = hsv.s * 43;
          const left = 50 + Math.cos(angle) * distance;
          const top = 50 + Math.sin(angle) * distance;
          return (
            <button
              key={index}
              type="button"
              aria-label={`色 ${index + 1}: ${hex}${locked[index] ? " ロック済み" : ""}`}
              onPointerDown={(event) => {
                event.stopPropagation();
                const paletteIndex = index as PaletteIndex;
                onSelect(paletteIndex);
                if (locked[index]) return;
                draggingIndex.current = paletteIndex;
                wheelRef.current?.setPointerCapture(event.pointerId);
                onStart(paletteIndex);
                updateFromPointer(event.clientX, event.clientY);
              }}
              onClick={(event) => {
                event.stopPropagation();
                onSelect(index as PaletteIndex);
              }}
              onKeyDown={(event) => {
                if (locked[index]) return;
                const step = event.shiftKey ? 10 : 1;
                const next = { ...hsv };
                if (event.key === "ArrowLeft") next.h -= step;
                else if (event.key === "ArrowRight") next.h += step;
                else if (event.key === "ArrowUp") next.s = Math.min(1, next.s + step / 100);
                else if (event.key === "ArrowDown") next.s = Math.max(0, next.s - step / 100);
                else return;
                event.preventDefault();
                onSelect(index as PaletteIndex);
                onKeyboardChange(index as PaletteIndex, hsvToHex(next));
              }}
              className={cn(
                "absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow ring-1 ring-black/40",
                selectedIndex === index && "h-5 w-5 ring-2 ring-[var(--accent)]",
              )}
              style={{ left: `${left}%`, top: `${top}%`, backgroundColor: hex }}
            />
          );
        })}
      </div>
    </div>
  );
}

function SelectedColorEditor({
  hex,
  disabled,
  onDirectCommit,
  onHarmonyCommit,
  onInvalidChange,
}: {
  hex: string;
  disabled: boolean;
  onDirectCommit: (hex: string) => void;
  onHarmonyCommit: (hex: string) => void;
  onInvalidChange: (invalid: boolean) => void;
}) {
  const [mode, setMode] = useState<ColorMode>("hex");
  const [draft, setDraft] = useState<string | null>(null);
  const parser = {
    hex: parseHexInput,
    rgb: parseRgbInput,
    hsl: parseHslInput,
    oklch: parseOklchInput,
  }[mode];
  const formatter = {
    hex: formatHexDisplay,
    rgb: formatRgbDisplay,
    hsl: formatHslDisplay,
    oklch: formatOklchDisplay,
  }[mode];
  const hsv = hexToHsv(hex);
  return (
    <div className="mt-4 border-t border-[var(--border)] pt-3">
      <label className="mb-1 block text-[11px] font-semibold tracking-wide text-[var(--fg-subtle)] uppercase">
        Selected color
      </label>
      <div className="flex gap-2">
        <select
          value={mode}
          onChange={(event) => {
            setMode(event.target.value as ColorMode);
            setDraft(null);
            onInvalidChange(false);
          }}
          disabled={disabled}
          aria-label="色空間"
          className="h-8 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-2 text-[12px] text-[var(--fg)]"
        >
          <option value="hex">HEX</option>
          <option value="rgb">RGB</option>
          <option value="hsl">HSL</option>
          <option value="oklch">OKLCH</option>
        </select>
        <input
          value={draft ?? formatter(hex)}
          onChange={(event) => {
            const value = event.target.value;
            setDraft(value);
            const parsed = parser(value);
            onInvalidChange(parsed == null);
            if (parsed != null) onDirectCommit(parsed);
          }}
          onBlur={() => {
            setDraft(null);
            onInvalidChange(false);
          }}
          disabled={disabled}
          aria-label={`${mode.toUpperCase()} 値`}
          className="h-8 min-w-0 flex-1 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-2 font-mono text-[12px] text-[var(--fg)]"
        />
      </div>
      <label className="mt-2 flex items-center gap-2 text-[11px] text-[var(--fg-muted)]">
        明るさ
        <input
          type="range"
          min="0"
          max="100"
          value={Math.round(hsv.v * 100)}
          onChange={(event) =>
            onHarmonyCommit(hsvToHex({ ...hsv, v: Number(event.target.value) / 100 }))
          }
          disabled={disabled}
          className="min-w-0 flex-1 accent-[var(--accent)]"
        />
        <span className="w-8 text-right font-mono">{Math.round(hsv.v * 100)}</span>
      </label>
      {disabled && (
        <p className="mt-1 text-[11px] text-[var(--fg-subtle)]">ロックを解除すると編集できます。</p>
      )}
    </div>
  );
}

function PaletteStrip({
  index,
  hex,
  selected,
  locked,
  copied,
  onSelect,
  onToggleLock,
  onCopy,
  onHexCommit,
  onInvalidChange,
}: {
  index: PaletteIndex;
  hex: string;
  selected: boolean;
  locked: boolean;
  copied: boolean;
  onSelect: () => void;
  onToggleLock: () => void;
  onCopy: () => void;
  onHexCommit: (hex: string) => void;
  onInvalidChange: (index: PaletteIndex, invalid: boolean) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: index,
  });
  const [inputState, setInputState] = useState({ source: hex, draft: hex });
  const draft = inputState.source === hex ? inputState.draft : hex;
  const foreground = readableForeground(hex);
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        backgroundColor: hex,
        color: foreground,
      }}
      className={cn(
        "group relative flex min-w-0 flex-col justify-between border-r border-black/10 px-2 py-2 last:border-r-0",
        selected && "z-10 ring-2 ring-[var(--accent)] ring-inset",
        isDragging && "z-20 opacity-80 shadow-xl",
      )}
    >
      <div className="flex items-center justify-between gap-1 opacity-80 transition-opacity group-hover:opacity-100">
        <button
          type="button"
          aria-label={`色 ${index + 1} を${locked ? "ロック解除" : "ロック"}`}
          onClick={onToggleLock}
          className="inline-flex h-6 w-6 items-center justify-center rounded bg-black/15 hover:bg-black/25"
        >
          {locked ? <Lock size={13} /> : <Unlock size={13} />}
        </button>
        <button
          type="button"
          aria-label={`色 ${index + 1} を並び替え`}
          {...attributes}
          {...listeners}
          className="inline-flex h-6 w-6 cursor-grab items-center justify-center rounded bg-black/15 hover:bg-black/25"
        >
          <GripVertical size={13} />
        </button>
      </div>
      <button
        type="button"
        onClick={onSelect}
        aria-label={`色 ${index + 1} を選択`}
        className="flex-1"
      />
      <div className="flex flex-col gap-1">
        <input
          value={draft}
          onFocus={onSelect}
          onChange={(event) => {
            const value = event.target.value;
            const parsed = parseHexInput(value);
            setInputState({ source: parsed ?? hex, draft: value });
            onInvalidChange(index, parsed == null);
            if (parsed != null) onHexCommit(parsed);
          }}
          onBlur={() => {
            setInputState({ source: hex, draft: hex });
            onInvalidChange(index, false);
          }}
          disabled={locked}
          aria-label={`色 ${index + 1} のHEX`}
          className="h-7 w-full min-w-0 rounded bg-black/15 px-1 text-center font-mono text-[11px] outline-none focus:bg-black/25 disabled:opacity-60"
        />
        <button
          type="button"
          onClick={onCopy}
          className="inline-flex h-7 items-center justify-center gap-1 rounded bg-black/15 text-[10px] hover:bg-black/25"
          aria-label={`${hex} をコピー`}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? "コピー済" : "Copy"}
        </button>
      </div>
    </div>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
  placeholder,
  required,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  required?: boolean;
}) {
  return (
    <label className="min-w-0 text-[11px] font-medium text-[var(--fg-muted)]">
      {label}
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        required={required}
        maxLength={required ? 120 : 200}
        className="mt-1 h-8 w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-2.5 text-[13px] text-[var(--fg)]"
      />
    </label>
  );
}

function documentKey(name: string, tags: string, snapshot: PaletteSnapshot): string {
  return JSON.stringify({
    name: name.trim(),
    tags: parseTags(tags),
    colors: snapshot.colors,
    harmony: snapshot.harmony,
    baseIndex: snapshot.baseIndex,
  });
}

function parseTags(value: string): string[] {
  return value
    .split(",")
    .map((tag) => tag.trim().replace(/^#/, ""))
    .filter(Boolean);
}

function readableForeground(hex: string): "#000000" | "#FFFFFF" {
  const value = Number.parseInt(hex.slice(1), 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return r * 0.299 + g * 0.587 + b * 0.114 > 155 ? "#000000" : "#FFFFFF";
}

function isTextInput(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}
