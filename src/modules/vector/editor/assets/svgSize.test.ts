import { describe, expect, it } from "vitest";
import { CANVAS_LIMITS } from "../model/limits";
import { svgIntrinsicSize, svgSizeFromAttributes } from "./svgSize";

// Rust の upgrade.rs の svg_size のテストと同じ例

const root = (attributes: string) =>
  svgIntrinsicSize(`<svg xmlns="http://www.w3.org/2000/svg" ${attributes}></svg>`);

describe("svgIntrinsicSize", () => {
  it("width / height (単位なしか px) が両方とも正ならその値", () => {
    expect(root('width="100" height="50"')).toEqual({ width: 100, height: 50 });
    expect(root('width="100px" height="50PX"')).toEqual({ width: 100, height: 50 });
    expect(root('width=" 12.5 " height=".5e2"')).toEqual({ width: 12.5, height: 50 });
    expect(root('width="+3" height="4."')).toEqual({ width: 3, height: 4 });
    expect(root('width="100" height="50" viewBox="0 0 300 150"')).toEqual({
      width: 100,
      height: 50,
    });
  });

  it("使えなければ viewBox", () => {
    const expected = { width: 300, height: 150 };
    for (const attributes of [
      'viewBox="0 0 300 150"',
      'viewBox="0,0,300,150"',
      'viewBox=" -10 , 5 300   150 "',
      'viewBox="0\t0\n300 150"',
      'width="0" height="50" viewBox="0 0 300 150"',
      'width="-100" height="50" viewBox="0 0 300 150"',
      'width="100" viewBox="0 0 300 150"',
      'width="100%" height="100%" viewBox="0 0 300 150"',
      'width="10em" height="10em" viewBox="0 0 300 150"',
      'width="1e999" height="5" viewBox="0 0 300 150"',
      'width="NaN" height="inf" viewBox="0 0 300 150"',
      'width="10 px" height="10" viewBox="0 0 300 150"',
    ])
      expect(root(attributes), attributes).toEqual(expected);
    expect(root('viewBox="0 0 300.5 1e2"')).toEqual({ width: 300.5, height: 100 });
  });

  it("どちらもなければ 640 × 480", () => {
    for (const attributes of [
      "",
      'viewBox="0 0 0 150"',
      'viewBox="0 0 300 -150"',
      'viewBox="0 0 300"',
      'viewBox="0 0 300 150 1"',
      'viewBox="0,,0,300,150"',
      'viewBox=",0 0 300 150"',
      'viewBox="0 0 300 150,"',
      'viewBox="0 0 a 150"',
      'width="0" height="0"',
    ])
      expect(root(attributes), attributes).toEqual({ width: 640, height: 480 });
  });

  it("1 以上 maxSize 以下に収める", () => {
    expect(svgSizeFromAttributes({ width: "0.25", height: "200000", viewBox: null })).toEqual({
      width: 1,
      height: CANVAS_LIMITS.maxSize,
    });
  });
});
