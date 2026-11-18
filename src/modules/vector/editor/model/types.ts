/**
 * キャンバス (module id `vector`) の payload v3 = シーン形式。
 * 仕様の正典は `docs/canvas-editor-design.md` §3 (ADR-0026) と、v2 からの差分の §3 (ADR-0028)。
 *
 * この型が保存形式そのもので、エディタのメモリ上のモデルも同じ形を使う (変換層を持たない)。
 * すべてのフィールドは必須。未知のフィールドは Rust の検証で拒否される。
 * 形式を変えるときは payload のバージョンを上げる (ADR-0006)。
 */

export type NodeId = string;
export type AssetId = string;
export type PageId = string;

/** `#RRGGBB` (16 進 6 桁、大文字小文字どちらも可)。不透明度は別のフィールドで持つ。 */
export type HexColor = string;

export interface Point {
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------
// 塗り・線・影
// ---------------------------------------------------------------------------

export interface SolidPaint {
  type: "solid";
  color: HexColor;
  /** 0〜1 */
  opacity: number;
}

export interface GradientStop {
  /** 0〜1。配列は offset の昇順 */
  offset: number;
  color: HexColor;
  /** 0〜1 */
  opacity: number;
}

/** `from` / `to` はノードの外接矩形を 0〜1 に正規化した座標。 */
export interface LinearGradientPaint {
  type: "linear";
  stops: GradientStop[];
  from: Point;
  to: Point;
}

/** `center` と `radius` はノードの外接矩形を 0〜1 に正規化した値。 */
export interface RadialGradientPaint {
  type: "radial";
  stops: GradientStop[];
  center: Point;
  radius: number;
}

export type Paint = SolidPaint | LinearGradientPaint | RadialGradientPaint;

export type StrokeCap = "butt" | "round" | "square";
export type StrokeJoin = "miter" | "round" | "bevel";

/** 線は中央揃えの単色だけ (内側・外側揃え、グラデーションは持たない)。 */
export interface Stroke {
  color: HexColor;
  /** 0〜1 */
  opacity: number;
  width: number;
  /** 線の端 (SVG の stroke-linecap) */
  cap: StrokeCap;
  /** 線の角 (SVG の stroke-linejoin)。マイターの上限は SVG の既定の 4 */
  join: StrokeJoin;
  /**
   * 破線の長さと間隔の並び (px)。空は実線。SVG の stroke-dasharray と同じ意味で、
   * 奇数個なら繰り返して偶数にする。破線は輪郭の始点から始める
   */
  dash: number[];
}

/** ドロップシャドウ。 */
export interface Shadow {
  x: number;
  y: number;
  blur: number;
  color: HexColor;
  /** 0〜1 */
  opacity: number;
}

// ---------------------------------------------------------------------------
// ノード
// ---------------------------------------------------------------------------

interface NodeCommon {
  id: NodeId;
  /** レイヤーパネルに出す名前 */
  name: string;
  visible: boolean;
  locked: boolean;
  /** 0〜1 */
  opacity: number;
}

/**
 * 親の座標系での左上 (回転の前の箱) と大きさ、回転。
 * 親が frame ならその左上が原点、ページ直下ならページの原点。
 * group とブーリアンは座標系を作らないので、その子は自分の親の座標系で持つ。
 */
interface BoxGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * 回転 (度)。時計回りが正 (SVG の rotate と同じ向き)。箱の中心 (x + width/2, y + height/2) の
   * まわりに回す。-180 以上 180 以下で、エディタは -180 より大きく 180 以下にそろえて書く
   */
  rotation: number;
}

/** 子を持ち、座標系を作る入れ物。ページ直下の frame がアートボードになる。入れ子にできる。 */
export interface FrameNode extends NodeCommon, BoxGeometry {
  type: "frame";
  /** 重なり順は配列の順 (先頭が最背面) */
  children: NodeId[];
  /** true なら子を frame の矩形で切り抜く */
  clip: boolean;
  fill: Paint | null;
  stroke: Stroke | null;
  radius: number;
  shadow: Shadow | null;
}

/** 論理的なまとまり。自分の位置と大きさは持たず、外接矩形は子から求める。 */
export interface GroupNode extends NodeCommon {
  type: "group";
  /** 1 個以上。重なり順は配列の順 (先頭が最背面) */
  children: NodeId[];
}

export interface RectNode extends NodeCommon, BoxGeometry {
  type: "rect";
  fill: Paint | null;
  stroke: Stroke | null;
  radius: number;
  shadow: Shadow | null;
}

export interface EllipseNode extends NodeCommon, BoxGeometry {
  type: "ellipse";
  fill: Paint | null;
  stroke: Stroke | null;
  shadow: Shadow | null;
}

/** 2 点を結ぶ線分。座標は親の座標系。 */
export interface LineNode extends NodeCommon {
  type: "line";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stroke: Stroke;
}

/**
 * - `auto-width`: 折り返さない。幅と高さは内容に従う
 * - `auto-height`: 幅は固定で折り返す。高さは内容に従う
 * - `fixed`: 幅も高さも固定。はみ出した分も描く
 */
export type TextSizing = "auto-width" | "auto-height" | "fixed";
export type TextAlign = "left" | "center" | "right";

/**
 * 1 つのテキストに 1 つの書式。行分割は保存せず、描画時に求める。
 * `width` / `height` は最後に求めた値で、フォントが違う PC では開いたときに求め直す
 * (求め直しただけでは未保存にしない)。
 */
