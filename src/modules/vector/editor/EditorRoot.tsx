import { CanvasView } from "./canvas/CanvasView";
import { LayersPanel } from "./panels/LayersPanel";
import { PropertiesPanel } from "./panels/PropertiesPanel";
import { Toolbar } from "./toolbar/Toolbar";

/**
 * エディタの配置 (`docs/canvas-editor-design.md` §5.1)。
 * 左にレイヤー、中央にキャンバス、右にプロパティ。ツールバーはキャンバスの下中央に浮かせる。
 *
 * 文書の読み込みと保存は持たない。呼び出し側 (切替後の `VectorWorkspacePage`、開発用の
 * `dev/EditorHarness`) が `editorStore` の `load` と `doc` / `revision` を使う。
 */
export function EditorRoot() {
  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden">
      <LayersPanel />
      <div className="relative min-h-0 min-w-0 flex-1">
        <CanvasView />
        <Toolbar />
      </div>
      <PropertiesPanel />
    </div>
  );
}
