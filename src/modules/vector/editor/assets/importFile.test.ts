import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createText } from "../model/create";
import { insertNode } from "../model/structure";
import { sampleDocument } from "../model/testing";
import { getParent } from "../model/tree";
import { fixedWidthMeasurer } from "../render/testing";
import { createEditorStore } from "../state/store";
import { imageTool, resetImageTool } from "../tools/imageTool";
import type { CanvasPointerEvent, ToolContext } from "../tools/types";
import { importFile, importFromPicker, type ImportOptions } from "./importFile";
import { setImportFileReader } from "./reader";
import { getImportStatus, resetImportStatus } from "./status";
import { pngDataUrl, SAMPLE_SVG, SAMPLE_SVG_TEXT } from "./testing";
import type { ImportedFile } from "./types";

const options: ImportOptions = {
  measureImage: async (dataUrl) => {
    // pngDataUrl の IHDR から大きさを読む
    const bytes = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
    const u32 = (at: number) =>
      ((bytes.charCodeAt(at) << 24) |
        (bytes.charCodeAt(at + 1) << 16) |
        (bytes.charCodeAt(at + 2) << 8) |
        bytes.charCodeAt(at + 3)) >>>
      0;
    return { width: u32(16), height: u32(20) };
  },
  viewSize: { width: 800, height: 600 },
};

const image = (width = 200, height = 100, seed = 0): ImportedFile => ({
  kind: "image",
  dataUrl: pngDataUrl(width, height, seed),
  name: "写真",
});
const svg: ImportedFile = {
  kind: "svg",
  svg: SAMPLE_SVG,
  text: SAMPLE_SVG_TEXT,
  notices: ["draw.io の SVG を変換しました。"],
  name: "図",
};

function setup() {
  const store = createEditorStore(sampleDocument());
  // 表示範囲はページ座標 (1000, 1000)〜(1800, 1600)。中央は (1400, 1300) (frame の外)
  store.getState().setViewport({ x: 1000, y: 1000, zoom: 1 });
  const s = () => store.getState();
  const selected = () => s().doc.nodes[s().selection[0] ?? ""];
  return { store, s, selected };
}

