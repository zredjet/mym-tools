import { afterEach, describe, expect, it, vi } from "vitest";
import { vectorReadFile, vectorReadImage, vectorWriteFile } from "@/ipc/vector";
import {
  describeInvokeError,
  dropPointOnCanvas,
  fileStem,
  pickImportFile,
  readImportPath,
  siblingPath,
  writeExportFiles,
} from "./canvasIo";

const dialog = vi.hoisted(() => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => dialog);
vi.mock("@/ipc/vector", () => ({
  vectorReadFile: vi.fn(),
  vectorReadImage: vi.fn(),
  vectorWriteFile: vi.fn(),
}));

const validation = (reason: string) => ({
  code: "validation",
  message: { module_id: "vector", reason },
});

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("describeInvokeError", () => {
  it("Rust の AppError からは理由だけを取り出す", () => {
    expect(describeInvokeError(validation("PNG/JPEG/WebPを選択してください。"))).toBe(
      "PNG/JPEG/WebPを選択してください。",
    );
    expect(describeInvokeError(new Error("壊れた"))).toBe("壊れた");
    expect(describeInvokeError({ code: "io", message: "disk full" })).toBe("[io] disk full");
  });
});

describe("パスの扱い", () => {
  it("拡張子を除いたファイル名を、/ と \\ のどちらの区切りでも取り出す", () => {
    expect(fileStem("/Users/a/写真.final.PNG")).toBe("写真.final");
    expect(fileStem("C:\\Users\\a\\図.svg")).toBe("図");
    expect(fileStem("/tmp/.hidden")).toBe(".hidden");
    expect(fileStem("名前なし")).toBe("名前なし");
  });
  it("直前に選んだファイルと同じフォルダの path を作る", () => {
    expect(siblingPath("/out/a.svg", "b.svg")).toBe("/out/b.svg");
    expect(siblingPath("C:\\out\\a.png", "b.png")).toBe("C:\\out\\b.png");
    expect(siblingPath("a.svg", "b.svg")).toBe("b.svg");
  });
});

describe("取込のファイルを読む", () => {
  it("SVG は vector_read_file、画像は vector_read_image で読む", async () => {
    vi.mocked(vectorReadFile).mockResolvedValueOnce({
      svg: "<svg/>",
      text: "文字",
      notices: ["draw.io の SVG を変換しました。"],
    });
    await expect(readImportPath("/tmp/図.SVG")).resolves.toEqual({
      kind: "svg",
      svg: "<svg/>",
      text: "文字",
      notices: ["draw.io の SVG を変換しました。"],
      name: "図",
    });
    vi.mocked(vectorReadImage).mockResolvedValueOnce("data:image/png;base64,AAAA");
    await expect(readImportPath("/tmp/写真.png")).resolves.toEqual({
      kind: "image",
      dataUrl: "data:image/png;base64,AAAA",
      name: "写真",
    });
  });
  it("読めなければ Rust の理由を持つ Error を投げる (エディタがそのまま表示する)", async () => {
    vi.mocked(vectorReadImage).mockRejectedValueOnce(
      validation("画像の形式と内容が一致しません。"),
    );
    await expect(readImportPath("/tmp/x.png")).rejects.toThrow("画像の形式と内容が一致しません。");
  });
  it("ファイル選択は画像と SVG を受け、取り消したら null を返す", async () => {
    dialog.open.mockResolvedValueOnce(null);
    await expect(pickImportFile()).resolves.toBeNull();
    expect(dialog.open).toHaveBeenCalledWith(
      expect.objectContaining({
        multiple: false,
        filters: [{ name: "画像・SVG", extensions: ["png", "jpg", "jpeg", "webp", "svg"] }],
      }),
    );
    dialog.open.mockResolvedValueOnce("/tmp/a.webp");
    vi.mocked(vectorReadImage).mockResolvedValueOnce("data:image/webp;base64,AAAA");
    await expect(pickImportFile()).resolves.toMatchObject({ kind: "image", name: "a" });
  });
});

describe("書き出したファイルを保存する", () => {
  const files = [
    { fileName: "フレーム 1.svg", format: "svg" as const, data: "<svg/>" },
    { fileName: "フレーム 2.svg", format: "svg" as const, data: "<svg></svg>" },
    { fileName: "フレーム 3.svg", format: "svg" as const, data: "<svg> </svg>" },
  ];

  it("1 つずつ保存ダイアログを出し、2 つ目からは直前のフォルダを既定にする", async () => {
    dialog.save
      .mockResolvedValueOnce("/out/フレーム 1.svg")
      .mockResolvedValueOnce("/out/別名.svg")
      .mockResolvedValueOnce("/out/フレーム 3.svg");
    await expect(writeExportFiles(files)).resolves.toEqual({ written: 3 });
    expect(dialog.save.mock.calls.map(([options]) => options.defaultPath)).toEqual([
      "フレーム 1.svg",
      "/out/フレーム 2.svg",
      "/out/フレーム 3.svg",
    ]);
    expect(dialog.save.mock.calls[0]![0].filters).toEqual([{ name: "SVG", extensions: ["svg"] }]);
    expect(vi.mocked(vectorWriteFile).mock.calls).toEqual([
      ["/out/フレーム 1.svg", "svg", "<svg/>"],
      ["/out/別名.svg", "svg", "<svg></svg>"],
      ["/out/フレーム 3.svg", "svg", "<svg> </svg>"],
    ]);
  });
  it("取り消したら、そこで止めて書いた数を返す", async () => {
    dialog.save.mockResolvedValueOnce("/out/a.svg").mockResolvedValueOnce(null);
    await expect(writeExportFiles(files)).resolves.toEqual({ written: 1 });
    expect(vectorWriteFile).toHaveBeenCalledTimes(1);
    expect(dialog.save).toHaveBeenCalledTimes(2);
  });
  it("書き込めなければ Rust の理由で失敗する", async () => {
    dialog.save.mockResolvedValueOnce("/out/a.png");
    vi.mocked(vectorWriteFile).mockRejectedValueOnce(validation("PNGデータが不正です。"));
    await expect(
      writeExportFiles([{ fileName: "a.png", format: "png", data: "data:image/png;base64," }]),
    ).rejects.toThrow("PNGデータが不正です。");
  });
});

describe("OS からのドロップの位置", () => {
  function canvasAt(left: number, top: number, width: number, height: number) {
    const canvas = document.createElement("div");
    canvas.setAttribute("data-canvas-view", "");
    canvas.getBoundingClientRect = () =>
      ({ left, top, width, height, right: left + width, bottom: top + height }) as DOMRect;
    document.body.append(canvas);
  }

  it("物理 px をキャンバスの画面座標にし、ページ座標へ直す", () => {
    canvasAt(100, 50, 400, 300);
    // devicePixelRatio 2 で (300, 200) は CSS px で (150, 100)。キャンバスの中で (50, 50)
    expect(dropPointOnCanvas({ x: 300, y: 200 }, { x: 10, y: 20, zoom: 2 }, document, 2)).toEqual({
      x: 35,
      y: 45,
    });
  });
  it("キャンバスの外やキャンバスがないときは null", () => {
    expect(dropPointOnCanvas({ x: 0, y: 0 }, { x: 0, y: 0, zoom: 1 }, document, 1)).toBeNull();
    canvasAt(100, 50, 400, 300);
    expect(dropPointOnCanvas({ x: 20, y: 60 }, { x: 0, y: 0, zoom: 1 }, document, 1)).toBeNull();
  });
});
