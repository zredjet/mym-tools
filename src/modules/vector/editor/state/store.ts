/**
 * エディタの store (§4.2、契約は `state/types.ts`)。
 * Zustand の vanilla store を 1 つ作り、`editorStore` と `useEditorStore(selector)` を公開する。
 * アプリ全体の `useAppStore` とは別物で、React の Context も使わない。
 */
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { createEmptyDocument } from "../model/create";
import { getNode, getPageOf, isContainer } from "../model/tree";
import type { CanvasDocument, NodeId, PageId } from "../model/types";
import {
  EMPTY_HISTORY,
  pushHistory,
  redoHistory,
  undoHistory,
  type History,
  type Snapshot,
} from "./history";
import {
  DEFAULT_VIEW_OPTIONS,
  MAX_ZOOM,
  MIN_ZOOM,
  type EditorState,
  type EditorStore,
  type ViewOptions,
} from "./types";

type Refs = Pick<EditorState, "pageId" | "selection" | "hoveredId" | "scopeId" | "editingTextId">;

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/**
 * 文書に存在しなくなったノードを参照から外す。
 * 選択は表示中のページのノードだけに絞る。変わらない値は同じオブジェクトのまま返す。
 */
export function sanitizeRefs(doc: CanvasDocument, refs: Refs): Refs {
  const pageId: PageId = doc.pages.some((page) => page.id === refs.pageId)
    ? refs.pageId
    : (doc.pages[0]?.id ?? refs.pageId);
  const onPage = (id: NodeId) => getPageOf(doc, id)?.id === pageId;
  const filtered = [...new Set(refs.selection)].filter(onPage);
  const selection = sameIds(filtered, refs.selection) ? refs.selection : filtered;
  const hoveredId = refs.hoveredId !== null && onPage(refs.hoveredId) ? refs.hoveredId : null;
  const scope = refs.scopeId === null ? undefined : getNode(doc, refs.scopeId);
  const scopeId = scope && isContainer(scope) && onPage(scope.id) ? scope.id : null;
  const editing = refs.editingTextId === null ? undefined : getNode(doc, refs.editingTextId);
  const editingTextId = editing?.type === "text" && onPage(editing.id) ? editing.id : null;
  return { pageId, selection, hoveredId, scopeId, editingTextId };
}

function pickRefs(state: EditorState): Refs {
  return {
    pageId: state.pageId,
    selection: state.selection,
    hoveredId: state.hoveredId,
    scopeId: state.scopeId,
    editingTextId: state.editingTextId,
  };
}

/** 初期状態 (`load` の後と同じ形)。 */
function initialState(doc: CanvasDocument): EditorState {
  return {
    doc,
    pageId: doc.pages[0]?.id ?? "",
    selection: [],
    hoveredId: null,
    scopeId: null,
    editingTextId: null,
    toolId: "select",
    viewport: { x: 0, y: 0, zoom: 1 },
    view: { ...DEFAULT_VIEW_OPTIONS },
    revision: 0,
    canUndo: false,
    canRedo: false,
    gestureActive: false,
  };
}

/**
 * store を作る。アプリは `editorStore` を 1 つだけ使い、テストはこれで個別の store を作る。
 *
 * 契約 (`types.ts`) のコメントに加えた取り決め:
 * - ジェスチャー中に `apply` / `beginGesture` を呼ぶと、先に今のジェスチャーを確定する
 * - ジェスチャー中の `undo` / `redo` は、ジェスチャーを取り消すだけで履歴は動かさない
 * - `cancelGesture` は文書と選択を `beginGesture` の時点へ戻す
 * - `revision` は `apply` / `commitGesture` (文書が変わったとき) / `undo` / `redo` で 1 増える。
 *   ジェスチャーの途中 (`updateGesture`) では増えない
 * - `load` は表示位置と表示の設定を残し、ツールを選択に戻す
 */
