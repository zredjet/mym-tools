import { describe, expect, it } from "vitest";
import fixtures from "./fixtures/payload-v2.json";
import { fromPayload, toPayload } from "./payload";
import { computeSearchText } from "./searchText";
import { fixturePayload } from "./testing";
import type { VectorPayloadV2 } from "./types";
import { validatePayload } from "./validate";

type Path = (string | number)[];
interface PatchOp {
  op: string;
  path: Path;
  value?: unknown;
}

/** 契約データの patch を当てる (op は set / remove / append)。 */
function applyPatch(base: unknown, patch: PatchOp[]): unknown {
  const root = structuredClone(base) as Record<string | number, unknown>;
  for (const { op, path, value } of patch) {
    const parentPath = path.slice(0, -1);
    const last = path[path.length - 1] as string | number;
    let target = root as Record<string | number, unknown>;
    for (const key of parentPath) target = target[key] as Record<string | number, unknown>;
    if (op === "set") target[last] = structuredClone(value);
    else if (op === "remove") {
      if (Array.isArray(target)) target.splice(Number(last), 1);
      else delete target[last];
    } else if (op === "append") (target[last] as unknown[]).push(structuredClone(value));
    else throw new Error(`unknown op: ${op}`);
  }
  return root;
}

describe("payload v2 の契約データ", () => {
  for (const { name, payload } of fixtures.valid)
    it(`valid: ${name} は検証を通り、検索用テキストが一致する`, () => {
      expect(validatePayload(payload)).toBeNull();
      const doc = fromPayload(payload as unknown as VectorPayloadV2);
      expect(computeSearchText(doc)).toBe(payload.text);
      expect(toPayload(doc)).toEqual(payload);
    });

  for (const { name, reason, base, patch } of fixtures.invalid)
    it(`invalid: ${name} (${reason}) を拒否する`, () => {
      const payload = applyPatch(fixturePayload(base), patch as PatchOp[]);
      const error = validatePayload(payload);
      expect(error).toEqual(expect.any(String));
      if (process.env["SHOW_REASONS"]) console.log(name, "=>", error);
    });

  for (const { name, v2 } of fixtures.upgrade)
    it(`upgrade: ${name} の v2 は検証を通る`, () => {
      expect(validatePayload(v2)).toBeNull();
    });
});

describe("validatePayload の個別の規則", () => {
  const full = () => fixturePayload("full") as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

  it("理由にはどこが違うかを含める", () => {
    const payload = full();
    payload["nodes"].rect1.opacity = 2;
    expect(validatePayload(payload)).toMatch(/^nodes\.rect1\.opacity: /);
  });

  it("オブジェクトでない値を拒否する", () => {
    expect(validatePayload(null)).not.toBeNull();
    expect(validatePayload([])).not.toBeNull();
    expect(validatePayload("x")).not.toBeNull();
  });

  it("NaN や Infinity を拒否する", () => {
    const payload = full();
    payload["nodes"].rect1.x = Number.POSITIVE_INFINITY;
    expect(validatePayload(payload)).toMatch(/rect1\.x/);
  });

  it("名前はコードポイントで数える", () => {
    const payload = full();
    payload["nodes"].rect1.name = "😀".repeat(200);
    expect(validatePayload(payload)).toBeNull();
    payload["nodes"].rect1.name = "😀".repeat(201);
    expect(validatePayload(payload)).toMatch(/rect1\.name/);
  });

  it("fontFamily の制御文字と空文字を拒否する", () => {
    const payload = full();
    payload["nodes"].text1.fontFamily = "";
    expect(validatePayload(payload)).toMatch(/fontFamily/);
    payload["nodes"].text1.fontFamily = "Ari\u0085al";
    expect(validatePayload(payload)).toMatch(/fontFamily/);
  });

  it("line の stroke は null にできない", () => {
    const payload = full();
    payload["nodes"].line1.stroke = null;
    expect(validatePayload(payload)).toMatch(/line1\.stroke/);
  });

  it("深さの上限を確かめる", () => {
    const payload = full();
    // frame2 の下に 32 段の frame をつなげると、ページ直下の frame2 を含めて深さ 33
    let parent = payload["nodes"].frame2;
    for (let i = 0; i < 32; i++) {
      const id = `deep${i}`;
      payload["nodes"][id] = { ...structuredClone(payload["nodes"].frame2), id, children: [] };
      parent.children = [id];
      parent = payload["nodes"][id];
    }
    expect(validatePayload(payload)).toMatch(/深さ/);
    // 1 段減らすと通る
    payload["nodes"].deep30.children = [];
    delete payload["nodes"].deep31;
    payload["text"] = computeSearchText(fromPayload(payload as unknown as VectorPayloadV2));
    expect(validatePayload(payload)).toBeNull();
  });

  it("PNG の 1 辺の上限を確かめる", () => {
    const payload = full();
    const bytes = Uint8Array.from(atob(payload["assets"].img1.data), (c) => c.charCodeAt(0));
    new DataView(bytes.buffer).setUint32(16, 16385);
    payload["assets"].img1.data = btoa(String.fromCharCode(...bytes));
    expect(validatePayload(payload)).toMatch(/img1\.data/);
  });

  it("JPEG と WebP の先頭バイトを確かめる", () => {
    const payload = full();
    payload["assets"].img1.mime = "image/jpeg";
    payload["assets"].img1.data = btoa("\xff\xd8\xff\xe0abcd");
    expect(validatePayload(payload)).toBeNull();
    payload["assets"].img1.mime = "image/webp";
    expect(validatePayload(payload)).toMatch(/img1\.data/);
    payload["assets"].img1.data = btoa("RIFF\0\0\0\0WEBPVP8 ");
    expect(validatePayload(payload)).toBeNull();
  });

  it("base64 でない画像を拒否する", () => {
    const payload = full();
    payload["assets"].img1.data = "iVBORw0KGgo!";
    expect(validatePayload(payload)).toMatch(/base64/);
  });
});