/** 解決を外から決められる Promise。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  resetImportStatus();
  setImportFileReader(null);
  resetImageTool();
});
afterEach(() => setImportFileReader(null));

describe("importFile", () => {
  it("表示範囲の中央に置き、選んで選択ツールへ戻る。履歴 1 件", async () => {
    const { store, s, selected } = setup();
    store.getState().setTool("rect");
    expect(await importFile(store, image(), options)).toBe(true);
    expect(selected()).toMatchObject({
      type: "image",
      name: "写真",
      x: 1300,
      y: 1250,
      width: 200,
      height: 100,
    });
    expect(s().toolId).toBe("select");
    expect(s().revision).toBe(1);
    store.getState().undo();
    expect(Object.keys(s().doc.nodes)).toHaveLength(8);
  });

  it("指定した位置 (ドロップ) を中心にし、frame の上なら frame の子", async () => {
    const { store, s, selected } = setup();
    await importFile(store, image(20, 10), { ...options, at: { x: 150, y: 300 } });
    const id = s().selection[0] ?? "";
    expect(getParent(s().doc, id)).toEqual({ kind: "node", id: "f" });
    expect(selected()).toMatchObject({ x: 40, y: 245, width: 20, height: 10 });
  });

  it("中央に置くときは、丸ごと入る frame だけを親にする", async () => {
    const { store, s } = setup();
    store.getState().setViewport({ x: -50, y: -100, zoom: 1 }); // 中央は (350, 200)、f2 と f の上
    await importFile(store, image(50, 20), options);
    expect(getParent(s().doc, s().selection[0] ?? "")).toEqual({ kind: "node", id: "f2" });
    await importFile(store, image(300, 20, 1), options);
    expect(getParent(s().doc, s().selection[0] ?? "")).toEqual({ kind: "node", id: "f" });
    await importFile(store, image(4000, 1000, 2), options);
    expect(getParent(s().doc, s().selection[0] ?? "")).toEqual({ kind: "page", id: "p1" });
  });

  it("大きな画像は表示範囲に収まる大きさに縮める", async () => {
    const { store, selected } = setup();
    await importFile(store, image(4000, 1000), options);
    expect(selected()).toMatchObject({ width: 800, height: 200 });
  });

  it("同じ画像を 2 回取り込んだら、アセットは 1 つ", async () => {
    const { store, s } = setup();
    await importFile(store, image(), options);
    await importFile(store, image(), options);
    expect(Object.keys(s().doc.assets)).toHaveLength(1);
    expect(s().revision).toBe(2);
  });

  it("SVG は埋め込み SVG として置き、notices を知らせる", async () => {
    const { store, selected } = setup();
    await importFile(store, svg, options);
    expect(selected()).toMatchObject({ type: "svg", name: "図", width: 200, height: 100 });
    expect(getImportStatus().notice).toEqual({
      tone: "info",
      message: "SVG を取り込みました。draw.io の SVG を変換しました。",
    });
  });

  it("SVG の文字が一致しなければ取り込まず、理由を出す", async () => {
    const { store, s } = setup();
    expect(await importFile(store, { ...svg, text: "違う" }, options)).toBe(false);
    expect(s().revision).toBe(0);
    expect(getImportStatus().notice?.tone).toBe("error");
  });

  it("画像を読み込めなければ取り込まず、理由を出す", async () => {
    const { store, s } = setup();
    const failing = async () => {
      throw new Error("decode");
    };
    expect(await importFile(store, image(), { ...options, measureImage: failing })).toBe(false);
    expect(s().revision).toBe(0);
    expect(getImportStatus().notice?.message).toContain("読み込めない");
  });

  it("途中で Undo されたら、Undo の後の文書に置く (古い文書を書き戻さない)", async () => {
    const { store, s } = setup();
    store.getState().apply((doc) => ({ ...doc, pages: [{ ...doc.pages[0]!, name: "変更" }] }));
    const gate = deferred<{ width: number; height: number }>();
    const pending = importFile(store, image(), { ...options, measureImage: () => gate.promise });
    store.getState().undo();
    const afterUndo = s().doc;
    gate.resolve({ width: 200, height: 100 });
    expect(await pending).toBe(true);
    expect(s().doc.pages[0]?.name).toBe(afterUndo.pages[0]?.name);
    expect(Object.keys(s().doc.nodes)).toHaveLength(9);
  });

  it("途中で別の作品が開かれたら置かない", async () => {
    const { store, s } = setup();
    const gate = deferred<{ width: number; height: number }>();
    const pending = importFile(store, image(), { ...options, measureImage: () => gate.promise });
    const other = sampleDocument();
    store.getState().load(other);
    gate.resolve({ width: 200, height: 100 });
    expect(await pending).toBe(false);
    expect(s().doc).toBe(other);
    expect(getImportStatus().notice?.tone).toBe("error");
  });

  it("取込の途中は次の取込を受け付けない", async () => {
    const { store } = setup();
    const gate = deferred<{ width: number; height: number }>();
    const pending = importFile(store, image(), { ...options, measureImage: () => gate.promise });
    expect(getImportStatus().busy).toBe(true);
    expect(await importFile(store, image(), options)).toBe(false);
    gate.resolve({ width: 200, height: 100 });
    await pending;
    expect(getImportStatus().busy).toBe(false);
  });
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ジェスチャー・作品の入れ替え・本文の編集", () => {
  it("読み込みが終わったときにジェスチャーが開いていれば、閉じるのを待ってから置く (途中で確定しない)", async () => {
    const { store, s } = setup();
    const gate = deferred<{ width: number; height: number }>();
    const pending = importFile(store, image(), { ...options, measureImage: () => gate.promise });
    const before = s().doc;
    // ほかの操作のドラッグ (r0 を動かす)
    store.getState().beginGesture();
    store.getState().updateGesture((doc) => ({
      ...doc,
      nodes: { ...doc.nodes, r0: { ...doc.nodes.r0!, x: 50 } as (typeof doc.nodes)[string] },
    }));
    gate.resolve({ width: 200, height: 100 });
    await tick();
    await tick();
    expect(s().gestureActive).toBe(true);
    expect(s().revision).toBe(0);
    // 持ち主が Esc で取り消せば、取り消した文書に置く
    store.getState().cancelGesture();
    expect(await pending).toBe(true);
    expect(s().revision).toBe(1);
    expect(s().doc.nodes.r0).toBe(before.nodes.r0);
    store.getState().undo();
    expect(s().doc).toBe(before);
  });

  it("待ちが解けた直後に別の操作が次のジェスチャーを開いたら、それも閉じるのを待つ", async () => {
    const { store, s } = setup();
    const gate = deferred<{ width: number; height: number }>();
    const pending = importFile(store, image(), { ...options, measureImage: () => gate.promise });
    const moveR0 = (x: number) =>
      store.getState().updateGesture((doc) => ({
        ...doc,
        nodes: { ...doc.nodes, r0: { ...doc.nodes.r0!, x } as (typeof doc.nodes)[string] },
      }));
    // ジェスチャー A を開いたまま読み込みが終わる
    store.getState().beginGesture();
    moveR0(50);
    gate.resolve({ width: 200, height: 100 });
    await tick();
    await tick();
    expect(s().revision).toBe(0);
    // 別の操作の beginGesture が A を確定して B を開き、同じ流れで B を動かす
    store.getState().beginGesture();
    moveR0(80);
    await tick();
    await tick();
    // B は途中で確定されない
    expect(s()).toMatchObject({ gestureActive: true, revision: 1 });
    expect(s().doc.nodes.r0).toMatchObject({ x: 80 });
    // B の持ち主が取り消せば A の結果に戻り、その後に置く
    store.getState().cancelGesture();
    expect(await pending).toBe(true);
    expect(s().revision).toBe(2);
    expect(s().doc.nodes.r0).toMatchObject({ x: 50 });
  });

  it("ジェスチャーが確定されたら、その後に置く (履歴は 2 件)", async () => {
    const { store, s } = setup();
    const gate = deferred<{ width: number; height: number }>();
    const pending = importFile(store, image(), { ...options, measureImage: () => gate.promise });
    store.getState().beginGesture();
    store.getState().updateGesture((doc) => ({ ...doc }));
    gate.resolve({ width: 200, height: 100 });
    await tick();
    store.getState().commitGesture();
    expect(await pending).toBe(true);
    expect(s().revision).toBe(2);
  });

  it("未変更の作品でジェスチャーの途中に別の作品が開かれたら置かない", async () => {
    const { store, s } = setup();
    const gate = deferred<{ width: number; height: number }>();
    const pending = importFile(store, image(), { ...options, measureImage: () => gate.promise });
    store.getState().beginGesture();
    store.getState().updateGesture((doc) => ({ ...doc }));
    const other = sampleDocument();
    store.getState().load(other);
    gate.resolve({ width: 200, height: 100 });
    expect(await pending).toBe(false);
    expect(s().doc).toBe(other);
    expect(s().revision).toBe(0);
  });

  it("編集済みの作品から別の作品が開かれたら置かない", async () => {
    const { store, s } = setup();
    store.getState().apply((doc) => ({ ...doc }));
    store.getState().apply((doc) => ({ ...doc }));
    const gate = deferred<{ width: number; height: number }>();
    const pending = importFile(store, image(), { ...options, measureImage: () => gate.promise });
    const other = sampleDocument();
    store.getState().load(other);
    gate.resolve({ width: 200, height: 100 });
    expect(await pending).toBe(false);
    expect(s().doc).toBe(other);
  });

  it("別の作品が開かれたら、取込の知らせを消す", async () => {
    const { store } = setup();
    await importFile(store, { ...svg, text: "違う" }, options);
    expect(getImportStatus().notice?.tone).toBe("error");
    store.getState().apply((doc) => ({ ...doc })); // 編集では消さない
    expect(getImportStatus().notice?.tone).toBe("error");
    store.getState().load(sampleDocument());
    expect(getImportStatus().notice).toBeNull();
  });

  it("取込の途中にドロップされたら、取込中であることを知らせ、先の取込が終わったら消す", async () => {
    const { store } = setup();
    const gate = deferred<{ width: number; height: number }>();
    const pending = importFile(store, image(), { ...options, measureImage: () => gate.promise });
    expect(await importFile(store, image(10, 10, 1), { ...options, at: { x: 0, y: 0 } })).toBe(
      false,
    );
    expect(getImportStatus().notice?.message).toContain("取り込んでいる途中");
    gate.resolve({ width: 200, height: 100 });
    expect(await pending).toBe(true);
    expect(getImportStatus().notice).toBeNull();
  });

  it("本文の編集中なら、編集を終えてから置く", async () => {
    const { store, s } = setup();
    const text = createText({ id: "t1", x: 1400, y: 1300, text: "あ" });
    store.getState().apply((doc) => insertNode(doc, text, { kind: "page", id: "p1" }));
    store.getState().setSelection(["t1"]);
    store.getState().startTextEdit("t1");
    expect(s().editingTextId).toBe("t1");
    expect(await importFile(store, image(), options)).toBe(true);
    expect(s().editingTextId).toBeNull();
    expect(s().doc.nodes[s().selection[0] ?? ""]?.type).toBe("image");
  });
});

describe("importFromPicker", () => {
  it("登録がなければ何もしない", async () => {
    const { store } = setup();
    expect(await importFromPicker(store, options)).toBe(false);
  });

  it("登録した関数を待たずに呼び、選んだファイルを置く", async () => {
    const { store, s } = setup();
    const reader = vi.fn(async () => image());
    setImportFileReader(reader);
    const pending = importFromPicker(store, options);
    expect(reader).toHaveBeenCalledTimes(1); // 利用者の操作の中で開く
    expect(await pending).toBe(true);
    expect(s().revision).toBe(1);
  });

  it("取り消したら何もしない", async () => {
    const { store, s } = setup();
    setImportFileReader(async () => null);
    expect(await importFromPicker(store, options)).toBe(false);
    expect(s().revision).toBe(0);
    expect(getImportStatus()).toEqual({ busy: false, notice: null });
  });

  it("読めなければ理由を出す", async () => {
    const { store, s } = setup();
    setImportFileReader(async () => {
      throw "ファイルは20MiB以下にしてください。";
    });
    expect(await importFromPicker(store, options)).toBe(false);
    expect(s().revision).toBe(0);
    expect(getImportStatus().notice?.message).toContain("20MiB");
  });
});

describe("画像ツール", () => {
  const event = (x: number, y: number): CanvasPointerEvent => ({
    page: { x, y },
    screen: { x, y },
    button: 0,
    clickCount: 1,
    shift: false,
    alt: false,
    mod: false,
  });

  it("クリックでファイル選択を開き、押した位置を中心に置いて選択ツールへ戻る", async () => {
    const { store, s, selected } = setup();
    let resolve!: () => void;
    const done = new Promise<void>((r) => {
      resolve = r;
    });
    setImportFileReader(async () => {
      setTimeout(resolve, 0);
      return svg;
    });
    store.getState().setTool("image");
    const ctx: ToolContext = { store, measurer: fixedWidthMeasurer(), setCursor: vi.fn() };
    imageTool.onPointerDown?.(event(1500, 1500), ctx);
    // ファイル選択でフォーカスが外れて onCancel が呼ばれても取込は続く
    imageTool.onPointerUp?.(event(1500, 1500), ctx);
    imageTool.onCancel?.(ctx);
    await done;
    await vi.waitFor(() => expect(s().toolId).toBe("select"));
    expect(selected()).toMatchObject({ type: "svg", x: 1400, y: 1450 });
  });

  it("取込の途中にもう一度クリックしても、ファイル選択を二重に開かない", async () => {
    const { store, s } = setup();
    const file = deferred<ImportedFile | null>();
    const reader = vi.fn(() => file.promise);
    setImportFileReader(reader);
    store.getState().setTool("image");
    const ctx: ToolContext = { store, measurer: fixedWidthMeasurer(), setCursor: vi.fn() };
    imageTool.onPointerDown?.(event(1500, 1500), ctx);
    imageTool.onPointerUp?.(event(1500, 1500), ctx);
    expect(s().toolId).toBe("image");
    imageTool.onPointerDown?.(event(1200, 1200), ctx);
    imageTool.onPointerUp?.(event(1200, 1200), ctx);
    expect(reader).toHaveBeenCalledTimes(1);
    expect(getImportStatus().notice?.message).toContain("取り込んでいる途中");
    file.resolve(svg);
    await vi.waitFor(() => expect(s().toolId).toBe("select"));
    expect(s().revision).toBe(1);
    expect(s().doc.nodes[s().selection[0] ?? ""]).toMatchObject({ x: 1400, y: 1450 });
  });

  it("取り消しても選択ツールへ戻る", async () => {
    const { store, s } = setup();
    setImportFileReader(async () => null);
    store.getState().setTool("image");
    const ctx: ToolContext = { store, measurer: fixedWidthMeasurer(), setCursor: vi.fn() };
    imageTool.onPointerDown?.(event(1500, 1500), ctx);
    imageTool.onPointerUp?.(event(1500, 1500), ctx);
    await vi.waitFor(() => expect(s().toolId).toBe("select"));
    expect(s().revision).toBe(0);
  });
});
