/**
 * フォントの候補とその PC にあるかの判定 (§4.7 / §5.7)。フォントは同梱しない。
 *
 * あるかどうかは、そのフォントを先頭に置いたときと総称フォントだけのときの幅を比べて判定する
 * (`document.fonts.check` はシステムフォントの有無を返さないので使わない)。比べる総称フォントは
 * 3 つ (sans-serif、serif、monospace) で、どれか 1 つでも幅が違えばあるとみなす
 * (調べるフォントが総称フォントの実体と同じ場合にも取りこぼさないため)。
 */
import { cssFontFamily } from "../render/buildNodeSvg";
import { createMeasureContext } from "../render/measureText";

export interface FontGroup {
  label: string;
  families: readonly string[];
}

/** 候補 (§5.7)。一覧の並び順もこのとおり。 */
export const FONT_CANDIDATES: readonly FontGroup[] = [
  {
    label: "和文",
    families: [
      "Hiragino Sans",
      "Hiragino Kaku Gothic ProN",
      "Hiragino Mincho ProN",
      "Hiragino Maru Gothic ProN",
      "Yu Gothic",
      "Yu Gothic UI",
      "Yu Mincho",
      "Meiryo",
      "BIZ UDPGothic",
      "BIZ UDGothic",
      "BIZ UDMincho",
      "MS Gothic",
      "MS PGothic",
      "MS Mincho",
    ],
  },
  {
    label: "欧文",
    families: [
      "Helvetica Neue",
      "Arial",
      "Segoe UI",
      "Verdana",
      "Georgia",
      "Times New Roman",
      "Menlo",
      "Consolas",
      "Courier New",
    ],
  },
  { label: "総称", families: ["sans-serif", "serif", "monospace", "system-ui"] },
];

/** 新しいテキストの既定の候補。先にあるものを使い、どれもなければ `sans-serif` (§5.7)。 */
export const DEFAULT_FONT_PREFERENCE = ["Hiragino Sans", "Yu Gothic UI"] as const;
export const FALLBACK_FONT_FAMILY = "sans-serif";

/** 総称フォントか (CSS で引用符を付けずに書くもの)。描画と同じ判定 (`cssFontFamily`) を使う。 */
export function isGenericFamily(family: string): boolean {
  return cssFontFamily(family) === family.trim();
}

/** フォントを指定した文字列の幅を測る。測れない環境では null。 */
export type FontProbe = (font: string, text: string) => number | null;

const PROBE_TEXT = "mmmmmmmmmmlli1WW@#あ永アｱ";
const PROBE_SIZE = 72;
const BASES = ["sans-serif", "serif", "monospace"] as const;

/** canvas で測る (キャンバスの計測とは別の canvas を使う)。jsdom では null を返す。 */
export function createCanvasProbe(): FontProbe {
  const getContext = createMeasureContext();
  return (font, text) => {
    const ctx = getContext();
    if (!ctx) return null;
    ctx.font = font;
    return ctx.measureText(text).width;
  };
}

/**
 * フォントがその PC にあるか。総称フォントは常にある。
 * 測れない環境 (`probe` が null を返す) では分からないので、あるとみなす (誤って注意を出さない)。
 */
export function probeFontAvailable(family: string, probe: FontProbe): boolean {
  const trimmed = family.trim();
  if (trimmed === "") return false;
  if (isGenericFamily(trimmed)) return true;
  const quoted = cssFontFamily(trimmed).replace(/, sans-serif$/, "");
  for (const base of BASES) {
    const fallback = probe(`${PROBE_SIZE}px ${base}`, PROBE_TEXT);
    const target = probe(`${PROBE_SIZE}px ${quoted}, ${base}`, PROBE_TEXT);
    if (fallback === null || target === null) return true;
    if (fallback !== target) return true;
  }
  return false;
}

/** 判定の結果を覚えておく口。フォントの有無はアプリを開いている間は変わらないとみなす。 */
export interface FontDetector {
  isAvailable(family: string): boolean;
  /** 候補のうちその PC にあるものを、グループの形のまま返す (空のグループは除く) */
  availableGroups(): FontGroup[];
  /** 新しいテキストの既定のフォント */
  defaultFamily(): string;
}

export function createFontDetector(probe: FontProbe = createCanvasProbe()): FontDetector {
  const known = new Map<string, boolean>();
  let groups: FontGroup[] | null = null;
  const isAvailable = (family: string) => {
    const key = family.trim().toLowerCase();
    let result = known.get(key);
    if (result === undefined) {
      result = probeFontAvailable(family, probe);
      known.set(key, result);
    }
    return result;
  };
  return {
    isAvailable,
    availableGroups() {
      groups ??= FONT_CANDIDATES.map((group) => ({
        label: group.label,
        families: group.families.filter(isAvailable),
      })).filter((group) => group.families.length > 0);
      return groups;
    },
    defaultFamily() {
      return DEFAULT_FONT_PREFERENCE.find(isAvailable) ?? FALLBACK_FONT_FAMILY;
    },
  };
}

/** エディタが使う判定。最初に使うときに canvas を作る。 */
export const fontDetector: FontDetector = createFontDetector();
