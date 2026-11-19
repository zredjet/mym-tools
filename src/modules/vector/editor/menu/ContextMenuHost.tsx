/**
 * 右クリックのメニューを出す場所 (§5.8)。`EditorRoot` の中に 1 つだけ置き、エディタ全体に重ねる。
 *
 * - 位置は押した位置。エディタの端からはみ出すなら内側へ直す (`placeMenu`)。エディタより高いメニューは
 *   中でスクロールする
 * - 閉じる: Esc、外を押す、項目を選ぶ、ウィンドウのフォーカスが外れる (`MenuList`)。ここでは、ホイール・ピンチ
 *   (スクロールとズーム)・ウィンドウの大きさの変更・表示位置や文書やツールの変化でも閉じる
 * - アプリの UI の倍率 (body の CSS `zoom`) の下でも位置が合うよう、重ねる層の見た目の大きさと CSS の大きさの比で
 *   クライアント座標を割る
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

import { editorStore } from "../state/store";
import { closeContextMenu, MENU_MARGIN, placeMenu, useContextMenu } from "./contextMenu";
import { MenuList, type MenuEntry } from "./MenuList";

export function ContextMenuHost() {
  const request = useContextMenu();
  if (!request) return null;
  return (
    <ContextMenuLayer
      key={request.key}
      clientX={request.clientX}
      clientY={request.clientY}
      entries={request.entries}
      empty={request.empty}
    />
  );
}

function ContextMenuLayer({
  clientX,
  clientY,
  entries,
  empty,
}: {
  clientX: number;
  clientY: number;
  entries: readonly MenuEntry[];
  empty: boolean;
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [placed, setPlaced] = useState<{ x: number; y: number; maxHeight: number } | null>(null);

  // 測ってから置く (描く前に済むので、置く前の位置は見えない)
  useLayoutEffect(() => {
    const layer = layerRef.current;
    const menu = menuRef.current;
    if (!layer || !menu) return;
    const rect = layer.getBoundingClientRect();
    const width = layer.offsetWidth;
    const height = layer.offsetHeight;
    const scale = width > 0 && rect.width > 0 ? rect.width / width : 1;
    const point = { x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale };
    const maxHeight = Math.max(0, height - MENU_MARGIN * 2);
    const size = { width: menu.offsetWidth, height: Math.min(menu.offsetHeight, maxHeight) };
    setPlaced({ ...placeMenu(point, size, { width, height }), maxHeight });
  }, [clientX, clientY]);

  // ホイール・ピンチ・大きさの変更・表示位置や文書やツールの変化で閉じる。要素の scroll では閉じない
  // (右クリックで選んだ行をレイヤーパネルが見える所へスクロールする。人が動かすスクロールはホイールか、
  // スクロールバーを押す = 外を押す、で閉じる)
  useEffect(() => {
    const inMenu = (target: EventTarget | null) =>
      target instanceof Node && (menuRef.current?.contains(target) ?? false);
    const onWheel = (event: Event) => {
      if (!inMenu(event.target)) closeContextMenu();
    };
    const close = () => closeContextMenu();
    window.addEventListener("wheel", onWheel, { capture: true, passive: true });
    window.addEventListener("gesturestart", close, true);
    window.addEventListener("resize", close);
    const unsubscribe = editorStore.subscribe((state, previous) => {
      if (
        state.viewport !== previous.viewport ||
        state.doc !== previous.doc ||
        state.pageId !== previous.pageId ||
        state.toolId !== previous.toolId ||
        state.editingTextId !== previous.editingTextId ||
        state.editingPathId !== previous.editingPathId
      )
        closeContextMenu();
    });
    return () => {
      window.removeEventListener("wheel", onWheel, true);
      window.removeEventListener("gesturestart", close, true);
      window.removeEventListener("resize", close);
      unsubscribe();
    };
  }, []);

  const style: CSSProperties = placed
    ? { left: placed.x, top: placed.y, maxHeight: placed.maxHeight }
    : { left: 0, top: 0, opacity: 0 };

  return (
    <div ref={layerRef} className="pointer-events-none absolute inset-0 z-50 overflow-hidden">
      <MenuList
        menuRef={menuRef}
        label={empty ? "キャンバスのメニュー" : "選択のメニュー"}
        entries={entries}
        initialFocus="menu"
        onClose={() => closeContextMenu()}
        className="pointer-events-auto absolute"
        style={style}
      />
    </div>
  );
}
