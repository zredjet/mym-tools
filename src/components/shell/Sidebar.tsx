/**
 * サイドバー (`docs/ui-design.md` §3.2)。
 *
 * - PROJECTS セクション (一覧 + `+` ボタンで C-4 ダイアログ)
 * - MODULES セクション (固定 4 モジュール、count は Phase 1 では出さない)
 * - 末尾に `🌗` テーマトグル
 *
 * 行高 32px / padding 6px 12px / 選択行は `--bg-accent-soft` + `--accent` テキスト + 左 2px。
 */
import { useCallback, useState } from "react";
import { FileText, Hash, Link as LinkIcon, Palette, Pencil, Plus, Trash2 } from "lucide-react";
import { useLocation, useNavigate, useParams } from "react-router-dom";

import { ProjectCreateDialog } from "@/components/projects/ProjectCreateDialog";
import { ProjectEditDialog } from "@/components/projects/ProjectEditDialog";
import { ConfirmDeleteDialog } from "@/components/ui/ConfirmDeleteDialog";
import { ThemeToggle } from "@/components/shell/ThemeToggle";
import { deleteProject } from "@/ipc/projects";
import { cn } from "@/lib/cn";
import type { ModuleId, Project } from "@/lib/types";
import { useAppStore } from "@/store/useAppStore";

interface SidebarProps {
  projects: Project[];
  /** 新規作成成功時に呼び出される (親が再取得する) */
  onProjectCreated: (project: Project) => void;
  /** 編集 / 削除成功時に呼び出される (親が再取得する) */
  onProjectChanged: () => void;
}

interface ModuleEntry {
  id: ModuleId;
  label: string;
  icon: typeof Hash;
}

/** モジュール表示順 (`docs/ui-design.md` §3.2 サイドバー、Prompts→Links→Colors→Hash) */
const MODULES: readonly ModuleEntry[] = [
  { id: "prompt", label: "Prompts", icon: FileText },
  { id: "linkmemo", label: "Links", icon: LinkIcon },
  { id: "color", label: "Colors", icon: Palette },
  { id: "hash", label: "Hash", icon: Hash },
];

export function Sidebar({ projects, onProjectCreated, onProjectChanged }: SidebarProps) {
  const [createOpen, setCreateOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [deletingProject, setDeletingProject] = useState<Project | null>(null);
  const { projectId, moduleId } = useParams<{ projectId?: string; moduleId?: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const sidebarWidth = useAppStore((s) => s.sidebarWidth);
  const setLastModule = useAppStore((s) => s.setLastOpenedModuleId);
  const setLastProject = useAppStore((s) => s.setLastOpenedProjectId);
  const lastOpenedProjectId = useAppStore((s) => s.lastOpenedProjectId);

  // PROJECTS ハイライト + module 遷移先のフォールバック (案3、メモリ参照):
  // `/modules/hash` (stateless) では URL に projectId が無いため `useParams` は
  // undefined を返すが、UI 上は前回開いていた project を選択中として表示し続けた方が
  // ユーザビリティが高い。`lastOpenedProjectId` (Zustand persist) をフォールバックに使う。
  // 該当 project が現在も存在することも確認 (削除済 ID の幽霊参照を弾く)
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

  // Hash は stateless で `/modules/hash` 単独ルート → URL に `:moduleId` が無いため
  // `useParams` の `moduleId` は undefined になる。pathname から専用判定する
  // (PR #31 codex P2 対応)
  const onHashRoute = location.pathname === "/modules/hash";
  const activeModuleId: ModuleId | null = onHashRoute
    ? "hash"
    : ((moduleId as ModuleId | undefined) ?? null);

  const goToProject = (pid: string) => {
    const m = (moduleId as ModuleId | undefined) ?? "prompt";
    setLastProject(pid);
    setLastModule(m);
    navigate(`/projects/${pid}/m/${m}`);
  };

  const goToModule = (mid: ModuleId) => {
    setLastModule(mid);
    if (mid === "hash") {
      navigate(`/modules/hash`);
      return;
    }
    // 案3: URL に projectId が無くても (= Hash 表示中) `effectiveProjectId` で遷移可
    if (effectiveProjectId == null) return;
    navigate(`/projects/${effectiveProjectId}/m/${mid}`);
  };

  return (
    <aside
      className="flex h-full shrink-0 flex-col border-r border-[var(--border)] bg-[var(--bg-sidebar)] text-[13px] text-[var(--fg)]"
      style={{ width: sidebarWidth }}
      aria-label="サイドバー"
    >
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
      <ul className="flex flex-col px-1.5 pb-2" role="list">
        {projects.length === 0 && (
          <li className="px-3 py-1.5 text-[12px] text-[var(--fg-subtle)]">プロジェクトなし</li>
        )}
        {projects.map((p) => (
          <li key={p.id}>
            <ProjectRow
              project={p}
              selected={effectiveProjectId === p.id}
              onSelect={() => goToProject(p.id)}
              onEdit={() => setEditingProject(p)}
              onDelete={() => setDeletingProject(p)}
            />
          </li>
        ))}
      </ul>

      {/* MODULES section */}
      <SectionHeader title="MODULES" action={<ThemeToggle />} />
      <ul className="flex flex-col px-1.5 pb-2" role="list">
        {MODULES.map((m) => {
          const Icon = m.icon;
          // 案3: hash 以外も effectiveProjectId (URL or lastOpened) があれば押せる
          const disabled = m.id !== "hash" && effectiveProjectId == null;
          return (
            <li key={m.id}>
              <SidebarRow
                label={m.label}
                icon={<Icon size={14} aria-hidden />}
                selected={activeModuleId === m.id}
                disabled={disabled}
                onClick={() => !disabled && goToModule(m.id)}
              />
            </li>
          );
        })}
      </ul>

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
            (Prompts / Links / Colors) が連鎖削除されます。バックアップから戻すこと
            は可能ですが、現在の状態へは戻れません。
          </>
        }
        onClose={() => setDeletingProject(null)}
        onConfirm={handleConfirmDelete}
      />
    </aside>
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
 * プロジェクト行 (`docs/ui-design.md` §3.2)。SidebarRow と異なり hover 時に編集/削除
 * のミニアイコンを表示する。クリック領域を分けるため、ボタンを横並びにして
 * `<li>` 全体は単一の `flex` コンテナに。
 */
function ProjectRow({ project, selected, onSelect, onEdit, onDelete }: ProjectRowProps) {
  return (
    <div
      className={cn(
        "group flex h-[var(--row-h)] items-center rounded-[var(--radius)]",
        selected ? "bg-[var(--bg-accent-soft)]" : "hover:bg-[var(--bg-muted)]",
      )}
      style={selected ? { boxShadow: "inset 2px 0 0 0 var(--accent)" } : undefined}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "page" : undefined}
        className={cn(
          "min-w-0 flex-1 truncate px-3 text-left text-[13px]",
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
