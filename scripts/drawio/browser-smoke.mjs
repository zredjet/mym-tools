// 同梱 draw.io を実ブラウザ (Chromium) で動かす統合確認。アプリやデータベースには触れない。
// アプリと同じ release CSP・sandboxed iframe・embed JSON protocol で、外部通信が 0 件であることも確かめる。
// src/modules/diagram/drawioBridge.ts を Node の型除去 (22.18 以降) でそのまま読み込むため、
// drawioBridge.ts は import を持たない形のままにする。
import { Buffer } from "node:buffer";
import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { once } from "node:events";
import assert from "node:assert/strict";
import process from "node:process";

import {
  drawioEditorUrl,
  drawioExportMessage,
  drawioLoadMessage,
  drawioTargetOrigin,
  parseDrawioMessage,
} from "../../src/modules/diagram/drawioBridge.ts";
import { verifyPageMove, verifyUndoRedo } from "./browser-regressions.mjs";
import {
  EXPECTED_JA,
  MAX_DIAGRAM_BYTES,
  atlassian2DiagramXml,
  contentTypeFor,
  editorAssetContract,
  editorResponseHeaders,
  largeDiagramXml,
  pngSize,
  runtimeExpectations,
  safeAssetPath,
  smokeDiagramXml,
  strayCellXml,
} from "./browser-support.mjs";
import {
  DRAWIO_DOMPURIFY_VERSION,
  DRAWIO_VERSION,
  prepareDrawioAssets,
} from "./prepare-assets.mjs";

const OUTPUT = resolve(".generated/drawio-verification");
const PARENT_ORIGIN = "http://tauri.localhost";
// offline=1 は draw.io の service worker 登録を有効にするが、service-worker.js は同梱せず
// editor CSP も worker-src 'none' なので、この 1 件だけは既知の遮断として許容する。
const allowedViolation = (origin) => `worker-src ${origin}/service-worker.js`;
// ツールバーの「接続」「途中点」は、選択中のスタイルにアイコンが無いと background-image を
// url(null) にする (上流の既存挙動)。loopback 内の 404 で終わるこの 1 パスだけを許容する。
const ALLOWED_MISSING = "null";
const NOT_FOUND_CONSOLE =
  "console: Failed to load resource: the server responded with a status of 404 (Not Found)";

prepareDrawioAssets();
mkdirSync(OUTPUT, { recursive: true });
const expectations = runtimeExpectations(DRAWIO_VERSION);
const contract = editorAssetContract(
  readFileSync("src-tauri/src/modules/diagram/protocol.rs", "utf8"),
);
const assets = resolve(".generated/public/drawio");
const requests = [];
let step = "init";
const resourceTypes = new Map();
const missing = [];

const assetServer = createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const relative = safeAssetPath(url.pathname);
  const send = (status, body, contentType = "text/plain") => {
    requests.push({ path: url.pathname, status, bytes: body.length, step });
    response.writeHead(status, editorResponseHeaders(contract.releaseCsp, contentType));
    response.end(request.method === "HEAD" ? undefined : body);
  };
  if (!["GET", "HEAD"].includes(request.method)) return send(405, "method not allowed");
  if (request.headers.host !== `127.0.0.1:${assetServer.address().port}`) {
    return send(400, "invalid request");
  }
  if (relative == null) return send(400, "invalid request");
  try {
    send(200, readFileSync(resolve(assets, relative)), contentTypeFor(contract, relative));
  } catch {
    missing.push(relative);
    send(404, "not found");
  }
});
assetServer.listen(0, "127.0.0.1");
await once(assetServer, "listening");
const editorUrl = drawioEditorUrl(`http://127.0.0.1:${assetServer.address().port}/index.html`);
const editorOrigin = drawioTargetOrigin(editorUrl);
const parentHtml = `<!doctype html><html lang="ja"><title>draw.io smoke</title><body style="margin:0"><iframe id="editor" title="draw.io オフラインエディタ" style="border:0;width:100%;height:100vh" sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer" src="${editorUrl.replaceAll("&", "&amp;")}"></iframe><script>
const frame = document.getElementById("editor");
window.messages = [];
window.foreign = [];
addEventListener("message", (event) => {
  if (event.source === frame.contentWindow && event.origin === ${JSON.stringify(editorOrigin)}) window.messages.push(event.data);
  else window.foreign.push(String(event.origin));
});
window.send = (message) => frame.contentWindow.postMessage(typeof message === "string" ? message : JSON.stringify(message), ${JSON.stringify(editorOrigin)});
window.waitEvent = async (name, after, requestId, timeout) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (let index = after; index < window.messages.length; index += 1) {
      let value;
      try { value = JSON.parse(window.messages[index]); } catch { continue; }
      if (value.event === name && (requestId == null || value.message?.requestId === requestId)) return { index, raw: window.messages[index] };
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timeout waiting for " + name);
};
</script></body></html>`;

