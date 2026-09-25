import type { PngOptSettings, PngOptStatus } from "@/ipc/pngopt";

export function validateSettings(settings: PngOptSettings): string | null {
  const { qualityMin, qualityMax, speed } = settings;
  const isInt = (value: number) => Number.isInteger(value);
  if (!isInt(qualityMin) || !isInt(qualityMax) || qualityMin < 0 || qualityMax > 100) {
    return "品質は0〜100の整数で指定してください。";
  }
  if (qualityMin > qualityMax) return "品質の下限は上限以下にしてください。";
  if (!isInt(speed) || speed < 1 || speed > 11) return "速度は1〜11の整数で指定してください。";
  return null;
}

export function statusMessage(status: PngOptStatus): string {
  switch (status) {
    case "optimized":
      return "最適化しました";
    case "quality_too_low":
      return "品質が下限に届かないため元のままにしました";
    case "not_smaller":
      return "小さくならないため元のままにしました";
    case "failed":
      return "失敗しました";
  }
}

/** 別名で保存するときの既定のパス: 入力と同じフォルダの `<名前>-optimized.png` */
export function defaultOutputPath(inputPath: string): string {
  const cut = Math.max(inputPath.lastIndexOf("/"), inputPath.lastIndexOf("\\")) + 1;
  const directory = inputPath.slice(0, cut);
  const name = inputPath.slice(cut);
  const stem = name.replace(/\.png$/i, "");
  return `${directory}${stem}-optimized.png`;
}