export function createEditorStore(
  doc: CanvasDocument = createEmptyDocument(),
): StoreApi<EditorStore> {
  let history: History = EMPTY_HISTORY;
  let gestureBase: Snapshot | null = null;

  return createStore<EditorStore>()((set, get) => {
    /** 文書を変えた後の状態。参照の掃除と履歴のフラグをまとめて作る。 */
    const withDoc = (
      nextDoc: CanvasDocument,
      refs: Partial<Refs>,
      extra: Partial<EditorState> = {},
    ): Partial<EditorState> => ({
      doc: nextDoc,
      ...sanitizeRefs(nextDoc, { ...pickRefs(get()), ...refs }),
      canUndo: history.past.length > 0,
      canRedo: history.future.length > 0,
      ...extra,
    });

    const commit = (before: Snapshot, nextDoc: CanvasDocument) => {
      history = pushHistory(history, before);
      set(withDoc(nextDoc, {}, { revision: get().revision + 1 }));
    };

    const commitGesture = () => {
      const base = gestureBase;
      if (!base) return;
      gestureBase = null;
      const state = get();
      if (state.doc === base.doc) set({ gestureActive: false });
      else {
        history = pushHistory(history, base);
        set(withDoc(state.doc, {}, { revision: state.revision + 1, gestureActive: false }));
      }
    };

    const cancelGesture = () => {
      const base = gestureBase;
      if (!base) return;
      gestureBase = null;
      set(withDoc(base.doc, { selection: base.selection }, { gestureActive: false }));
    };

    const restore = (snapshot: Snapshot) =>
      set(
        withDoc(
          snapshot.doc,
          { selection: snapshot.selection, scopeId: null, editingTextId: null },
          { revision: get().revision + 1 },
        ),
      );

    return {
      ...initialState(doc),

      load(nextDoc) {
        history = EMPTY_HISTORY;
        gestureBase = null;
        const { viewport, view } = get();
        set({ ...initialState(nextDoc), viewport, view });
      },

      apply(recipe) {
        if (gestureBase) commitGesture();
        const state = get();
        const next = recipe(state.doc);
        if (next === state.doc) return;
        commit({ doc: state.doc, selection: state.selection }, next);
      },

      beginGesture() {
        if (gestureBase) commitGesture();
        const state = get();
        gestureBase = { doc: state.doc, selection: state.selection };
        set({ gestureActive: true });
      },

      updateGesture(recipe) {
        const base = gestureBase;
        if (!base) return;
        const next = recipe(base.doc);
        if (next === get().doc) return;
        set(withDoc(next, {}));
      },

      commitGesture,
      cancelGesture,

      undo() {
        if (gestureBase) {
          cancelGesture();
          return;
        }
        const state = get();
        const result = undoHistory(history, { doc: state.doc, selection: state.selection });
        if (!result) return;
        history = result.history;
        restore(result.snapshot);
      },

      redo() {
        if (gestureBase) {
          cancelGesture();
          return;
        }
        const state = get();
        const result = redoHistory(history, { doc: state.doc, selection: state.selection });
        if (!result) return;
        history = result.history;
        restore(result.snapshot);
      },

      setSelection(ids) {
        const state = get();
        const { selection } = sanitizeRefs(state.doc, { ...pickRefs(state), selection: ids });
        if (!sameIds(selection, state.selection)) set({ selection: [...selection] });
      },

      setHovered(id) {
        const state = get();
        const { hoveredId } = sanitizeRefs(state.doc, { ...pickRefs(state), hoveredId: id });
        if (hoveredId !== state.hoveredId) set({ hoveredId });
      },

      setScope(id) {
        const state = get();
        const { scopeId } = sanitizeRefs(state.doc, { ...pickRefs(state), scopeId: id });
        if (scopeId !== state.scopeId) set({ scopeId });
      },

      setTool(toolId) {
        if (toolId !== get().toolId) set({ toolId });
      },

      setViewport(viewport) {
        const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, viewport.zoom));
        const current = get().viewport;
        if (current.x === viewport.x && current.y === viewport.y && current.zoom === zoom) return;
        set({ viewport: { x: viewport.x, y: viewport.y, zoom } });
      },

      setView(patch) {
        const current = get().view;
        const next: ViewOptions = { ...current, ...patch };
        const keys = Object.keys(next) as (keyof ViewOptions)[];
        if (keys.every((key) => next[key] === current[key])) return;
        set({ view: next });
      },

      startTextEdit(id) {
        const state = get();
        const refs = sanitizeRefs(state.doc, { ...pickRefs(state), editingTextId: id });
        if (refs.editingTextId === null) return;
        set({ editingTextId: refs.editingTextId, selection: [refs.editingTextId] });
      },

      endTextEdit() {
        if (get().editingTextId !== null) set({ editingTextId: null });
      },
    };
  });
}

/** エディタの store。エディタは同時に 1 つしか開かないので、モジュール内で 1 つだけ作る。 */
export const editorStore: StoreApi<EditorStore> = createEditorStore();

/** React から store の一部を購読する。selector は必要な部分だけを返す (§4.2)。 */
export function useEditorStore<T>(selector: (state: EditorStore) => T): T {
  return useStore(editorStore, selector);
}
