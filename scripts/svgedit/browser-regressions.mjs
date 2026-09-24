import assert from "node:assert/strict";

export async function verifyEditorRegressions({ frame, call, svg }) {
  const checkRevision = async (operation) => {
    const before = await call("snapshot");
    await operation();
    const after = await call("snapshot");
    assert.notEqual(after.svg, before.svg, "the standard UI must change the document");
    assert.ok(after.revision > before.revision, "every document edit must notify the parent");
    await frame.evaluate(() => window.svgEditor.svgCanvas.undoMgr.undo());
    const undone = await call("snapshot");
    assert.equal(undone.svg, before.svg);
    assert.ok(undone.revision > after.revision);
    await frame.evaluate(() => window.svgEditor.svgCanvas.undoMgr.redo());
    const redone = await call("snapshot");
    assert.equal(redone.svg, after.svg);
    assert.ok(redone.revision > undone.revision);
  };

  await checkRevision(() =>
    frame.evaluate(() =>
      window.svgEditor.mainMenu.saveDocProperties({
        detail: { title: "文書内タイトルを変更", w: "640", h: "480", save: "embed" },
      }),
    ),
  );
  await frame.evaluate(() => window.svgEditor.layersPanel.toggleSidePanel(true));
  await checkRevision(() => frame.locator("#layerlist td.layervis").first().click());
  await frame.evaluate(() => window.svgEditor.svgCanvas.createLayer("並べ替え確認"));
  await checkRevision(() => frame.locator("#layer_down").click());
  assert.equal((await call("load", { svg })).event, "loaded");

  const dialog = frame.locator("#host-layer-dialog");
  const input = frame.locator("#host-layer-name");
  const cancel = frame.locator("#host-layer-cancel");
  const accept = frame.locator("#host-layer-accept");
  const drawingNames = () =>
    frame.evaluate(() => {
      const drawing = window.svgEditor.svgCanvas.getCurrentDrawing();
      return Array.from({ length: drawing.getNumLayers() }, (_, i) => drawing.getLayerName(i));
    });
  const originalNames = await drawingNames();
  const clean = await call("snapshot");
  await frame.locator("#layer_new").click();
  await dialog.waitFor({ state: "visible" });
  await input.fill("取消するレイヤー");
  const shortcuts = () =>
    frame
      .page()
      .evaluate(() => window.messages.filter((message) => message.event === "action").length);
  const savesBefore = await shortcuts();
  await input.press("Control+s");
  await input.press("Meta+s");
  assert.equal(await shortcuts(), savesBefore);
  assert.equal((await call("snapshot")).event, "error");
  await cancel.click();
  assert.equal((await call("snapshot")).svg, clean.svg);
  assert.equal((await call("snapshot")).revision, clean.revision);
  await frame.locator("#layer_new").click();
  await input.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal((await call("snapshot")).revision, clean.revision);

  // Use the actual bound toolbar callbacks, not replacement methods directly.
  await frame.locator("#layer_new").click();
  await input.fill("   ");
  await accept.click();
  assert.match(await frame.locator("#host-layer-error").textContent(), /入力してください/);
  await input.fill(originalNames[0]);
  await accept.click();
  assert.match(await frame.locator("#host-layer-error").textContent(), /同じ名前/);
  await input.fill("日本語レイヤー");
  await input.evaluate((element) =>
    element.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
    ),
  );
  assert.equal(await dialog.evaluate((element) => element.open), true);
  assert.deepEqual(await drawingNames(), originalNames);
  await frame.page().screenshot({ path: ".generated/vector-verification/layer-dialog.png" });
  await input.press("Enter");
  await dialog.waitFor({ state: "hidden" });
  assert.ok((await drawingNames()).includes("日本語レイヤー"));
  const created = await call("snapshot");
  assert.ok(created.revision > clean.revision);

  await frame.locator("#layer_rename").click();
  assert.equal(await input.inputValue(), "日本語レイヤー");
  await input.fill("改名したレイヤー");
  await accept.click();
  await dialog.waitFor({ state: "hidden" });
  assert.ok((await drawingNames()).includes("改名したレイヤー"));
  const renamed = await call("snapshot");
  assert.ok(renamed.revision > created.revision);
  await frame.locator("#layer_rename").click();
  await accept.click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal((await call("snapshot")).revision, renamed.revision);

  await frame.evaluate(() =>
    document
      .getElementById("se-cmenu-layers-more")
      .dispatchEvent(new CustomEvent("change", { detail: { trigger: "dupe" } })),
  );
  await dialog.waitFor({ state: "visible" });
  await input.fill("複製したレイヤー");
  await accept.click();
  await dialog.waitFor({ state: "hidden" });
  assert.ok((await drawingNames()).includes("複製したレイヤー"));
  const cloned = await call("snapshot");
  assert.ok(cloned.revision > renamed.revision);
  await frame.evaluate(() => window.svgEditor.svgCanvas.undoMgr.undo());
  assert.ok(
    !(await drawingNames()).includes("複製したレイヤー"),
    JSON.stringify({
      svg: (await call("snapshot")).svg,
      history: await frame.evaluate(() => {
        const manager = window.svgEditor.svgCanvas.undoMgr;
        return {
          undo: manager.getNextUndoCommandText(),
          redo: manager.getNextRedoCommandText(),
          count: manager.getUndoStackSize(),
        };
      }),
    }),
  );
  await frame.evaluate(() => window.svgEditor.svgCanvas.undoMgr.redo());
  assert.ok((await drawingNames()).includes("複製したレイヤー"));
  const stored = await call("snapshot");
  assert.equal((await call("load", { svg: stored.svg })).event, "loaded");
  assert.equal((await call("snapshot")).revision, 0);
  assert.ok((await drawingNames()).includes("改名したレイヤー"));
  assert.ok((await drawingNames()).includes("複製したレイヤー"));

  await frame.locator("#layer_rename").click();
  await input.fill("旧文書への遅い入力");
  assert.equal((await call("load", { svg, documentId: "replacement" })).event, "loaded");
  await dialog.waitFor({ state: "hidden" });
  await accept.evaluate((button) => button.click());
  const replacement = await call("snapshot", { documentId: "replacement" });
  assert.equal(replacement.revision, 0);
  assert.ok(!replacement.svg.includes("旧文書への遅い入力"));
  assert.equal((await call("load", { svg })).event, "loaded");
}
