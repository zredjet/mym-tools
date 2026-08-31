/**
 * サイドバー (`docs/ui-design.md` §3.2)。
 *
 * - PROJECTS セクション (一覧 + `+` ボタンで C-4 ダイアログ)
 * - MODULES セクション (registry のうち設定で有効なモジュール)
 * - 末尾に `🌗` テーマトグル
 *
 * 行高 32px / padding 6px 12px / 選択行は `--bg-accent-soft` + `--accent` テキスト + 左 2px。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, GripVertical, Pencil, Plus, Trash2 } from "lucide-react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import { ProjectCreateDialog } from "@/components/projects/ProjectCreateDialog";
import { ProjectEditDialog } from "@/components/projects/ProjectEditDialog";
import { ConfirmDeleteDialog } from "@/components/ui/ConfirmDeleteDialog";
import { ThemeToggle } from "@/components/shell/ThemeToggle";
import { deleteProject, reorderProjects } from "@/ipc/projects";
import { cn } from "@/lib/cn";
import { formatInvokeError } from "@/lib/error";
import type { ModuleId, Project } from "@/lib/types";
import {
  enabledModules,
  getModuleDefinition,
  groupedModules,
  moduleCategoryId,
  modulePath,
} from "@/modules/registry";
import { useAppStore } from "@/store/useAppStore";

interface SidebarProps {
  projects: Project[];
  /** 新規作成成功時に呼び出される (親が再取得する) */
  onProjectCreated: (project: Project) => void;
  /** 編集 / 削除成功時に呼び出される (親が再取得する) */
  onProjectChanged: () => void;
}

