import {
  Circle,
  FileCode,
  Frame,
  Group,
  Image,
  Minus,
  Spline,
  Square,
  Type,
  type LucideIcon,
} from "lucide-react";

import { CANVAS_LIMITS } from "../../model/limits";
import { updateNodes } from "../../model/transform";
import { getNode } from "../../model/tree";
import type { BooleanOp, NodeId, NodeType } from "../../model/types";
import { hasLoneSurrogate } from "../../model/validate";
import { editorStore } from "../../state/store";
import { clipName } from "../fields/values";
import { BOOLEAN_OP_ICONS } from "../sections/convertActions";

/** レイヤーの行に出す種別のアイコン。ブーリアンは演算ごとのアイコン (`BOOLEAN_ROW_ICONS`) を使う。 */
export const NODE_TYPE_ICONS: Record<NodeType, LucideIcon> = {
  frame: Frame,
  group: Group,
  rect: Square,
  ellipse: Circle,
  line: Minus,
  text: Type,
  image: Image,
  svg: FileCode,
  path: Spline,
  boolean: BOOLEAN_OP_ICONS.union,
};

/** ブーリアンの行のアイコン (演算ごと。合体・型抜き・交差・中マド。§5.2)。 */
export const BOOLEAN_ROW_ICONS: Readonly<Record<BooleanOp, LucideIcon>> = BOOLEAN_OP_ICONS;

/** 名前を確定する。上限の文字数で切り、変わらなければ何もしない。 */
export function commitLayerName(id: NodeId, input: string): void {
  const name = clipName(input, CANVAS_LIMITS.maxNameLength);
  if (hasLoneSurrogate(name)) return;
  const store = editorStore.getState();
  if (getNode(store.doc, id)?.name === name) return;
  store.apply((doc) => updateNodes(doc, [id], { name }));
}
