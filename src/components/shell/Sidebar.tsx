/**
 * サイドバー (`docs/ui-design.md` §3.2)。
 *
 * - PROJECTS セクション (一覧 + `+` ボタンで C-4 ダイアログ)
 * - MODULES セクション (固定 4 モジュール、count は Phase 1 では出さない)
 * - 末尾に `🌗` テーマトグル
 *
 * 行高 32px / padding 6px 12px / 選択行は `--bg-accent-soft` + `--accent` テキスト + 左 2px。
 */
import { useState } from "react";
import { Plus, Hash, Link as LinkIcon, Palette, FileText } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";

import { ProjectCreateDialog } from "@/components/projects/ProjectCreateDialog";
import { ThemeToggle } from "@/components/shell/ThemeToggle";
import { cn } from "@/lib/cn";
import type { ModuleId, Project } from "@/lib/types";
import { useAppStore } from "@/store/useAppStore";

interface SidebarProps {
  projects: Project[];
  /** 新規作成成功時に呼び出される (親が再取得する) */
  onProjectCreated: (project: Project) => void;
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

export function Sidebar({ projects, onProjectCreated }: SidebarProps) {
  const [createOpen, setCreateOpen] = useState(false);
  const { projectId, moduleId } = useParams<{ projectId?: string; moduleId?: string }>();
  const navigate = useNavigate();
  const sidebarWidth = useAppStore((s) => s.sidebarWidth);
  const setLastModule = useAppStore((s) => s.setLastOpenedModuleId);
  const setLastProject = useAppStore((s) => s.setLastOpenedProjectId);

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
    if (projectId == null) return; // モジュール固有データはプロジェクト必須
    navigate(`/projects/${projectId}/m/${mid}`);
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
            <SidebarRow
              label={p.name}
              selected={projectId === p.id}
              onClick={() => goToProject(p.id)}
            />
          </li>
        ))}
      </ul>

      {/* MODULES section */}
      <SectionHeader title="MODULES" action={<ThemeToggle />} />
      <ul className="flex flex-col px-1.5 pb-2" role="list">
        {MODULES.map((m) => {
          const Icon = m.icon;
          const disabled = m.id !== "hash" && projectId == null;
          return (
            <li key={m.id}>
              <SidebarRow
                label={m.label}
                icon={<Icon size={14} aria-hidden />}
                selected={moduleId === m.id || (m.id === "hash" && moduleId === "hash")}
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
