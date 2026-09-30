import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

import { MAX_DIAGRAM_BYTES, largeDiagramXml, normalizeDrawioFile } from "./browser-support.mjs";

/**
 * draw.io の標準 action を embed protocol の invokeAction で実行し、
 * 保存 XML で undo / redo の履歴が正確に再生されることを確かめる。
 * 31.5 系で全 model 変更に入った実行時の修復処理が主な対象。
 */
export async function verifyUndoRedo({ load, invoke, saveXml, textContent, smokeXml }) {
  const timings = {};
  const snapshot = async () => normalizeDrawioFile(await saveXml());

  // steps の各要素は、1 回の undo で戻る 1 つの編集になる action の並び。
  const scenario = async (name, steps) => {
    const textBefore = await textContent();
    const states = [await snapshot()];
    for (const [index, actions] of steps.entries()) {
      for (const action of actions) await invoke(action);
      states.push(await snapshot());
      assert.notEqual(
        states[index + 1],
        states[index],
        `${name}: ${actions.join("+")} で図が変わらない`,
      );
    }
    for (let index = steps.length; index > 0; index -= 1) {
      await invoke("undo");
      assert.equal(
        await snapshot(),
        states[index - 1],
        `${name}: undo で ${index - 1} 手目に戻らない`,
      );
    }
    for (let index = 1; index <= steps.length; index += 1) {
      await invoke("redo");
      assert.equal(await snapshot(), states[index], `${name}: redo で ${index} 手目に進まない`);
    }
    for (let index = steps.length; index > 0; index -= 1) await invoke("undo");
    assert.equal(await snapshot(), states[0], `${name}: すべて undo しても元に戻らない`);
    assert.equal(await textContent(), textBefore, `${name}: 抽出テキストが元に戻らない`);
  };

  await load(smokeXml);
  await scenario("図形", [
    ["selectAll", "duplicate"],
    ["selectVertices", "deleteAll"],
  ]);
  const danglingEdges = await verifyDanglingEdges({ invoke, snapshot, textContent });
  await scenario("全削除", [["selectAll", "deleteAll"]]);
  await scenario("グループ", [["selectAll", "group"], ["ungroup"]]);
  await scenario("ページ", [["insertPage"], ["duplicatePage"], ["removePage"]]);
  // ページの選択は内容を変えない undo 可能な編集なので、手順の外で行う。
  await invoke("nextPage");
  await scenario("コンテナ", [
    ["selectAll", "duplicate"],
    ["selectEdges", "delete"],
    ["selectVertices", "delete"],
  ]);

  const largeXml = largeDiagramXml(850_000);
  let started = performance.now();
  await load(largeXml);
  timings.largeLoadMs = Math.round(performance.now() - started);
  started = performance.now();
  const largeBefore = await saveXml();
  timings.largeSaveMs = Math.round(performance.now() - started);
  started = performance.now();
  await invoke("selectAll");
  await invoke("delete");
  const largeDeleted = await snapshot();
  timings.largeDeleteMs = Math.round(performance.now() - started);
  started = performance.now();
  await invoke("undo");
  const largeUndone = await snapshot();
  timings.largeUndoMs = Math.round(performance.now() - started);
  started = performance.now();
  await invoke("redo");
  const largeRedone = await snapshot();
  timings.largeRedoMs = Math.round(performance.now() - started);
  assert.equal(largeUndone, normalizeDrawioFile(largeBefore), "大きな図: undo で元に戻らない");
  assert.equal(largeRedone, largeDeleted, "大きな図: redo で削除後に戻らない");
  for (const [name, milliseconds] of Object.entries(timings)) {
    assert.ok(milliseconds < 20_000, `大きな図: ${name} が 20 秒を超えた (${milliseconds}ms)`);
  }
  const largeInputBytes = Buffer.byteLength(largeXml);
  const largeSavedBytes = Buffer.byteLength(largeBefore);
  assert.ok(
    largeSavedBytes <= MAX_DIAGRAM_BYTES,
    `大きな図の保存 XML が 1 MiB を超えた (${largeSavedBytes})`,
  );

  await load(smokeXml);
  return {
    danglingEdges,
    timings,
    largeInputBytes,
    largeSavedBytes,
    savedToInputRatio: largeSavedBytes / largeInputBytes,
  };
}

