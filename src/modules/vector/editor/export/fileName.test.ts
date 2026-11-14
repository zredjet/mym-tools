import { describe, expect, it } from "vitest";

import { MAX_FILE_STEM_LENGTH, sanitizeFileStem, uniqueFileNames } from "./fileName";

describe("sanitizeFileStem", () => {
  it("ファイル名に使えない文字と制御文字を _ に置き換える", () => {
    expect(sanitizeFileStem('a\\b/c:d*e?f"g<h>i|j')).toBe("a_b_c_d_e_f_g_h_i_j");
    expect(sanitizeFileStem("a\u0000b\u001fc\u007fd\u009fe")).toBe("a_b_c_d_e");
  });

  it("空白をまとめ、前後の空白とピリオドを除く", () => {
    expect(sanitizeFileStem("  表紙\t\n画像  ")).toBe("表紙 画像");
    expect(sanitizeFileStem("..hidden..")).toBe("hidden");
  });

  it("空になれば既定の名前", () => {
    expect(sanitizeFileStem("")).toBe("canvas");
    expect(sanitizeFileStem(" . ")).toBe("canvas");
    expect(sanitizeFileStem("", "ページ")).toBe("ページ");
  });

  it("Windows の予約名には _ を付ける", () => {
    expect(sanitizeFileStem("CON")).toBe("_CON");
    expect(sanitizeFileStem("com1")).toBe("_com1");
    expect(sanitizeFileStem("console")).toBe("console");
    // 最初のピリオドより前が予約名なら、拡張子のようなものが付いていても置き換える
    expect(sanitizeFileStem("nul.tar")).toBe("_nul.tar");
    expect(sanitizeFileStem("aux.v2")).toBe("_aux.v2");
    expect(sanitizeFileStem("LPT1.backup")).toBe("_LPT1.backup");
    expect(sanitizeFileStem("con .txt")).toBe("_con .txt");
    expect(sanitizeFileStem("COM\u00b9")).toBe("_COM\u00b9");
    expect(sanitizeFileStem("auxiliary.v2")).toBe("auxiliary.v2");
    expect(sanitizeFileStem("my.nul")).toBe("my.nul");
  });

  it("対になっていないサロゲートを置き換え、正しい組は残す", () => {
    expect(sanitizeFileStem("a\uD800b\uDC00\uDC00c😀")).toBe("a_b__c😀");
  });

  it("長すぎる名前はコードポイントで切る", () => {
    const stem = sanitizeFileStem("😀".repeat(MAX_FILE_STEM_LENGTH + 10));
    expect(Array.from(stem)).toHaveLength(MAX_FILE_STEM_LENGTH);
  });
});

describe("uniqueFileNames", () => {
  it("拡張子を付け、重なった名前に番号を付ける (大文字と小文字は区別しない)", () => {
    expect(uniqueFileNames(["表紙", "表紙", "Cover", "cover", "表紙"], "png")).toEqual([
      "表紙.png",
      "表紙 (2).png",
      "Cover.png",
      "cover (2).png",
      "表紙 (3).png",
    ]);
  });

  it("付けた番号がほかの名前と重なれば次の番号にする", () => {
    expect(uniqueFileNames(["a", "a", "a (2)"], "svg")).toEqual([
      "a.svg",
      "a (3).svg",
      "a (2).svg",
    ]);
  });

  it("NFC にそろえてから比べ、ファイル名も NFC にする", () => {
    const nfd = "か\u3099"; // 「か」+ 結合用の濁点
    const nfc = "が";
    expect(nfd).not.toBe(nfc);
    expect(uniqueFileNames([nfc, nfd], "png")).toEqual(["が.png", "が (2).png"]);
    expect(uniqueFileNames([nfd], "svg")).toEqual(["が.svg"]);
  });

  it("置き換えた結果で比べる", () => {
    expect(uniqueFileNames(["a/b", "a:b", ""], "svg")).toEqual([
      "a_b.svg",
      "a_b (2).svg",
      "canvas.svg",
    ]);
  });
});
