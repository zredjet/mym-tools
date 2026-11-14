import { describe, expect, it, vi } from "vitest";
import {
  createFontDetector,
  FONT_CANDIDATES,
  isGenericFamily,
  probeFontAvailable,
  type FontProbe,
} from "./fonts";

/**
 * 決まったフォントだけがある PC の代わり。指定の先頭のフォントがあればその幅、
 * なければ総称フォントの幅を返す (ブラウザの代替と同じ)。
 */
function fakeProbe(installed: Record<string, number>): FontProbe {
  const generic: Record<string, number> = { "sans-serif": 100, serif: 110, monospace: 120 };
  return (font) => {
    const families = font.replace(/^\d+px /, "").split(/,\s*/);
    for (const raw of families) {
      const name = raw.replace(/^"|"$/g, "");
      if (name in installed) return installed[name] ?? null;
      if (name in generic) return generic[name] ?? null;
    }
    return null;
  };
}

describe("probeFontAvailable", () => {
  it("先頭に置いたときに総称フォントだけのときと幅が違えば、ある", () => {
    const probe = fakeProbe({ Arial: 101 });
    expect(probeFontAvailable("Arial", probe)).toBe(true);
    expect(probeFontAvailable("Nothing", probe)).toBe(false);
    expect(probeFontAvailable(" Arial ", probe)).toBe(true);
    expect(probeFontAvailable("", probe)).toBe(false);
  });

  it("総称フォントの実体と同じフォントでも、ほかの総称フォントとの比較で見つける", () => {
    // sans-serif の実体が Helvetica の PC
    const probe = fakeProbe({ Helvetica: 100 });
    expect(probeFontAvailable("Helvetica", probe)).toBe(true);
  });

  it("総称フォントは常にある", () => {
    const probe = vi.fn<FontProbe>(() => 1);
    expect(probeFontAvailable("sans-serif", probe)).toBe(true);
    expect(probeFontAvailable("system-ui", probe)).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });

  it("測れない環境ではあるとみなす (誤って注意を出さない)", () => {
    expect(probeFontAvailable("Arial", () => null)).toBe(true);
  });

  it("名前の引用符や \\ を壊さずに指定する", () => {
    const fonts: string[] = [];
    probeFontAvailable('My "Font"', (font) => {
      fonts.push(font);
      return 1;
    });
    expect(fonts).toContain('72px "My \\"Font\\"", sans-serif');
  });
});

describe("createFontDetector", () => {
  it("候補のうちあるものだけを、グループの形で返す", () => {
    const detector = createFontDetector(fakeProbe({ "Hiragino Sans": 90, Arial: 101 }));
    expect(detector.availableGroups()).toEqual([
      { label: "和文", families: ["Hiragino Sans"] },
      { label: "欧文", families: ["Arial"] },
      { label: "総称", families: ["sans-serif", "serif", "monospace", "system-ui"] },
    ]);
  });

  it("既定は Hiragino Sans、なければ Yu Gothic UI、どちらもなければ sans-serif", () => {
    expect(createFontDetector(fakeProbe({ "Hiragino Sans": 90 })).defaultFamily()).toBe(
      "Hiragino Sans",
    );
    expect(createFontDetector(fakeProbe({ "Yu Gothic UI": 90 })).defaultFamily()).toBe(
      "Yu Gothic UI",
    );
    expect(createFontDetector(fakeProbe({})).defaultFamily()).toBe("sans-serif");
  });

  it("同じフォントは 1 回だけ測る (大文字小文字と前後の空白は同じとみなす)", () => {
    const probe = vi.fn(fakeProbe({ Arial: 101 }));
    const detector = createFontDetector(probe);
    expect(detector.isAvailable("Arial")).toBe(true);
    const calls = probe.mock.calls.length;
    expect(detector.isAvailable(" arial")).toBe(true);
    expect(probe.mock.calls.length).toBe(calls);
  });
});

describe("候補と総称フォント", () => {
  it("候補は §5.7 の 27 個", () => {
    expect(FONT_CANDIDATES.flatMap((group) => group.families)).toHaveLength(27);
  });

  it("総称フォントの判定は描画と同じ", () => {
    expect(isGenericFamily("sans-serif")).toBe(true);
    expect(isGenericFamily("Monospace")).toBe(true);
    expect(isGenericFamily("Arial")).toBe(false);
  });
});
