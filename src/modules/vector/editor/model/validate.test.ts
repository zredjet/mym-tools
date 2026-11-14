import { describe, expect, it } from "vitest";
import fixtures from "./fixtures/payload-v2.json";
import { fromPayload, toPayload } from "./payload";
import { computeSearchText } from "./searchText";
import { fixturePayload } from "./testing";
import type { VectorPayloadV2 } from "./types";
import { CANVAS_LIMITS } from "./limits";
import { checkSavable } from "./payload";
import { createFrame, createText } from "./create";
import { hasLoneSurrogate, isCanonicalBase64, validatePayload } from "./validate";

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

  // Rust の base64 0.22 `STANDARD` で確かめた合否 (PR #165 の検証が使う)
  it.each([
    ["/9j/4A==", true], // FF D8 FF E0
    ["/9j/4B==", false], // 最後の文字の使わないビットが 0 でない
    ["/9j/4EE=", true], // FF D8 FF E0 41
    ["/9j/4EF=", false],
    ["/9j/4A", false], // パディングなし
    ["/9j/4A=", false],
    ["/9j/4A===", false],
    ["/9j/ 4A==", false], // 空白
    ["_9j-4A==", false], // URL 用の字母
    ["", false],
  ])("base64 %j の合否は Rust と同じ (%s)", (data, ok) => {
    const payload = full();
    payload["assets"].img1.mime = "image/jpeg";
    payload["assets"].img1.data = data;
    if (ok) expect(validatePayload(payload)).toBeNull();
    else expect(validatePayload(payload)).toMatch(/^assets\.img1\.data: /);
  });

  it("アセットの width / height は 0 より大きく maxSize 以下 (§3.4)", () => {
    const payload = full();
    payload["assets"].img1.width = 0;
    expect(validatePayload(payload)).toMatch(/img1\.width/);
    payload["assets"].img1.width = CANVAS_LIMITS.maxSize;
    expect(validatePayload(payload)).toBeNull();
    payload["assets"].img1.width = CANVAS_LIMITS.maxSize + 1;
    expect(validatePayload(payload)).toMatch(/img1\.width/);
    payload["assets"].img1.width = 0.5;
    payload["assets"].svgA.height = 0;
    expect(validatePayload(payload)).toMatch(/svgA\.height/);
  });

  it("20 MiB の base64 でも正しく判定する (入れ子の繰り返しの正規表現を使わない)", () => {
    const length = 20 * 1024 * 1024;
    const big = "/9j/" + "A".repeat(length - 4);
    expect(isCanonicalBase64(big)).toBe(true);
    expect(isCanonicalBase64(big.slice(0, -2) + "B=")).toBe(false); // 使わないビットが 0 でない
    expect(isCanonicalBase64(big.slice(0, -1))).toBe(false); // 長さが 4 の倍数でない
    expect(isCanonicalBase64(big.slice(0, -4) + "A=A=")).toBe(false);

    // payload 全体の上限ぎりぎりの JPEG を通す
    const payload = full();
    const svgBytes = new TextEncoder().encode(payload["assets"].svgA.svg).length;
    const room = CANVAS_LIMITS.payloadBytes - svgBytes;
    payload["assets"].img1.mime = "image/jpeg";
    payload["assets"].img1.data = "/9j/" + "A".repeat(room - (room % 4) - 4);
    expect(validatePayload(payload)).toBeNull();
  });

  it("すべての文字列で、対になっていないサロゲートを拒否する", () => {
    expect(hasLoneSurrogate("a😀b")).toBe(false);
    expect(hasLoneSurrogate("\ud800")).toBe(true);
    expect(hasLoneSurrogate("a\udc00")).toBe(true);
    expect(hasLoneSurrogate("\ud83d\ud83d")).toBe(true);
    const cases: [(p: ReturnType<typeof full>) => void, RegExp][] = [
      [(p) => (p["nodes"].rect1.name = "a\ud800"), /rect1\.name/],
      [(p) => (p["nodes"].text1.fontFamily = "\udc00Arial"), /text1\.fontFamily/],
      [(p) => (p["pages"][0].name = "\ud800"), /pages\[0\]\.name/],
      [(p) => (p["assets"].svgA.text = "\ud800"), /svgA\.text/],
      [(p) => (p["text"] = p["text"] + "\ud800"), /^text: /],
      [(p) => (p["nodes"].text1.text = "見出し\ud800"), /text1\.text/],
    ];
    for (const [patch, pattern] of cases) {
      const payload = full();
      patch(payload);
      expect(validatePayload(payload)).toMatch(pattern);
    }
  });

  it("__proto__ をノード・ページ・アセットの ID に使えない", () => {
    const base = JSON.stringify(fixturePayload("full"));
    for (const name of ["svg1", "page2", "img1"]) {
      const payload: unknown = JSON.parse(base.split(`"${name}"`).join('"__proto__"'));
      expect(validatePayload(payload)).toMatch(/__proto__/);
    }
  });

  it("全テキストの本文の合計は UTF-8 で maxTotalTextBytes 以下", () => {
    // 空白だけの本文は検索用テキストに入らないので、合計の上限だけで止まる
    const text = "\u3000".repeat(CANVAS_LIMITS.maxTextLength); // 300,000 バイト
    const make = (count: number) => {
      const ids = Array.from({ length: count }, (_, i) => `t${i}`);
      return {
        pages: [{ id: "p", name: "", children: ids, guides: [] }],
        nodes: Object.fromEntries(ids.map((id) => [id, createText({ id, text })])),
        assets: {},
        text: "",
      };
    };
    const fits = Math.floor(CANVAS_LIMITS.maxTotalTextBytes / 300_000);
    expect(validatePayload(make(fits))).toBeNull();
    expect(validatePayload(make(fits + 1))).toMatch(/本文の合計/);
  });

  it("壊れた文書 (frame が互いを子に持つ) でも checkSavable は例外にならない", () => {
    const doc = {
      pages: [{ id: "p", name: "", children: ["a"], guides: [] }],
      nodes: {
        a: createFrame({ id: "a", children: ["b"] }),
        b: createFrame({ id: "b", children: ["a"] }),
      },
      assets: {},
    };
    expect(checkSavable(doc)).toMatch(/2 回以上/);
  });
});