/**
 * delete は invokeAction では event を持たず、頂点だけを消して edge を宙に浮かせる。
 * 両端を消した edge は削除直後も削除済み cell を参照したまま残る (31.4.1 から続く上流の挙動)。
 * 31.5 系は redo の時に修復処理がこの参照を端点座標へ置き換えるため、redo の結果は
 * 最初の削除と一致しない。undo が元へ正確に戻ることだけを保証し、redo の差は記録する。
 */
async function verifyDanglingEdges({ invoke, snapshot, textContent }) {
  const textBefore = await textContent();
  const before = await snapshot();
  await invoke("selectVertices");
  await invoke("delete");
  const deleted = await snapshot();
  assert.notEqual(deleted, before, "宙に浮く edge: 頂点の削除で図が変わらない");
  await invoke("undo");
  assert.equal(await snapshot(), before, "宙に浮く edge: undo で元に戻らない");
  await invoke("redo");
  const redone = await snapshot();
  await invoke("undo");
  assert.equal(await snapshot(), before, "宙に浮く edge: redo の後の undo で元に戻らない");
  assert.equal(await textContent(), textBefore, "宙に浮く edge: 抽出テキストが元に戻らない");
  const danglingReferences = (xml) => {
    const cells = [...xml.matchAll(/<mxCell\b[^>]*>/g)].map(([tag]) =>
      Object.fromEntries([...tag.matchAll(/\s([^\s=]+)="([^"]*)"/g)].map(([, k, v]) => [k, v])),
    );
    const ids = new Set(cells.map((cell) => cell.id));
    return cells
      .filter((cell) => cell.edge === "1")
      .filter((cell) => [cell.source, cell.target].some((id) => id != null && !ids.has(id)))
      .map((cell) => cell.id);
  };
  return {
    redoMatchesDelete: redone === deleted,
    danglingAfterDelete: danglingReferences(deleted),
    danglingAfterRedo: danglingReferences(redone),
  };
}

/**
 * ページの並べ替えを、キー操作 (選択が無い時の Shift+→) とページタブのドラッグで確かめる。
 * どちらも MovePage を 1 つの undo 可能な編集として実行し、保存 XML のページ順に反映される。
 */
export async function verifyPageMove({ page, frame, load, invoke, saveXml, smokeXml }) {
  const snapshot = async () => normalizeDrawioFile(await saveXml());
  const order = (xml) => [...xml.matchAll(/<diagram\b[^>]*\bid="([^"]+)"/g)].map(([, id]) => id);

  await load(smokeXml);
  const initial = await snapshot();
  assert.deepEqual(order(initial), ["page-1", "page-2"], "ページ移動: 初期のページ順が違う");

  // 何も選択していない状態で Shift+→ を押すと、表示中のページが 1 つ右へ移る。
  await frame.locator(".geDiagramContainer").click({ position: { x: 700, y: 600 } });
  await invoke("selectNone");
  await page.keyboard.press("Shift+ArrowRight");
  const moved = await snapshot();
  assert.deepEqual(order(moved), ["page-2", "page-1"], "ページ移動: Shift+→ で移動しない");
  await invoke("undo");
  assert.equal(await snapshot(), initial, "ページ移動: undo で元の順に戻らない");
  await invoke("redo");
  assert.equal(await snapshot(), moved, "ページ移動: redo で移動後に戻らない");
  await invoke("undo");
  assert.equal(await snapshot(), initial, "ページ移動: 2 回目の undo で元の順に戻らない");

  // 1 番目のタブを 2 番目のタブの右半分へドラッグすると、その後ろへ移る。
  const tabs = frame.locator(".gePageTab");
  const target = await tabs.nth(1).boundingBox();
  await tabs.nth(0).dragTo(tabs.nth(1), {
    targetPosition: { x: target.width - 3, y: target.height / 2 },
  });
  const dragged = await snapshot();
  assert.deepEqual(order(dragged), ["page-2", "page-1"], "ページ移動: タブのドラッグで移動しない");
  await invoke("undo");
  assert.equal(await snapshot(), initial, "ページ移動: ドラッグ後の undo で元の順に戻らない");

  await load(smokeXml);
  return { keyboard: order(moved), drag: order(dragged) };
}
