import type { ToolId } from "../state/types";
import { ellipseTool } from "./ellipseTool";
import { frameTool } from "./frameTool";
import { handTool } from "./handTool";
import { imageTool } from "./imageTool";
import { lineTool } from "./lineTool";
import { pathEditTool } from "./pathEditTool";
import { pencilTool } from "./pencilTool";
import { penTool } from "./penTool";
import { polygonTool } from "./polygonTool";
import { rectTool } from "./rectTool";
import { selectTool } from "./selectTool";
import { starTool } from "./starTool";
import { textTool } from "./textTool";
import type { Tool } from "./types";

/** ツールの一覧。ツールを足すときは `ToolId` とここを同じ変更で更新する。 */
export const TOOLS: Record<ToolId, Tool> = {
  select: selectTool,
  hand: handTool,
  frame: frameTool,
  rect: rectTool,
  ellipse: ellipseTool,
  polygon: polygonTool,
  star: starTool,
  line: lineTool,
  pen: penTool,
  pencil: pencilTool,
  text: textTool,
  image: imageTool,
  pathEdit: pathEditTool,
};
