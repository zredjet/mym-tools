/**
 * フレームツールでクリックだけしたときの大きさ (§5.6)。
 *
 * プロパティパネルのフレームの節で直前に選んだプリセットの大きさ。ドラッグで作った大きさは覚えない
 * (クリックのつもりで少し動かしてできた小さなフレームの大きさが、以後のクリックに残らないように)。初回は iPhone。
 * 文書にも設定にも保存しない。画面を開き直したら iPhone に戻すので、エディタを開く側
 * (切替後の `VectorWorkspacePage`) が開くたびに `resetLastFrameSize` を呼ぶ。
 */
import { DEFAULT_FRAME_PRESET } from "../../panels/sections/framePresets";
import type { Size } from "./geometry";

const INITIAL: Size = { width: DEFAULT_FRAME_PRESET.width, height: DEFAULT_FRAME_PRESET.height };

let last: Size = INITIAL;

export function getLastFrameSize(): Size {
  return last;
}

export function rememberFrameSize(size: Size): void {
  last = { width: size.width, height: size.height };
}

/** 初回の大きさ (iPhone) に戻す。 */
export function resetLastFrameSize(): void {
  last = INITIAL;
}
