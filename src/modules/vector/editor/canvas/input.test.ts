import { describe, expect, it } from "vitest";
import {
  canvasKeyScope,
  CONTROL_KEYS,
  isComposing,
  isModalOpen,
  isEditableTarget,
  MULTI_CLICK_MS,
  nextClick,
  toCanvasKeyEvent,
  toCanvasPointerEvent,
} from "./input";

const modifiers = { shiftKey: false, altKey: false, metaKey: false, ctrlKey: false };

describe("toCanvasPointerEvent", () => {
  it("キャンバスの左上を原点にした画面座標と、表示位置で写したページ座標", () => {
    const event = toCanvasPointerEvent(
      { ...modifiers, clientX: 110, clientY: 70, shiftKey: true },
      { x: 10, y: 20 },
      { x: 50, y: -10, zoom: 2 },
      0,
      1,
      true,
    );
    expect(event).toEqual({
      screen: { x: 100, y: 50 },
      page: { x: 100, y: 15 },
      button: 0,
      clickCount: 1,
      shift: true,
      alt: false,
      mod: false,
    });
  });

  it("mod は macOS で Cmd、それ以外で Ctrl", () => {
    const viewport = { x: 0, y: 0, zoom: 1 };
    const cmd = { ...modifiers, clientX: 0, clientY: 0, metaKey: true };
    const ctrl = { ...modifiers, clientX: 0, clientY: 0, ctrlKey: true };
    expect(toCanvasPointerEvent(cmd, { x: 0, y: 0 }, viewport, 0, 1, true).mod).toBe(true);
    expect(toCanvasPointerEvent(ctrl, { x: 0, y: 0 }, viewport, 0, 1, true).mod).toBe(false);
    expect(toCanvasPointerEvent(ctrl, { x: 0, y: 0 }, viewport, 0, 1, false).mod).toBe(true);
    expect(toCanvasPointerEvent(cmd, { x: 0, y: 0 }, viewport, 0, 1, false).mod).toBe(false);
  });
});

describe("toCanvasKeyEvent", () => {
  it("key と修飾キーと繰り返し", () => {
    expect(
      toCanvasKeyEvent(
        { ...modifiers, key: "z", code: "KeyZ", repeat: true, metaKey: true, shiftKey: true },
        true,
      ),
    ).toEqual({ key: "z", shift: true, alt: false, mod: true, repeat: true });
  });
});

describe("入力欄と変換中", () => {
  it("文字を受ける要素だけを入力欄とみなす", () => {
    const make = (html: string) => {
      const host = document.createElement("div");
      host.innerHTML = html;
      document.body.append(host);
      return host.firstElementChild;
    };
    expect(isEditableTarget(make("<input type='text'>"))).toBe(true);
    expect(isEditableTarget(make("<input>"))).toBe(true);
    expect(isEditableTarget(make("<input type='number'>"))).toBe(true);
    expect(isEditableTarget(make("<textarea></textarea>"))).toBe(true);
    expect(isEditableTarget(make("<select></select>"))).toBe(true);
    expect(isEditableTarget(make("<input type='checkbox'>"))).toBe(false);
    expect(isEditableTarget(make("<button>a</button>"))).toBe(false);
    expect(
      isEditableTarget(
        make("<div contenteditable='true'><span>x</span></div>")?.firstElementChild ?? null,
      ),
    ).toBe(true);
    expect(isEditableTarget(document.body)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(window)).toBe(false);
  });

  it("isComposing か keyCode 229 なら変換中", () => {
    expect(isComposing({ isComposing: true })).toBe(true);
    expect(isComposing({ isComposing: false, keyCode: 229 })).toBe(true);
    expect(isComposing({ isComposing: false, keyCode: 65 })).toBe(false);
  });
});

describe("クリックの回数", () => {
  const press = (time: number, x = 0, button = 0) => ({ time, x, y: 0, button });

  it("近い場所を続けて押すと 2、その次は 1 に戻る", () => {
    const first = nextClick(null, press(0));
    expect(first.count).toBe(1);
    const second = nextClick(first, press(100));
    expect(second.count).toBe(2);
    expect(nextClick(second, press(200)).count).toBe(1);
  });

  it("間が空く、離れる、ボタンが違うと 1", () => {
    const first = nextClick(null, press(0));
    expect(nextClick(first, press(MULTI_CLICK_MS + 1)).count).toBe(1);
    expect(nextClick(first, press(100, 10)).count).toBe(1);
    expect(nextClick(first, press(100, 0, 2)).count).toBe(1);
  });
});

describe("canvasKeyScope (キーを取る範囲)", () => {
  function mount(html: string) {
    const host = document.createElement("div");
    host.innerHTML = html;
    document.body.append(host);
    return host;
  }

  it("エディタの中か、フォーカスがどこにもないときだけ取る", () => {
    const host = mount(`
      <button id="outside">外</button>
      <div data-canvas-editor="">
        <div id="canvas" tabindex="-1"></div>
        <button id="button">中</button>
        <input id="check" type="checkbox">
        <div id="item" role="menuitem" tabindex="0"></div>
        <input id="field">
      </div>`);
    const get = (id: string) => host.querySelector(`#${id}`);
    expect(canvasKeyScope(document.body)).toBe("canvas");
    expect(canvasKeyScope(null)).toBe("canvas");
    expect(canvasKeyScope(get("canvas"))).toBe("canvas");
    expect(canvasKeyScope(get("outside"))).toBe("none");
    expect(canvasKeyScope(get("button"))).toBe("control");
    expect(canvasKeyScope(get("check"))).toBe("control");
    expect(canvasKeyScope(get("item"))).toBe("control");
    expect(canvasKeyScope(get("field"))).toBe("editable");
    host.remove();
  });

  it("モーダルが開いている間は、どこにフォーカスがあっても取らない", () => {
    const host = mount(
      `<div data-canvas-editor=""><div id="canvas"></div></div><div role="dialog" aria-modal="true"></div>`,
    );
    expect(isModalOpen()).toBe(true);
    expect(canvasKeyScope(document.body)).toBe("none");
    expect(canvasKeyScope(host.querySelector("#canvas"))).toBe("none");
    host.remove();
    expect(isModalOpen()).toBe(false);
  });

  it("部品に任せるキーは Space・Enter・矢印", () => {
    expect([...CONTROL_KEYS].sort()).toEqual(
      [" ", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp", "Enter"].sort(),
    );
  });
});