export function Sidebar({ projects, onProjectCreated, onProjectChanged }: SidebarProps) {
  const [createOpen, setCreateOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [deletingProject, setDeletingProject] = useState<Project | null>(null);
  const [reorderError, setReorderError] = useState<string | null>(null);
  const { projectId, moduleId } = useParams<{ projectId?: string; moduleId?: string }>();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const sidebarWidth = useAppStore((s) => s.sidebarWidth);
  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth);
  const setLastModule = useAppStore((s) => s.setLastOpenedModuleId);
  const setLastProject = useAppStore((s) => s.setLastOpenedProjectId);
  const lastOpenedProjectId = useAppStore((s) => s.lastOpenedProjectId);
  const lastOpenedModuleId = useAppStore((s) => s.lastOpenedModuleId);
  const moduleEnabled = useAppStore((s) => s.moduleEnabled);
  const collapsedCategories = useAppStore((s) => s.collapsedModuleCategories);
  const setCategoryCollapsed = useAppStore((s) => s.setModuleCategoryCollapsed);
  const visibleModules = enabledModules(moduleEnabled);
  const moduleGroups = groupedModules(visibleModules);

  // D&D sensors: PointerSensor は 4px 動かしてから drag 開始 (誤発動防止、クリック連動)
  // KeyboardSensor は a11y 用 (Tab + Space で持ち上げ → Arrow で移動)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      if (over == null || active.id === over.id) return;
      const oldIndex = projects.findIndex((p) => p.id === active.id);
      const newIndex = projects.findIndex((p) => p.id === over.id);
      if (oldIndex < 0 || newIndex < 0) return;
      const reordered = arrayMove(projects, oldIndex, newIndex);
      try {
        await reorderProjects(reordered.map((p) => p.id));
        onProjectChanged();
        setReorderError(null);
      } catch (e) {
        setReorderError(formatInvokeError(e));
      }
    },
    [projects, onProjectChanged],
  );

  // Settings / About 表示中も直近プロジェクトを選択表示する。
  const effectiveProjectId =
    projectId ??
    (lastOpenedProjectId != null && projects.some((p) => p.id === lastOpenedProjectId)
      ? lastOpenedProjectId
      : null);

  const handleConfirmDelete = useCallback(async () => {
    if (deletingProject == null) return;
    await deleteProject(deletingProject.id);
    onProjectChanged();
    // PR #41 codex P2 対応: navigate("/welcome") は **URL の active project 削除時のみ**。
    // lastOpenedProjectId 一致は store のクリアだけ行い navigate しない。
    // (例: project A を表示中に sidebar から persist 由来 lastOpened=B を削除しても、
    //  ユーザーが actively 見ている A から強制退去しない)
    if (lastOpenedProjectId === deletingProject.id) {
      setLastProject(null);
    }
    if (projectId === deletingProject.id) {
      navigate("/welcome");
    }
  }, [deletingProject, onProjectChanged, projectId, lastOpenedProjectId, navigate, setLastProject]);

  const routeModuleId = deriveModuleIdFromPath(pathname);
  const activeModuleId: ModuleId | null =
    routeModuleId ??
    (effectiveProjectId != null &&
    lastOpenedModuleId != null &&
    visibleModules.some((module) => module.id === lastOpenedModuleId)
      ? lastOpenedModuleId
      : null);

  useEffect(() => {
    if (moduleId == null) return;
    const active = getModuleDefinition(moduleId);
    if (active == null) return;
    const category = moduleCategoryId(active);
    if (collapsedCategories.includes(category)) setCategoryCollapsed(category, false);
  }, [collapsedCategories, moduleId, setCategoryCollapsed]);

  const goToProject = (pid: string) => {
    const current = moduleId != null ? getModuleDefinition(moduleId) : undefined;
    const previous =
      lastOpenedModuleId != null ? getModuleDefinition(lastOpenedModuleId) : undefined;
    const target =
      (current != null && visibleModules.some((candidate) => candidate.id === current.id)
        ? current
        : undefined) ??
      (previous != null && visibleModules.some((candidate) => candidate.id === previous.id)
        ? previous
        : undefined) ??
      visibleModules[0];
    if (target == null) {
      navigate("/settings");
      return;
    }
    setLastProject(pid);
    setLastModule(target.id);
    navigate(modulePath(pid, target.id, target.defaultRoute));
  };

  const goToModule = (mid: ModuleId) => {
    if (effectiveProjectId == null) return;
    const definition = getModuleDefinition(mid);
    if (definition == null) return;
    setLastModule(mid);
    navigate(modulePath(effectiveProjectId, mid, definition.defaultRoute));
  };

  return (
    <aside
      className="relative flex h-full shrink-0 flex-col border-r border-[var(--border)] bg-[var(--bg-sidebar)] text-[13px] text-[var(--fg)]"
      style={{ width: sidebarWidth }}
      aria-label="サイドバー"
    >
      <SidebarResizeHandle width={sidebarWidth} onResize={setSidebarWidth} />
      {/* PROJECTS section */}
      <SectionHeader
        title="PROJECTS"
        action={
          <button
            type="button"
            aria-label="新規プロジェクト"
            title="新規プロジェクト"
            className="inline-flex h-5 w-5 items-center justify-center rounded text-[var(--fg-muted)] hover:bg-[var(--bg-muted)] hover:text-[var(--fg)]"
            onClick={() => setCreateOpen(true)}
          >
            <Plus size={14} aria-hidden />
          </button>
        }
      />
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={projects.map((p) => p.id)} strategy={verticalListSortingStrategy}>
          <ul className="flex flex-col px-1.5 pb-2" role="list">
            {projects.length === 0 && (
              <li className="px-3 py-1.5 text-[12px] text-[var(--fg-subtle)]">プロジェクトなし</li>
            )}
            {projects.map((p) => (
              <li key={p.id}>
                <SortableProjectRow
                  project={p}
                  selected={effectiveProjectId === p.id}
                  onSelect={() => goToProject(p.id)}
                  onEdit={() => setEditingProject(p)}
                  onDelete={() => setDeletingProject(p)}
                />
              </li>
            ))}
          </ul>
        </SortableContext>
      </DndContext>
      {reorderError != null && (
        <p
          role="alert"
          className="mx-3 mb-2 rounded-[var(--radius)] border border-[var(--destructive)] bg-[var(--destructive)]/10 p-1.5 text-[11px] text-[var(--destructive)]"
        >
          並び替え失敗: {reorderError}
        </p>
      )}

      {/* MODULES section */}
      <SectionHeader title="MODULES" action={<ThemeToggle />} />
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {moduleGroups.map(({ category, modules: categoryModules }) => {
          const collapsed = collapsedCategories.includes(category.id);
          return (
            <section key={category.id} aria-labelledby={`module-category-${category.id}`}>
              <button
                id={`module-category-${category.id}`}
                type="button"
                className="flex h-7 w-full items-center gap-1 px-2 text-left text-[10px] font-semibold tracking-wide text-[var(--fg-subtle)] uppercase hover:text-[var(--fg)]"
                aria-expanded={!collapsed}
                onClick={() => setCategoryCollapsed(category.id, !collapsed)}
              >
                <ChevronRight
                  size={12}
                  aria-hidden
                  className={cn("transition-transform", !collapsed && "rotate-90")}
                />
                {category.displayName}
              </button>
              {!collapsed && (
                <ul className="flex flex-col" role="list">
                  {categoryModules.map((m) => {
                    const Icon = m.icon;
                    const disabled = effectiveProjectId == null;
                    return (
                      <li key={m.id}>
                        <SidebarRow
                          label={m.displayName}
                          icon={<Icon className="h-3.5 w-3.5" />}
                          selected={activeModuleId === m.id}
                          disabled={disabled}
                          onClick={() => !disabled && goToModule(m.id)}
                        />
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })}
      </div>

      <ProjectCreateDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={onProjectCreated}
      />
      {editingProject != null && (
        <ProjectEditDialog
          open={editingProject != null}
          project={editingProject}
          onClose={() => setEditingProject(null)}
          onSaved={onProjectChanged}
        />
      )}
      <ConfirmDeleteDialog
        open={deletingProject != null}
        entityLabel="プロジェクト"
        name={deletingProject?.name ?? ""}
        description={
          <>
            <strong>このプロジェクト配下のすべてのアイテム</strong>
            がモジュール種別を問わず連鎖削除されます。バックアップから戻すことは可能ですが、
            現在の状態へは戻れません。
          </>
        }
        onClose={() => setDeletingProject(null)}
        onConfirm={handleConfirmDelete}
      />
    </aside>
  );
}

/** 固定リテラルで登録されたモジュールルートから、現在のモジュール ID を取得する。 */
function deriveModuleIdFromPath(pathname: string): ModuleId | null {
  const match = pathname.match(/^\/projects\/[^/]+\/m\/([^/]+)/);
  const candidate = match?.[1];
  return candidate != null && getModuleDefinition(candidate) != null
    ? (candidate as ModuleId)
    : null;
}

/**
 * サイドバー右端の resize 用 separator (`docs/ui-design.md` §2.3 / U-10)。
 *
 * - PointerDown → setPointerCapture でドラッグ追従、PointerUp で release
 * - 値は store の `setSidebarWidth` で 180-320 にクランプ済 (`useAppStore`)
 * - ARIA: `role="separator"` + `aria-orientation="vertical"`、`aria-valuenow/min/max`
 *   をスクリーンリーダーに伝える
 * - キーボード: `←` / `→` で 8px ずつ、`Shift` 併用で 32px ずつ調整 (a11y 配慮)
 */
function SidebarResizeHandle({
  width,
  onResize,
}: {
  width: number;
  onResize: (next: number) => void;
}) {
  const startX = useRef<number | null>(null);
  const startWidth = useRef<number>(width);

  const handlePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    // 主ボタン以外 (右クリック等) は無視。複数ポインタ環境での誤動作を抑制
    if (e.button !== 0) return;
    e.preventDefault();
    startX.current = e.clientX;
    startWidth.current = width;
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (startX.current == null) return;
    const delta = e.clientX - startX.current;
    onResize(startWidth.current + delta);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (startX.current == null) return;
    startX.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const step = e.shiftKey ? 32 : 8;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      onResize(width - step);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      onResize(width + step);
    } else if (e.key === "Home") {
      e.preventDefault();
      onResize(180);
    } else if (e.key === "End") {
      e.preventDefault();
      onResize(320);
    }
  };

  return (
    <button
      type="button"
      role="separator"
      aria-orientation="vertical"
      aria-label="サイドバー幅を変更"
      aria-valuenow={width}
      aria-valuemin={180}
      aria-valuemax={320}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onKeyDown={handleKeyDown}
      className="group absolute top-0 right-0 z-10 h-full w-1 cursor-col-resize touch-none bg-transparent hover:bg-[var(--accent)]/30 focus-visible:bg-[var(--accent)]/40"
      tabIndex={0}
    />
  );
}

function SectionHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between px-4 pt-4 pb-1.5 text-[11px] font-semibold tracking-[0.05em] text-[var(--fg-subtle)] uppercase">
      <span>{title}</span>
      {action}
    </div>
  );
}

interface RowProps {
  label: string;
  icon?: React.ReactNode;
  selected?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

function SidebarRow({ label, icon, selected, disabled, onClick }: RowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-current={selected ? "page" : undefined}
      className={cn(
        "group flex h-[var(--row-h)] w-full items-center gap-2 rounded-[var(--radius)] px-3 text-left",
        "transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        selected
          ? "bg-[var(--bg-accent-soft)] text-[var(--accent)]"
          : "text-[var(--fg)] hover:bg-[var(--bg-muted)]",
      )}
      style={selected ? { boxShadow: "inset 2px 0 0 0 var(--accent)" } : undefined}
    >
      {icon != null && <span className="shrink-0">{icon}</span>}
      <span className="truncate">{label}</span>
    </button>
  );
}

interface ProjectRowProps {
  project: Project;
  selected: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

/**
 * プロジェクト行 (`docs/ui-design.md` §3.2 + PR-U D&D)。SidebarRow と異なり hover 時に
 * 編集 / 削除 のミニアイコンと **ドラッグハンドル** を表示する。
 *
 * ## ドラッグハンドルの設計
 * - `useSortable` の `listeners` (= drag を起動するハンドラ群) は **GripVertical
 *   アイコンのみ**に付与する。プロジェクト名ボタンや編集 / 削除ボタンは通常クリック
 *   できる必要があるため、行全体には付けない (誤発動防止)
 * - `transform` / `transition` は `useSortable` の戻り値を CSS に反映
 * - `isDragging` 中は半透明 + cursor 変更で視覚フィードバック
 */
function SortableProjectRow({ project, selected, onSelect, onEdit, onDelete }: ProjectRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: project.id,
  });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
    boxShadow: selected ? "inset 2px 0 0 0 var(--accent)" : undefined,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "group flex h-[var(--row-h)] items-center rounded-[var(--radius)]",
        selected ? "bg-[var(--bg-accent-soft)]" : "hover:bg-[var(--bg-muted)]",
      )}
    >
      {/* ドラッグハンドル: hover で表示 */}
      <button
        type="button"
        aria-label={`${project.name} を並び替え`}
        title="ドラッグして並び替え"
        {...attributes}
        {...listeners}
        className="inline-flex h-5 w-4 shrink-0 cursor-grab items-center justify-center text-[var(--fg-subtle)] opacity-0 transition-opacity group-hover:opacity-100 active:cursor-grabbing"
      >
        <GripVertical size={12} aria-hidden />
      </button>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "page" : undefined}
        className={cn(
          "min-w-0 flex-1 truncate px-2 text-left text-[13px]",
          selected ? "font-medium text-[var(--accent)]" : "text-[var(--fg)]",
        )}
      >
        {project.name}
      </button>
      <div className="mr-1 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          type="button"
          aria-label={`${project.name} を編集`}
          title="編集"
          onClick={onEdit}
          className="inline-flex h-5 w-5 items-center justify-center rounded text-[var(--fg-subtle)] hover:bg-[var(--bg)] hover:text-[var(--accent)]"
        >
          <Pencil size={12} aria-hidden />
        </button>
        <button
          type="button"
          aria-label={`${project.name} を削除`}
          title="削除"
          onClick={onDelete}
          className="inline-flex h-5 w-5 items-center justify-center rounded text-[var(--fg-subtle)] hover:bg-[var(--bg)] hover:text-[var(--destructive)]"
        >
          <Trash2 size={12} aria-hidden />
        </button>
      </div>
    </div>
  );
}