let browser;
let page;
const outgoing = [];
const errors = [];
const warnings = [];
const result = { version: DRAWIO_VERSION, expectations };
const deferred = [];
const expect = (name, condition, detail) => {
  result.checks ??= {};
  result.checks[name] = Boolean(condition);
  if (!condition) deferred.push(`${name}: ${detail ?? "期待と異なる"}`);
};

try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    permissions: ["local-network-access"],
    viewport: { width: 1440, height: 1000 },
  });
  await context.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) =>
      window.__cspViolations.push(`${event.violatedDirective} ${event.blockedURI}`),
    );
  });
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === PARENT_ORIGIN)
      return route.fulfill({ contentType: "text/html", body: parentHtml });
    if (url.origin === editorOrigin) return route.continue();
    outgoing.push(url.href);
    return route.abort();
  });
  page = await context.newPage();
  page.on("request", (request) => {
    if (request.url().startsWith(editorOrigin)) {
      resourceTypes.set(new URL(request.url()).pathname, request.resourceType());
    }
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("requestfailed", (request) => {
    const failure = `${request.url()} ${request.failure()?.errorText}`;
    if (!outgoing.includes(request.url())) errors.push(`requestfailed: ${failure}`);
  });
  page.on("dialog", async (dialog) => {
    errors.push(`dialog: ${dialog.type()} ${dialog.message()}`);
    await dialog.dismiss();
  });
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text().slice(0, 300)}`);
    if (message.type() === "warning") warnings.push(message.text().slice(0, 300));
  });

  const count = () => page.evaluate(() => window.messages.length);
  const send = (message) => page.evaluate((value) => window.send(value), message);
  const waitEvent = async (name, { after = 0, requestId = null, timeout = 30_000 } = {}) => {
    const { raw } = await page.evaluate(
      ([n, a, r, t]) => window.waitEvent(n, a, r, t),
      [name, after, requestId, timeout],
    );
    const parsed = parseDrawioMessage(raw);
    assert.ok(parsed, `parseDrawioMessage が ${name} を拒否した`);
    return { parsed, value: JSON.parse(raw) };
  };
  const eventsAfter = (after, name) =>
    page.evaluate(
      ([a, n]) =>
        window.messages.slice(a).filter((raw) => {
          try {
            return JSON.parse(raw).event === n;
          } catch {
            return false;
          }
        }).length,
      [after, name],
    );
  const load = async (xml, title = "スモークテスト") => {
    const after = await count();
    await send(drawioLoadMessage(xml, title));
    return (await waitEvent("load", { after, timeout: 60_000 })).parsed;
  };
  const invoke = async (actionName) => send({ action: "invokeAction", actionName });
  const saveXml = async () => {
    const after = await count();
    await invoke("save");
    return (await waitEvent("save", { after })).parsed.xml;
  };
  const textContent = async () => {
    const requestId = crypto.randomUUID();
    await send({ action: "textContent", requestId });
    return (await waitEvent("textContent", { requestId })).parsed.data;
  };
  const exportImage = async (format) => {
    const requestId = crypto.randomUUID();
    await send(drawioExportMessage(format, requestId));
    const { parsed } = await waitEvent("export", { requestId });
    assert.equal(parsed.format, format);
    return parsed.data;
  };
  const decodePng = async (dataUri) => {
    assert.ok(dataUri.startsWith("data:image/png;base64,"), dataUri.slice(0, 40));
    const bytes = Buffer.from(dataUri.slice("data:image/png;base64,".length), "base64");
    const size = pngSize(bytes);
    const corner = await page.evaluate(async (data) => {
      const image = new Image();
      image.src = data;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      return [...context.getImageData(image.width - 1, image.height - 1, 1, 1).data];
    }, dataUri);
    return { bytes, ...size, cornerAlpha: corner[3] };
  };

  await page.goto(`${PARENT_ORIGIN}/`);
  const started = performance.now();
  await waitEvent("init", { timeout: 90_000 });
  result.initMs = Math.round(performance.now() - started);
  const frame = page.frames().find((candidate) => candidate.url().startsWith(editorOrigin));
  assert.ok(frame, "draw.io の iframe が見つからない");
  const frameUrl = new URL(frame.url());
  const expectedUrl = new URL(editorUrl);
  assert.equal(frameUrl.origin + frameUrl.pathname, expectedUrl.origin + expectedUrl.pathname);
  assert.deepEqual(
    Object.fromEntries(frameUrl.searchParams),
    Object.fromEntries(expectedUrl.searchParams),
  );

  const runtime = await frame.evaluate(() => ({
    version: window.EditorUi.VERSION,
    domPurify: window.DOMPurify?.version ?? null,
    exportUrl: window.EXPORT_URL ?? null,
    urlParams: {
      embed: window.urlParams.embed,
      proto: window.urlParams.proto,
      lang: window.urlParams.lang,
      offline: window.urlParams.offline,
      lockdown: window.urlParams.lockdown,
    },
    save: window.mxResources.get("save"),
    orthogonalEnds: window.mxResources.get("orthogonalEnds"),
    atlassian2Palette: typeof window.Sidebar?.prototype.addAtlassian2Palette === "function",
    atlassian2Shape: typeof window.mxCellRenderer.defaultShapes["mxgraph.atlassian2.icon"],
  }));
  result.runtime = runtime;
  assert.equal(runtime.version, DRAWIO_VERSION);
  assert.equal(runtime.domPurify, DRAWIO_DOMPURIFY_VERSION);
  assert.deepEqual(runtime.urlParams, {
    embed: "1",
    proto: "json",
    lang: "ja",
    offline: "1",
    lockdown: "1",
  });
  assert.equal(runtime.save, EXPECTED_JA.save);
  expect(
    "exportUrlIsNull",
    (runtime.exportUrl === null) === expectations.exportUrlIsNull,
    `EXPORT_URL=${runtime.exportUrl}`,
  );
  expect(
    "orthogonalEnds",
    (runtime.orthogonalEnds === EXPECTED_JA.orthogonalEnds) === expectations.orthogonalEnds,
    `orthogonalEnds=${runtime.orthogonalEnds}`,
  );
  expect(
    "atlassian2",
    (runtime.atlassian2Palette && runtime.atlassian2Shape === "function") ===
      expectations.atlassian2,
    JSON.stringify(runtime),
  );

  // 保存済みの図を開き直しても未保存にならない前提 (DiagramWorkspacePage の load 処理)。
  const smokeXml = smokeDiagramXml();
  let after = await count();
  step = "load";
  const loaded = await load(smokeXml);
  assert.equal(loaded.xml, smokeXml, "load の応答 XML が入力と一致しない");
  await page.waitForTimeout(1_500);
  assert.equal(await eventsAfter(after, "autosave"), 0, "読込だけで autosave が送られた");
  await page.screenshot({ path: resolve(OUTPUT, "editor.png") });

  step = "textContent";
  const text = await textContent();
  result.textContent = text;
  for (const label of ["開始", "処理", "太字", "plain"]) {
    assert.ok(text.includes(label), `textContent に ${label} が無い`);
  }

  step = "export";
  const page1 = await decodePng(await exportImage("png"));
  writeFileSync(resolve(OUTPUT, "export-page1.png"), page1.bytes);
  const svg = await exportImage("svg");
  writeFileSync(resolve(OUTPUT, "export-page1.svg"), svg);
  assert.ok(svg.includes('id="ge-svg-'), "SVG に draw.io の書出し印が無い");
  for (const label of ["開始", "plain"]) assert.ok(svg.includes(label), `SVG に ${label} が無い`);
  assert.ok(!/<script/i.test(svg), "SVG に script がある");
  assert.ok(!/\son[a-z]+\s*=/i.test(svg), "SVG にイベント属性がある");
  const svgUrls = [...svg.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((match) => match[0]);
  result.svgUrls = [...new Set(svgUrls)];
  for (const url of svgUrls) {
    assert.ok(
      url.startsWith("http://www.w3.org/") ||
        url.startsWith("https://www.drawio.com/doc/faq/svg-export-text-problems"),
      `SVG に想定外の URL がある: ${url}`,
    );
  }

  after = await count();
  step = "nextPage";
  await invoke("nextPage");
  await textContent();
  await page.waitForTimeout(1_500);
  result.autosaveAfterPageSwitch = await eventsAfter(after, "autosave");
  const page2 = await decodePng(await exportImage("png"));
  writeFileSync(resolve(OUTPUT, "export-page2.png"), page2.bytes);
  result.png = {
    page1: { width: page1.width, height: page1.height, cornerAlpha: page1.cornerAlpha },
    page2: { width: page2.width, height: page2.height, cornerAlpha: page2.cornerAlpha },
  };
  assert.equal(page1.cornerAlpha, 255, "PNG が透過になっている");
  assert.ok(
    page2.width > page1.width * 1.5 && page2.height > page1.height * 1.5,
    `currentPage の PNG がページごとに変わらない: ${JSON.stringify(result.png)}`,
  );
  const pageTwoText = await textContent();
  for (const label of ["レーン", "子A", "子B", "外部"]) {
    assert.ok(pageTwoText.includes(label), `2 ページ目の textContent に ${label} が無い`);
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (requests.some((request) => request.path.startsWith("/math4/"))) break;
    await page.waitForTimeout(100);
  }
  result.mathRequests = requests.filter((request) => request.path.startsWith("/math4/")).length;
  assert.ok(result.mathRequests > 0, "数式のある 2 ページ目で math4 が読み込まれない");

  step = "plantUml";
  result.plantUml = await frame.evaluate(async () => {
    await new Promise((resolveLoad, rejectLoad) =>
      window.mxscript(
        window.DRAWIO_SERVER_URL + "js/plantuml/drawio-plantuml.min.js",
        resolveLoad,
        null,
        null,
        null,
        rejectLoad,
      ),
    );
    const converted = window.mxPlantUmlToDrawio.parseText(
      "@startuml\nAlice -> Bob: こんにちは\n@enduml",
      {},
    );
    const xml = typeof converted === "string" ? converted : JSON.stringify(converted);
    return {
      supported: window.EditorUi.isNativePlantUmlSupported(),
      type: typeof converted,
      containsAlice: xml.includes("Alice"),
      bytes: xml.length,
    };
  });
  assert.ok(
    result.plantUml.supported && result.plantUml.containsAlice,
    JSON.stringify(result.plantUml),
  );

  step = "atlassian2";
  if (expectations.atlassian2) {
    await load(atlassian2DiagramXml(), "Atlassian");
    const stencil = await frame.evaluate(async () => {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (window.mxStencilRegistry.getStencil("mxgraph.atlassian2.admin") != null) return true;
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      }
      return false;
    });
    expect("atlassian2Stencil", stencil, "mxgraph.atlassian2.admin が読み込まれない");
    const icon = await decodePng(await exportImage("png"));
    writeFileSync(resolve(OUTPUT, "export-atlassian2.png"), icon.bytes);
  }

  step = "strayCell";
  const strayXml = strayCellXml();
  after = await count();
  const strayLoaded = await load(strayXml, "迷子");
  assert.equal(strayLoaded.xml, strayXml, "親の無い cell を含む図の load 応答が入力と一致しない");
  await page.waitForTimeout(1_500);
  result.autosaveAfterStrayLoad = await eventsAfter(after, "autosave");
  const strayText = await textContent();
  const straySaved = await saveXml();
  result.strayCell = {
    text: strayText,
    keptInSave: /<mxCell id="stray"[^>]*parent="1"/.test(straySaved),
    warning: warnings.some((warning) => warning.includes("cell without a parent")),
  };
  expect(
    "strayCellAdopted",
    (strayText.includes("正常セル") &&
      strayText.includes("迷子セル") &&
      result.strayCell.keptInSave) === expectations.strayCellAdopted,
    JSON.stringify(result.strayCell),
  );

  step = "undoRedo";
  result.undoRedo = await verifyUndoRedo({ load, invoke, saveXml, textContent, smokeXml });
  step = "pageMove";
  result.pageMove = await verifyPageMove({ page, frame, load, invoke, saveXml, smokeXml });

  // 手動受入用のファイル。1 MiB 未満の図は保存時の膨張を見込んで 32 KiB 以上の余裕を取る。
  writeFileSync(resolve(OUTPUT, "smoke-multipage.drawio"), smokeXml);
  writeFileSync(resolve(OUTPUT, "stray-cell.drawio"), strayXml);
  const underTarget = Math.floor(
    (MAX_DIAGRAM_BYTES - 32 * 1024) / result.undoRedo.savedToInputRatio,
  );
  writeFileSync(resolve(OUTPUT, "large-under-1mib.drawio"), largeDiagramXml(underTarget));
  writeFileSync(
    resolve(OUTPUT, "large-over-1mib.drawio"),
    largeDiagramXml(MAX_DIAGRAM_BYTES + 32 * 1024),
  );

  const messages = await page.evaluate(() => window.messages);
  result.messages = messages.length;
  assert.equal(
    messages.filter((raw) => parseDrawioMessage(raw)?.event === "init").length,
    1,
    "init が 1 回ではない",
  );
  const rejected = messages.filter((raw) => parseDrawioMessage(raw) == null);
  assert.deepEqual(
    rejected.map((raw) => raw.slice(0, 120)),
    [],
    "アプリが拒否する message がある",
  );
  assert.deepEqual(
    await page.evaluate(() => window.foreign),
    [],
    "iframe 以外からの message がある",
  );

  const violations = (
    await Promise.all(page.frames().map((f) => f.evaluate(() => window.__cspViolations ?? [])))
  ).flat();
  result.cspViolations = violations;
  const unexpectedViolations = violations.filter((v) => v !== allowedViolation(editorOrigin));
  const unexpectedMissing = missing.filter((path) => path !== ALLOWED_MISSING);
  result.nullToolbarImageRequests = missing.length - unexpectedMissing.length;
  let allowedNotFound = unexpectedMissing.length === 0 ? missing.length : 0;
  const unexpectedErrors = errors.filter((error) => {
    if (
      violations.includes(allowedViolation(editorOrigin)) &&
      error.startsWith("console: ") &&
      error.includes("service-worker.js")
    ) {
      return false;
    }
    if (error === NOT_FOUND_CONSOLE && allowedNotFound > 0) {
      allowedNotFound -= 1;
      return false;
    }
    return true;
  });
  result.allowedErrors = errors.filter((error) => !unexpectedErrors.includes(error));
  assert.deepEqual(outgoing, [], "外部への通信がある");
  assert.deepEqual(unexpectedMissing, [], "同梱資産が欠けている");
  assert.deepEqual(unexpectedViolations, [], "想定外の CSP 違反がある");
  assert.deepEqual(unexpectedErrors, [], "JS / console のエラーがある");
  assert.deepEqual(deferred, [], "版ごとの期待値と異なる");

  result.result = "pass";
  result.requests = requests.length;
  result.bytesServed = requests.reduce((total, request) => total + request.bytes, 0);
  result.svgBytes = Buffer.byteLength(svg);
  result.externalRequests = outgoing.length;
  writeFileSync(
    resolve(OUTPUT, `smoke-result-${DRAWIO_VERSION}.json`),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  process.stdout.write(
    `${JSON.stringify({
      result: "pass",
      version: DRAWIO_VERSION,
      domPurify: runtime.domPurify,
      initMs: result.initMs,
      requests: result.requests,
      png: result.png,
      undoRedo: result.undoRedo.timings,
      externalRequests: 0,
    })}\n`,
  );
} catch (error) {
  result.result = "fail";
  result.error = String(error?.stack ?? error);
  Object.assign(result, {
    errors,
    warnings: warnings.slice(0, 20),
    missing,
    outgoing,
    deferred,
    failedRequests: requests
      .filter((request) => request.status !== 200)
      .map((request) => ({ ...request, type: resourceTypes.get(request.path) })),
  });
  writeFileSync(
    resolve(OUTPUT, `smoke-result-${DRAWIO_VERSION}.json`),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  if (page) await page.screenshot({ path: resolve(OUTPUT, "failure.png") }).catch(() => {});
  process.stderr.write(`${JSON.stringify({ errors, missing, outgoing, deferred })}\n`);
  throw error;
} finally {
  await browser?.close();
  assetServer.close();
}
