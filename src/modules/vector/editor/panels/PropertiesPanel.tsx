import { DEFAULT_NODE_NAMES } from "../model/create";
import { getPage } from "../model/tree";
import type { BooleanNode, CanvasNode, FrameNode, PathNode } from "../model/types";
import { useEditorStore } from "../state/store";
import { useSelectedNodes } from "./selection";
import { AlignSection } from "./sections/AlignSection";
import { AppearanceSection } from "./sections/AppearanceSection";
import { BooleanSection } from "./sections/BooleanSection";
import { ConvertSection } from "./sections/ConvertSection";
import { ExportSection } from "./sections/ExportSection";
import { FillSection } from "./sections/FillSection";
import { FrameSection } from "./sections/FrameSection";
import { PageSection } from "./sections/PageSection";
import { PathPointSection } from "./sections/PathPointSection";
import { PathSection } from "./sections/PathSection";
import { PositionSection } from "./sections/PositionSection";
import { hasFill, hasShadow, hasStroke } from "./sections/propertyOps";
import { ShadowSection } from "./sections/ShadowSection";
import { StrokeSection } from "./sections/StrokeSection";
import { TextSection } from "./sections/TextSection";
import { ToolSettingsSection } from "./sections/ToolSettingsSection";

/** パネルの幅 (§5.1)。 */
export const PROPERTIES_PANEL_WIDTH = 240;

/** 見出しに出す選択の要約。何も選んでいなければページの名前。 */
function summary(nodes: readonly CanvasNode[], pageName: string): string {
  const [first] = nodes;
  if (!first) return pageName;
  if (nodes.length === 1) return first.name === "" ? DEFAULT_NODE_NAMES[first.type] : first.name;
  return `${nodes.length} 個を選択`;
}

/**
 * 右のプロパティパネル (§5.3)。選択に応じて節を出す。
 * 種別ごとの節 (塗り・線・影・フレーム・パス・ブーリアン) は、選択の中に対象のノードが 1 つでもあれば出し、
 * 対象のノードだけに当てる。「変換」の節は、出す操作があるときだけ出る (§5.3)。
 * 何も選んでいないときはページの設定を出す。
 */
export function PropertiesPanel() {
  const nodes = useSelectedNodes();
  const pageName = useEditorStore((s) => getPage(s.doc, s.pageId)?.name ?? "");
  const fills = nodes.filter(hasFill);
  const strokes = nodes.filter(hasStroke);
  const shadows = nodes.filter(hasShadow);
  const frames = nodes.filter((node): node is FrameNode => node.type === "frame");
  const hasText = nodes.some((node) => node.type === "text");
  const paths = nodes.filter((node): node is PathNode => node.type === "path");
  const booleans = nodes.filter((node): node is BooleanNode => node.type === "boolean");

  return (
    <aside
      aria-label="プロパティ"
      className="flex min-h-0 shrink-0 flex-col border-l border-[var(--border)] bg-[var(--bg-sidebar)]"
      style={{ width: PROPERTIES_PANEL_WIDTH }}
    >
      <div className="flex h-10 shrink-0 items-center border-b border-[var(--border)] px-3">
        <h2 className="truncate text-[13px] font-medium text-[var(--fg)]">
          {summary(nodes, pageName)}
        </h2>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ToolSettingsSection />
        {nodes.length === 0 ? (
          <PageSection />
        ) : (
          <>
            <AlignSection />
            <PositionSection />
            <PathPointSection />
            <AppearanceSection nodes={nodes} />
            {fills.length > 0 && <FillSection nodes={fills} />}
            {strokes.length > 0 && <StrokeSection nodes={strokes} />}
            {shadows.length > 0 && <ShadowSection nodes={shadows} />}
            {hasText && <TextSection />}
            {frames.length > 0 && <FrameSection frames={frames} />}
            {paths.length > 0 && <PathSection paths={paths} />}
            {booleans.length > 0 && <BooleanSection booleans={booleans} />}
            <ConvertSection />
          </>
        )}
        <ExportSection />
      </div>
    </aside>
  );
}
