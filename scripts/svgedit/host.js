import {
  validateSvg,
  validateImageData,
  renderPng,
  decodeImage,
  MAX_SVG_BYTES,
  utf8Size,
  MAX_PNG_PIXELS,
  MAX_PNG_SIDE,
} from "./svg-policy.js";
import { installLayerDialogs } from "./layer-dialog.js";

// The iframe has its own origin and no Tauri capability. Clipboard and editor
// preferences last only for this editor instance, never across app sessions.
function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}
Object.defineProperty(window, "localStorage", { value: memoryStorage() });
Object.defineProperty(window, "sessionStorage", { value: memoryStorage() });
const { default: Editor } = await import("./Editor.js");

const params = new URLSearchParams(location.hash.slice(1));
const parentOrigin = params.get("parent");
const session = params.get("session");
const allowedParents = new Set([
  "tauri://localhost",
  "http://tauri.localhost",
  "http://localhost:1420",
]);
const errorBox = document.getElementById("host-error");
const showError = (error) => {
  errorBox.textContent = String(error.message ?? error);
  errorBox.hidden = false;
};
if (!allowedParents.has(parentOrigin) || !session) throw new Error("親画面の接続情報が不正です。");
const policy = await (await fetch("./policy.json")).json();
const post = (event, extra = {}) =>
  parent.postMessage({ protocol: "mym-vector-v1", session, event, ...extra }, parentOrigin);
