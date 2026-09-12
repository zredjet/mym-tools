// HTML dialogs work inside the sandbox without granting native prompt/popups.
export function installLayerDialogs(editor, getDocumentId, showError) {
  const dialog = document.getElementById("host-layer-dialog");
  const title = document.getElementById("host-layer-title");
  const input = document.getElementById("host-layer-name");
  const error = document.getElementById("host-layer-error");
  const accept = document.getElementById("host-layer-accept");
  let pending = null;

  const finish = (value) => {
    const request = pending;
    pending = null;
    if (dialog.open) dialog.close();
    request?.resolve(value);
  };
  const submit = () => {
    if (!pending) return;
    const value = input.value.trim();
    const reason = !value ? "レイヤー名を入力してください。" : pending.validate(value);
    error.textContent = reason ?? "";
    input.setAttribute("aria-invalid", String(Boolean(reason)));
    if (reason) input.focus();
    else finish(value);
  };
  accept.addEventListener("click", submit);
  document.getElementById("host-layer-cancel").addEventListener("click", () => finish(null));
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    finish(null);
  });
  dialog.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if ((event.metaKey || event.ctrlKey) && ["s", "o", "n"].includes(event.key.toLowerCase()))
      event.preventDefault();
    if (
      event.target === input &&
      event.key === "Enter" &&
      !event.isComposing &&
      event.keyCode !== 229
    ) {
      event.preventDefault();
      submit();
    }
  });
  // Keep SVG-Edit's document-level shortcut handlers out of the text field.
  for (const event of ["keypress", "keyup"])
    dialog.addEventListener(event, (event) => event.stopPropagation());

  const ask = (caption, initialValue, actionLabel, validate) => {
    if (pending) return Promise.resolve(null);
    return new Promise((resolve) => {
      title.textContent = caption;
      input.value = initialValue;
      input.setAttribute("aria-invalid", "false");
      error.textContent = "";
      accept.textContent = actionLabel;
      pending = { resolve, validate };
      dialog.showModal();
      input.focus();
      input.select();
    });
  };

  const operate = async (mode) => {
    const canvas = editor.svgCanvas;
    const drawing = canvas.getCurrentDrawing();
    const layer = drawing.getCurrentLayer();
    const documentId = getDocumentId();
    const oldName = drawing.getCurrentLayerName();
    const labels = {
      new: ["レイヤーを作成", "作成"],
      clone: ["レイヤーを複製", "複製"],
      rename: ["レイヤー名を変更", "変更"],
    };
    let initial = oldName;
    if (mode === "new") {
      let index = drawing.getNumLayers() + 1;
      do initial = `${editor.i18next.t("layers.layer")} ${index++}`;
      while (drawing.hasLayer(initial));
    } else if (mode === "clone") {
      initial = `${oldName} のコピー`;
      for (let index = 2; drawing.hasLayer(initial); index++)
        initial = `${oldName} のコピー ${index}`;
    }
    const name = await ask(labels[mode][0], initial, labels[mode][1], (name) =>
      drawing.hasLayer(name) && !(mode === "rename" && name === oldName)
        ? "同じ名前のレイヤーがあります。別の名前を入力してください。"
        : null,
    );
    // Parent navigation/import can replace the document while this is open.
    if (
      name == null ||
      documentId !== getDocumentId() ||
      drawing !== canvas.getCurrentDrawing() ||
      (mode !== "new" && layer !== drawing.getCurrentLayer()) ||
      (mode === "rename" && name === oldName)
    )
      return;
    if (mode === "new") canvas.createLayer(name);
    else if (mode === "clone") canvas.cloneLayer(name);
    else canvas.renameCurrentLayer(name);
    editor.layersPanel.updateContextPanel();
    editor.layersPanel.populateLayers();
  };
  for (const [method, mode] of Object.entries({
    newLayer: "new",
    cloneLayer: "clone",
    layerRename: "rename",
  }))
    editor.layersPanel[method] = () => operate(mode).catch(showError);

  return { cancel: () => finish(null), isOpen: () => dialog.open };
}
