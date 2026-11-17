import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { addAsset } from "./assets";
import {
  BOOLEAN_OP_NAMES,
  createBoolean,
  createEllipse,
  createEmptyDocument,
  createFrame,
  createLine,
  createPath,
  createRect,
  createStroke,
  createText,
  FIRST_PAGE_ID,
} from "./create";
import { pathBounds } from "../path/measure";
import { createId, ID_LENGTH } from "./ids";
import { CANVAS_LIMITS, NODE_ID_PATTERN } from "./limits";
import { checkSavable, fromPayload, PAYLOAD_VERSION, parsePayload, toPayload } from "./payload";
import { insertNode } from "./structure";
import { fixturePayload } from "./testing";
import { validatePayload } from "./validate";

describe("ID", () => {
  it("idPattern に合う 12 文字で、既存の ID を避ける", () => {
    const id = createId();
    expect(id).toHaveLength(ID_LENGTH);
    expect(NODE_ID_PATTERN.test(id)).toBe(true);
    expect(new Set(Array.from({ length: 1000 }, () => createId())).size).toBe(1000);
  });
});

describe("payload との変換", () => {
  it("空の文書は契約データの empty と同じになる", () => {
    expect(toPayload(createEmptyDocument())).toEqual(fixturePayload("empty"));
  });

  it("作った文書が検証を通る", () => {
    let doc = createEmptyDocument();
    doc = insertNode(doc, createFrame({ name: "画面", width: 393, height: 852 }), {
      kind: "page",
      id: FIRST_PAGE_ID,
    });
    doc = insertNode(doc, createText({ text: "こんにちは 世界" }), {
      kind: "page",
      id: FIRST_PAGE_ID,
    });
    const payload = toPayload(doc);
    expect(payload.text).toBe("画面 こんにちは 世界");
    expect(validatePayload(payload)).toBeNull();
    expect(checkSavable(doc)).toBeNull();
  });

  it("保存の前に参照されないアセットを落とす", () => {
    const { doc } = addAsset(createEmptyDocument(), {
      kind: "image",
      mime: "image/png",
      data: "AAAA",
      width: 1,
      height: 1,
    });
    expect(toPayload(doc).assets).toEqual({});
  });

  it("読み込みは検証してから文書にする", () => {
    const payload = fixturePayload("full");
    const ok = parsePayload(payload);
    expect(ok.ok && ok.doc).toEqual(fromPayload(payload));
    const bad = parsePayload({ ...payload, text: "x" });
    expect(bad).toEqual({ ok: false, error: expect.stringMatching(/^text: /) });
  });

  it("検索用テキストが上限を超える文書は保存できない", () => {
    let doc = createEmptyDocument();
    const text = "あ".repeat(CANVAS_LIMITS.maxTextLength);
    // 1 個 300,000 バイト。4 個で 1 MiB を超える
    for (let i = 0; i < 4; i++)
      doc = insertNode(doc, createText({ text }), { kind: "page", id: FIRST_PAGE_ID });
    expect(checkSavable(doc)).toMatch(/^text: /);
  });
});

describe("v3 の作成の既定値 (§8.3)", () => {
  const curve = [
    {
      closed: false,
      points: [
        { x: 0, y: 10, in: null, out: { x: 10, y: -20 }, mirror: "none" as const },
        { x: 40, y: 10, in: { x: -10, y: -20 }, out: null, mirror: "none" as const },
      ],
    },
  ];

  it("箱を持つノードは回転 0、線は端なし・マイター・実線", () => {
    expect(createRect().rotation).toBe(0);
    expect(createFrame().rotation).toBe(0);
    expect(createStroke()).toEqual({
      color: "#000000",
      opacity: 1,
      width: 1,
      cap: "butt",
      join: "miter",
      dash: [],
    });
  });

  it("パスの箱は曲線の範囲 (ハンドルの先は含めない)。既定はペンと同じ見た目", () => {
    const path = createPath(curve);
    // 曲線の上端は y = 10 - 15 = -5。点をその分下げ、箱の y に足す
    expect(path).toMatchObject({ x: 0, width: 40, rotation: 0, fillRule: "nonzero" });
    expect(path.y).toBeCloseTo(-5, 10);
    expect(path.height).toBeCloseTo(15, 10);
    expect(path).toMatchObject({ fill: null, stroke: createStroke(), shadow: null, name: "パス" });
    expect(path.subpaths[0]?.points.map((p) => p.y)).toEqual([
      expect.closeTo(15, 10),
      expect.closeTo(15, 10),
    ]);
    // ハンドルは点からの相対なので変えない。渡した点の形を共有しない
    expect(path.subpaths[0]?.points[0]?.out).toEqual({ x: 10, y: -20 });
    expect(path.subpaths[0]).not.toBe(curve[0]);
  });

  it("パスの点は範囲の左上が (0, 0) になるよう動かし、その分を x / y に足す (§8.6)", () => {
    const corner = (x: number, y: number) => ({
      x,
      y,
      in: null,
      out: null,
      mirror: "none" as const,
    });
    const square = [
      {
        closed: true,
        points: [corner(50, 50), corner(150, 50), corner(150, 150), corner(50, 150)],
      },
    ];
    const path = createPath(square);
    expect(path).toMatchObject({ x: 50, y: 50, width: 100, height: 100 });
    expect(path.subpaths[0]?.points.map((p) => [p.x, p.y])).toEqual([
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
    ]);
    // init の x / y は点の座標系の原点の位置
    expect(createPath(square, { x: 10, y: -20 })).toMatchObject({ x: 60, y: 30 });
    expect(pathBounds(path.subpaths)).toEqual({ minX: 0, minY: 0, maxX: 100, maxY: 100 });
  });

  it("ブーリアンの名前は演算の名前", () => {
    expect(createBoolean("exclude", ["a"]).name).toBe(BOOLEAN_OP_NAMES.exclude);
    expect(createBoolean("subtract", ["a"], { name: "穴" })).toMatchObject({
      name: "穴",
      op: "subtract",
      children: ["a"],
    });
  });

  it("作ったパスとブーリアンを含む文書が検証を通る", () => {
    let doc = createEmptyDocument();
    const page = { kind: "page" as const, id: FIRST_PAGE_ID };
    doc = insertNode(doc, createLine({ id: "l" }), page);
    doc = insertNode(doc, createPath(curve, { id: "p" }), page);
    const rect = createRect({ id: "r" });
    const ellipse = createEllipse({ id: "e" });
    doc = {
      ...doc,
      pages: doc.pages.map((p) => ({ ...p, children: [...p.children, "b"] })),
      nodes: {
        ...doc.nodes,
        r: rect,
        e: ellipse,
        b: createBoolean("union", ["r", "e"], { id: "b" }),
      },
    };
    expect(checkSavable(doc)).toBeNull();
  });

  it("保存する版は 3 で、Rust の CURRENT_PAYLOAD_VERSION と同じ", () => {
    expect(PAYLOAD_VERSION).toBe(3);
    const rust = readFileSync(
      resolve(process.cwd(), "src-tauri/src/modules/vector/mod.rs"),
      "utf8",
    );
    expect(rust).toMatch(new RegExp(`const CURRENT_PAYLOAD_VERSION: u32 = ${PAYLOAD_VERSION};`));
  });
});