let documentId = null;
let revision = 0;
let loading = false;
const translations = await (await fetch("./ja.json")).json();
const editor = new Editor(document.getElementById("container"));
// Install before init(): SVG-Edit binds these panel methods to its buttons.
const layerDialog = installLayerDialogs(editor, () => documentId, showError);
// Install missing Japanese core strings before UI components first render.
Object.defineProperty(editor, "i18next", {
  configurable: true,
  set(instance) {
    instance.addResourceBundle("ja", "translation", translations.core, true, true);
    Object.defineProperty(editor, "i18next", {
      value: instance,
      writable: true,
      configurable: true,
    });
  },
});
editor.setConfig({
  lang: "ja",
  dimensions: [640, 480],
  no_save_warning: true,
  noDefaultExtensions: true,
  extensions: [],
  userExtensions: [],
  preventAllURLConfig: true,
  preventURLContentLoading: true,
  noStorageOnLoad: true,
  img_save: "embed",
});
// Configuration is session-only. Do not offer background URLs/language reloads.
editor.configObj.loadFromStorage = () => {};
editor.exportHandler = () => post("action", { documentId, action: "exportPng" });
const extensions = [
  "connector",
  "eyedropper",
  "grid",
  "markers",
  "panning",
  "shapes",
  "polystar",
  "layer_view",
];
try {
  await editor.init();
  const addResources = editor.i18next.addResourceBundle.bind(editor.i18next);
  editor.i18next.addResourceBundle = (lang, namespace, resources, ...args) =>
    addResources(
      lang,
      namespace,
      lang === "ja" ? (translations[namespace] ?? resources) : resources,
      ...args,
    );
  // init() doesn't await default extension loading. Load our explicit allowlist
  // sequentially and signal ready only when every extension is initialized.
  for (const name of extensions) {
    const module = await import(`./extensions/ext-${name}/ext-${name}.js`);
    await editor.addExtension(
      module.default.name ?? `ext-${name}`,
      module.default.init.bind(editor),
      { langParam: "ja" },
    );
  }
  const canvas = editor.svgCanvas;
  for (const method of ["makeHyperlink", "setLinkURL"]) {
    const original = canvas[method].bind(canvas);
    canvas[method] = (value) => {
      if (value && !/^#[\w.:-]+$/.test(value)) {
        showError(new Error("リンクは文書内の#id参照だけを使用できます。"));
        return false;
      }
      return original(value);
    };
  }
  const setImageURL = canvas.setImageURL.bind(canvas);
  canvas.setImageURL = (url) => {
    try {
      validateImageData(url);
      return setImageURL(url);
    } catch (error) {
      showError(error);
      return false;
    }
  };
  const saveSource = editor.saveSourceEditor.bind(editor);
  editor.saveSourceEditor = (event) => {
    try {
      validateSvg(event.detail.value, policy);
      return saveSource(event);
    } catch (error) {
      showError(error);
      return false;
    }
  };
  for (const method of ["setSvgString", "importSvgString"]) {
    const original = canvas[method].bind(canvas);
    canvas[method] = (svg, ...args) => {
      try {
        validateSvg(svg, policy);
        return original(svg, ...args);
      } catch (error) {
        showError(error);
        return false;
      }
    };
  }
  const changed = () => {
    if (loading || !documentId) return;
    revision += 1;
    post("changed", { documentId, revision });
  };
  // Layer visibility/order and document title only add history; they do not
  // emit elementChanged. Keep the normal events for live edits and Undo/Redo.
  const addHistory = canvas.undoMgr.addCommandToHistory.bind(canvas.undoMgr);
  canvas.undoMgr.addCommandToHistory = (...args) => {
    const result = addHistory(...args);
    changed();
    return result;
  };
  // The bundled UndoManager can leave its layer index stale after a batch
  // inserts/removes a layer. Reconcile only when the SVG and index differ.
  for (const method of ["undo", "redo"]) {
    const original = canvas.undoMgr[method].bind(canvas.undoMgr);
    canvas.undoMgr[method] = (...args) => {
      const result = original(...args);
      const drawing = canvas.getCurrentDrawing();
      const groups = [...canvas.getSvgContent().children].filter((element) =>
        canvas.isLayer(element),
      );
      const current = drawing.getCurrentLayer();
      if (
        groups.length !== drawing.getNumLayers() ||
        groups.some((group, index) => {
          const name = drawing.getLayerName(index);
          const title = [...group.children].find((element) => element.localName === "title");
          return drawing.getLayerByName(name) !== group || title?.textContent !== name;
        })
      ) {
        drawing.identifyLayers();
        const index = groups.indexOf(current);
        if (index >= 0) drawing.setCurrentLayer(drawing.getLayerName(index));
        editor.layersPanel.populateLayers();
      }
      return result;
    };
  }
  document.getElementById("se-svg-editor-dialog")?.shadowRoot?.addEventListener("input", changed);
  const pasteElements = canvas.pasteElements.bind(canvas);
  canvas.pasteElements = (...args) => {
    try {
      const raw = sessionStorage.getItem(canvas.getClipboardID());
      if (!raw) return;
      if (utf8Size(raw) > MAX_SVG_BYTES) throw new Error("貼り付ける内容が大きすぎます。");
      const entries = JSON.parse(raw);
      if (!Array.isArray(entries)) return;
      const root = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      const build = (entry) => {
        if (typeof entry === "string") return document.createTextNode(entry);
        const element = document.createElementNS(
          entry.namespace ?? root.namespaceURI,
          entry.element,
        );
        for (const [key, value] of Object.entries(entry.attr ?? {})) {
          const ns = key.startsWith("xlink:")
            ? "http://www.w3.org/1999/xlink"
            : key.startsWith("xml:")
              ? "http://www.w3.org/XML/1998/namespace"
              : key.startsWith("se:")
                ? "http://svg-edit.googlecode.com"
                : null;
          element.setAttributeNS(ns, key, String(value));
        }
        for (const child of entry.children ?? []) element.append(build(child));
        return element;
      };
      for (const entry of entries) root.append(build(entry));
      const svg = new XMLSerializer().serializeToString(root);
      validateSvg(svg, policy);
      if (utf8Size(canvas.getSvgString()) + utf8Size(svg) + 1024 > MAX_SVG_BYTES)
        throw new Error("貼り付けるとSVGが20MiBを超えます。");
      return pasteElements(...args);
    } catch (error) {
      showError(error);
      return false;
    }
  };
  await editor.addExtension(
    "mym-host",
    () => ({ elementChanged: changed, onOpenedDocument: changed, afterClear: changed }),
    {},
  );
  document.addEventListener(
    "keydown",
    (event) => {
      if (layerDialog.isOpen()) return;
      if ((event.metaKey || event.ctrlKey) && ["s", "o", "n"].includes(event.key.toLowerCase())) {
        event.preventDefault();
        event.stopImmediatePropagation();
        post("action", {
          documentId,
          action: { s: "save", o: "import", n: "new" }[event.key.toLowerCase()],
        });
      }
    },
    true,
  );
  // OS drops/paste are handled by the parent input path; do not let SVGEdit's
  // generic browser importer bypass the validation/size boundary.
  document.addEventListener(
    "drop",
    (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true,
  );
  document.addEventListener(
    "paste",
    (event) => {
      if (event.clipboardData?.files.length) {
        event.preventDefault();
        showError(new Error("画像は「画像を挿入」から追加してください。"));
      }
    },
    true,
  );
  const snapshot = () => {
    // Commit a pending source-editor edit before serializing. Failure leaves
    // the source dialog open and refuses the operation.
    const source = document.getElementById("se-svg-editor-dialog");
    if (source?.getAttribute("dialog") === "open")
      throw new Error("SVGソースの編集を確定してから保存してください。");
    if (layerDialog.isOpen()) throw new Error("レイヤー名の入力を確定または取り消してください。");
    const payload = validateSvg(canvas.getSvgString(), policy);
    return { ...payload, revision };
  };
  let working = false;
  window.addEventListener("message", async (event) => {
    const message = event.data;
    if (
      event.source !== parent ||
      event.origin !== parentOrigin ||
      !message ||
      message.protocol !== "mym-vector-v1" ||
      message.session !== session ||
      typeof message.requestId !== "string" ||
      message.requestId.length > 100 ||
      typeof message.documentId !== "string" ||
      message.documentId.length > 100 ||
      !["load", "snapshot", "png", "insertImage"].includes(message.action)
    )
      return;
    const reply = (eventName, extra = {}) =>
      post(eventName, { requestId: message.requestId, documentId: message.documentId, ...extra });
    if (working) {
      reply("error", { error: "前の操作の完了を待ってください。" });
      return;
    }
    working = true;
    try {
      errorBox.hidden = true;
      if (message.action === "load") {
        validateSvg(message.svg, policy);
        layerDialog.cancel();
        loading = true;
        editor.hideSourceEditor();
        editor.loadSvgString(message.svg);
        canvas.undoMgr.resetUndoStack();
        documentId = message.documentId;
        revision = 0;
        reply("loaded", snapshot());
      } else {
        if (!documentId || documentId !== message.documentId)
          throw new Error("編集対象が変わりました。");
        if (message.action === "snapshot") reply("snapshot", snapshot());
        else if (message.action === "png") {
          const data = snapshot();
          reply("png", { data: await renderPng(data.svg, policy), revision: data.revision });
        } else if (message.action === "insertImage") {
          if (typeof message.data !== "string" || utf8Size(message.data) > MAX_SVG_BYTES)
            throw new Error("画像が大きすぎます。");
          validateImageData(message.data);
          const img = await decodeImage(message.data);
          if (
            img.naturalWidth > MAX_PNG_SIDE ||
            img.naturalHeight > MAX_PNG_SIDE ||
            img.naturalWidth * img.naturalHeight > MAX_PNG_PIXELS
          )
            throw new Error("画像の寸法が上限を超えています。");
          // Editing continues during decode; measure the document at insertion.
          const before = snapshot();
          if (utf8Size(before.svg) + utf8Size(message.data) + 1024 > MAX_SVG_BYTES)
            throw new Error("画像を追加するとSVGが20MiBを超えます。");
          const element = document.createElementNS("http://www.w3.org/2000/svg", "image");
          for (const [key, value] of Object.entries({
            x: 0,
            y: 0,
            width: img.naturalWidth,
            height: img.naturalHeight,
          }))
            element.setAttribute(key, String(value));
          element.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", message.data);
          // Import via the normal SVG insertion path to retain one Undo step.
          const wrapper = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">${new XMLSerializer().serializeToString(element)}</svg>`;
          const inserted = canvas.importSvgString(wrapper, true);
          if (!inserted) throw new Error("画像を挿入できません。");
          canvas.selectOnly([inserted]);
          changed();
          reply("inserted", { revision });
        } else throw new Error("未対応の操作です。");
      }
    } catch (error) {
      showError(error);
      reply("error", { error: String(error.message ?? error) });
    } finally {
      loading = false;
      working = false;
    }
  });
  post("ready");
} catch (error) {
  showError(error);
  post("failed", { error: String(error.message ?? error) });
}
