/**
 * フレームのプリセット (`docs/canvas-editor-design.md` §5.6)。
 * プロパティパネルのフレームの節と、フレームツール (「作成ツールと画像」のセッション) が同じ一覧を使う。
 */

export type FramePresetCategory = "端末" | "バナー" | "アイコン";

export interface FramePreset {
  /** 安定した識別子 (直前に使ったプリセットを覚えるときなどに使う) */
  id: string;
  category: FramePresetCategory;
  /** 画面に出す名前。新しいフレームの名前にも使える */
  name: string;
  width: number;
  height: number;
}

/** 分類の並び順。 */
export const FRAME_PRESET_CATEGORIES: readonly FramePresetCategory[] = [
  "端末",
  "バナー",
  "アイコン",
];

export const FRAME_PRESETS: readonly FramePreset[] = [
  { id: "iphone", category: "端末", name: "iPhone", width: 393, height: 852 },
  { id: "android", category: "端末", name: "Android", width: 412, height: 917 },
  { id: "tablet", category: "端末", name: "タブレット", width: 820, height: 1180 },
  { id: "desktop", category: "端末", name: "デスクトップ", width: 1440, height: 1024 },
  { id: "ogp", category: "バナー", name: "OGP 画像", width: 1200, height: 630 },
  {
    id: "youtube-thumbnail",
    category: "バナー",
    name: "YouTube サムネイル",
    width: 1280,
    height: 720,
  },
  { id: "x-header", category: "バナー", name: "X ヘッダー", width: 1500, height: 500 },
  { id: "square", category: "バナー", name: "正方形", width: 1080, height: 1080 },
  { id: "icon-24", category: "アイコン", name: "24", width: 24, height: 24 },
  { id: "icon-512", category: "アイコン", name: "512", width: 512, height: 512 },
  { id: "icon-1024", category: "アイコン", name: "1024", width: 1024, height: 1024 },
];

/** フレームツールでクリックだけしたときの、初回の大きさ (§5.6: iPhone)。 */
export const DEFAULT_FRAME_PRESET: FramePreset = FRAME_PRESETS[0] as FramePreset;

export function getFramePreset(id: string): FramePreset | undefined {
  return FRAME_PRESETS.find((preset) => preset.id === id);
}

/** 大きさが一致するプリセット (同じ大きさが複数あれば先のもの)。 */
export function findFramePresetBySize(width: number, height: number): FramePreset | undefined {
  return FRAME_PRESETS.find((preset) => preset.width === width && preset.height === height);
}

/** 一覧に出す文字列 (「iPhone 393 × 852」)。 */
export function framePresetLabel(preset: FramePreset): string {
  return `${preset.name} ${preset.width} × ${preset.height}`;
}