export interface TextNode extends NodeCommon, BoxGeometry {
  type: "text";
  /** 本文。改行は `\n` */
  text: string;
  fontFamily: string;
  fontSize: number;
  /** 100〜900 の 100 刻み */
  fontWeight: number;
  italic: boolean;
  /** 行の高さ (px)。null はフォントサイズ × 1.4 */
  lineHeight: number | null;
  /** 字間 (px) */
  letterSpacing: number;
  align: TextAlign;
  sizing: TextSizing;
  fill: Paint | null;
  shadow: Shadow | null;
}

/** 画像は枠いっぱいに引き伸ばして描く (フィット・切り抜きは持たない)。 */
export interface ImageNode extends NodeCommon, BoxGeometry {
  type: "image";
  assetId: AssetId;
  radius: number;
  shadow: Shadow | null;
}

/** 編集できない埋め込み SVG。v1 の作品と、取り込んだ SVG ファイルがこれになる。 */
export interface SvgNode extends NodeCommon, BoxGeometry {
  type: "svg";
  assetId: AssetId;
}

/**
 * 点と曲線で作る形 (§3.8、§4.12)。点は自分の座標系 (箱の左上が原点、回転の前) で持ち、
 * 箱は形の曲線の範囲 (ハンドルの先は含めない) にぴったり合わせる。
 */
export interface PathNode extends NodeCommon, BoxGeometry {
  type: "path";
  /** 1 個以上 */
  subpaths: Subpath[];
  fillRule: FillRule;
  fill: Paint | null;
  stroke: Stroke | null;
  shadow: Shadow | null;
}

/**
 * 子の形を演算した結果を、自分の塗り・線・影で描く (§4.15)。座標系は作らず (子は自分の親の座標系で持つ)、
 * 外接矩形は結果から求める。子の塗り・線・影は描かない。
 */
export interface BooleanNode extends NodeCommon {
  type: "boolean";
  op: BooleanOp;
  /** 1 個以上。rect / ellipse / path / boolean だけ。重なり順は配列の順 (先頭が最背面) */
  children: NodeId[];
  fill: Paint | null;
  stroke: Stroke | null;
  shadow: Shadow | null;
}

export type CanvasNode =
  | FrameNode
  | GroupNode
  | RectNode
  | EllipseNode
  | LineNode
  | TextNode
  | ImageNode
  | SvgNode
  | PathNode
  | BooleanNode;

export type NodeType = CanvasNode["type"];
/** 子を持つノードのうち frame と group。ブーリアンも子を持つが、木の規則 (§4.15.1) が違うので含めない */
export type ContainerNode = FrameNode | GroupNode;

// ---------------------------------------------------------------------------
// パスの形 (`docs/canvas-editor-design.md` §3、§4.12)
// ---------------------------------------------------------------------------

export type FillRule = "nonzero" | "evenodd";

/** ハンドルの連動。none は別々、angle は向きだけ、angle-length は向きと長さをそろえる */
export type HandleMirror = "none" | "angle" | "angle-length";

export interface PathPoint {
  /** ノードの箱の左上を原点とする座標 (回転の前) */
  x: number;
  y: number;
  /** 前の点から来る曲線のハンドル。点からの相対。null は直線で入る */
  in: Point | null;
  /** 次の点へ出る曲線のハンドル。点からの相対。null は直線で出る */
  out: Point | null;
  mirror: HandleMirror;
}

export interface Subpath {
  /** true なら最後の点から先頭の点へ戻る線分 (または曲線) を描く */
  closed: boolean;
  /** 1 個以上 */
  points: PathPoint[];
}

export type BooleanOp = "union" | "subtract" | "intersect" | "exclude";

// ---------------------------------------------------------------------------
// アセット
// ---------------------------------------------------------------------------

export interface ImageAsset {
  kind: "image";
  mime: "image/png" | "image/jpeg" | "image/webp";
  /** base64 (`data:` の接頭辞なし) */
  data: string;
  /** 画像本来の大きさ (px) */
  width: number;
  height: number;
}

export interface SvgAsset {
  kind: "svg";
  /** SVG ポリシーを通った SVG 文書 */
  svg: string;
  /** SVG から抽出した検索用テキスト (v1 と同じ規則)。Rust の抽出結果と一致しなければ拒否される */
  text: string;
  width: number;
  height: number;
}

export type Asset = ImageAsset | SvgAsset;

// ---------------------------------------------------------------------------
// 文書
// ---------------------------------------------------------------------------

export interface Guide {
  /** `x` は縦のガイド線 (x 座標が一定)、`y` は横のガイド線 */
  axis: "x" | "y";
  /** ページ座標 */
  position: number;
}

export interface Page {
  id: PageId;
  name: string;
  /** ページ直下のノード。重なり順は配列の順 (先頭が最背面) */
  children: NodeId[];
  guides: Guide[];
}

/**
 * 文書。`nodes` は ID から引く平たい表で、木の形は `children` が決める。
 * どのノードも、ちょうど 1 つの親 (ページか frame か group かブーリアン) の `children` に 1 回だけ現れる。
 * `assets` はノードから参照されているものだけを持つ。
 */
export interface CanvasDocument {
  /** 1 個以上。第 1 段階の画面は先頭の 1 ページだけを使う */
  pages: Page[];
  nodes: Record<NodeId, CanvasNode>;
  assets: Record<AssetId, Asset>;
}

/** `items.payload` に保存する形 (payload_schema_version = 3)。 */
export interface VectorPayloadV3 extends CanvasDocument {
  /** 検索用テキスト。`docs/canvas-editor-design.md` §3.6 の規則で文書から求める */
  text: string;
}
