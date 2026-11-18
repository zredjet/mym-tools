/**
 * エディタの状態と操作の契約 (`docs/canvas-editor-design.md` §4.2)。
 *
 * 実装は `state/store.ts` が持ち、Zustand の vanilla store (`StoreApi<EditorStore>`) を
 * `editorStore`、React 用の selector hook を `useEditorStore` として公開する。
 * エディタは同時に 1 つしか開かないので、store はモジュール内で 1 つだけ作る。
 * アプリ全体の状態 (`useAppStore`) とは別物で、ここにはエディタの中だけの状態を置く。
 */
import type { CanvasDocument, NodeId, PageId } from "../model/types";

/**
 * ツールの ID。`pathEdit` はパスの点の編集を受けるツールで、ツールバーには出さない
 * (`startPathEdit` が切り替える。§4.13.1)。
 */
export type ToolId =
  | "select"
  | "hand"
  | "frame"
  | "rect"
  | "ellipse"
  | "polygon"
  | "star"
  | "line"
  | "pen"
  | "pencil"
  | "text"
  | "image"
  | "pathEdit";

/**
 * 表示位置と倍率。`x` / `y` は画面の左上に見えているページ座標。
 * 画面座標 = (ページ座標 - {x, y}) × zoom
 */
export interface Viewport {
  x: number;
  y: number;
  /** 0.02〜64 */
  zoom: number;
}

/** 表示の設定。文書には保存せず、画面を開くたびに既定値へ戻る。 */
export interface ViewOptions {
  rulers: boolean;
  grid: boolean;
  snapToGrid: boolean;
  /** グリッドの間隔 (px) */
  gridSize: number;
  layersPanel: boolean;
}

export interface EditorState {
  doc: CanvasDocument;
  /** 表示中のページ。第 1 段階では常に先頭のページ */
  pageId: PageId;
  selection: readonly NodeId[];
  hoveredId: NodeId | null;
  /** ダブルクリックで中に入った frame / group。null はページ直下 */
  scopeId: NodeId | null;
  /** 本文を編集中のテキスト */
  editingTextId: NodeId | null;
  /**
   * 点を編集中のパス (§4.13.1)。本文の編集と同時には開かない。選んでいる点やペンの描きかけの状態は
   * `path/editSession.ts` が持ち、ここには入れない
   */
  editingPathId: NodeId | null;
  toolId: ToolId;
  viewport: Viewport;
  view: ViewOptions;
  /** 文書を変える操作が確定するたびに 1 増える。Undo / Redo でも増える。未保存の判定に使う */
  revision: number;
  canUndo: boolean;
  canRedo: boolean;
  /** ドラッグなど連続する操作の途中か */
  gestureActive: boolean;
}

/** 文書を受け取り、変更後の文書を返す純関数。引数を書き換えてはいけない。 */
export type DocRecipe = (doc: CanvasDocument) => CanvasDocument;

export interface EditorActions {
  /** 文書を読み込む。履歴・選択・スコープを捨て、revision を 0 に戻す。表示位置と表示の設定は残し、ツールは選択に戻す */
  load(doc: CanvasDocument): void;

  /** 文書を変えて履歴に 1 件積む。同じ文書が返れば何もしない。ジェスチャーの途中なら、先にそれを確定する */
  apply(recipe: DocRecipe): void;

  /**
   * 連続する操作 (ドラッグ)。`updateGesture` の recipe には毎回 `beginGesture` 時点の文書が渡る。
   * `commitGesture` で履歴に 1 件だけ積み (文書が変わっていなければ積まない)、`cancelGesture` で文書と選択を
   * 開始時点へ戻す。途中の `updateGesture` では revision を増やさない。
   */
  beginGesture(): void;
  updateGesture(recipe: DocRecipe): void;
  commitGesture(): void;
  cancelGesture(): void;

  /**
   * 履歴は文書と選択を組で持ち、戻すと選択も戻る。スコープと本文の編集は解除する。上限 100 件。
   * 点の編集は、編集中のパスが残っていれば続け (選択はそのパスにする)、消えていれば終える (§4.13.1)。
   * ジェスチャーの途中なら、ジェスチャーを取り消すだけにする。
   */
  undo(): void;
  redo(): void;

  /** 選択を変える。点の編集中に、編集中のパスだけの選択から変えると、点の編集を終える (§4.13.1) */
  setSelection(ids: readonly NodeId[]): void;
  setHovered(id: NodeId | null): void;
  setScope(id: NodeId | null): void;
  /**
   * ツールを切り替える。点の編集中は、`pathEdit` とペン (`pen`) 以外へ切り替えると点の編集を終える
   * (ペンへの切替だけは、同じパスに輪郭を足すため `editingPathId` を残す。§4.13.1)
   */
  setTool(id: ToolId): void;
  setViewport(viewport: Viewport): void;
  setView(patch: Partial<ViewOptions>): void;
  /** 本文の編集を始める。点の編集中なら、先に点の編集を終える (同時には開かない) */
  startTextEdit(id: NodeId): void;
  endTextEdit(): void;
  /**
   * パスの点の編集を始める (§4.13.1)。表示中のページのパスでなければ何もしない。
   * `editingPathId` を決め、そのパスだけを選び、ツールを `pathEdit` にする。本文の編集中なら終える
   */
  startPathEdit(id: NodeId): void;
  /** 点の編集を終え、選択ツールへ戻す。編集中でなければ何もしない */
  endPathEdit(): void;
}

export type EditorStore = EditorState & EditorActions;

export const DEFAULT_VIEW_OPTIONS: ViewOptions = {
  rulers: true,
  grid: false,
  snapToGrid: false,
  gridSize: 8,
  layersPanel: true,
};

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 64;
