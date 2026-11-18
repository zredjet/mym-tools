/**
 * 変換で落とすもの・近似になるものの一覧 (§8.12)。確認のダイアログに種類と件数を出す。
 *
 * 種類の並び (`DROPPED_KINDS`) がダイアログに出す順。`display: none` と `visibility: hidden` の要素は
 * 見えていないので一覧に入れない (黙って飛ばす)。
 */

export const DROPPED_KINDS = [
  "clipPath",
  "mask",
  "filter",
  "pattern",
  "image",
  "marker",
  "textPath",
  "strokeGradient",
  "gradientTransform",
  "gradientFocal",
  "gradientSpread",
  "gradientStops",
  "dashOffset",
  "miterLimit",
  "vectorEffect",
  "paintOrder",
  "nonUniformStroke",
  "nestedClip",
  "outsideBox",
  "useCycle",
  "textPosition",
  "textStroke",
  "textStyle",
  "valueLimit",
] as const;

export type DroppedKind = (typeof DROPPED_KINDS)[number];

/** 種類ごとの説明 (ダイアログの 1 行)。 */
export const DROPPED_LABELS: Readonly<Record<DroppedKind, string>> = {
  clipPath: "切り抜き (clip-path)",
  mask: "マスク",
  filter: "フィルタ (ぼかし・影など)",
  pattern: "パターンの塗り",
  image: "画像",
  marker: "線の端のマーカー (矢印など)",
  textPath: "パスに沿った文字",
  strokeGradient: "線のグラデーション (単色にします)",
  gradientTransform: "表せないグラデーションの変形 (近似します)",
  gradientFocal: "放射グラデーションの焦点 (中心にそろえます)",
  gradientSpread: "グラデーションの繰り返し (spreadMethod)",
  gradientStops: "17 個以上の色の停止点 (間引きます)",
  dashOffset: "破線の開始位置 (stroke-dashoffset)",
  miterLimit: "マイターの上限 (stroke-miterlimit が 4 以外)",
  vectorEffect: "vector-effect",
  paintOrder: "塗りと線の重ね順 (paint-order)",
  nonUniformStroke: "縦横で違う拡大を受けた線の太さ (近似します)",
  nestedClip: "入れ子の svg の切り抜き",
  outsideBox: "SVG の枠の外にはみ出した部分 (今は切り抜かれて見えません)",
  useCycle: "循環しているか深すぎる use",
  textPosition: "テキストの位置 (近似します)",
  textStroke: "テキストの線",
  textStyle: "1 行の途中で変わるテキストの書式 (行の先頭の書式にそろえます)",
  valueLimit: "上限を超える値 (上限に収めます)",
};

export interface DroppedItem {
  kind: DroppedKind;
  label: string;
  count: number;
}

/** 落とすものを数える。 */
export class DroppedCollector {
  private counts = new Map<DroppedKind, number>();

  add(kind: DroppedKind, count = 1): void {
    if (count <= 0) return;
    this.counts.set(kind, (this.counts.get(kind) ?? 0) + count);
  }

  /** 決まった順に並べた一覧。 */
  list(): DroppedItem[] {
    const items: DroppedItem[] = [];
    for (const kind of DROPPED_KINDS) {
      const count = this.counts.get(kind);
      if (count) items.push({ kind, label: DROPPED_LABELS[kind], count });
    }
    return items;
  }
}
