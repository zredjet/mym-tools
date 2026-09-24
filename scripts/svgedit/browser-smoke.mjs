// Real-browser integration check, independent of a user's app/database.
import { Buffer } from "node:buffer";
import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { readFileSync, mkdirSync } from "node:fs";
import { resolve, extname } from "node:path";
import { once } from "node:events";
import assert from "node:assert/strict";
import process from "node:process";
import { prepareVectorAssets } from "./prepare-assets.mjs";
import { verifyEditorRegressions } from "./browser-regressions.mjs";

prepareVectorAssets();
const assets = resolve(".generated/public/svgedit");
const csp = readFileSync("src-tauri/src/modules/vector/protocol.rs", "utf8").match(
  /const EDITOR_CSP: &str = "([^"]+)"/,
)[1];
const missing = [];
const assetServer = createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  const path = resolve(assets, `.${pathname}`);
  if (!path.startsWith(`${assets}/`)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const data = readFileSync(path);
    res.writeHead(200, {
      "Content-Type":
        {
          ".js": "text/javascript",
          ".html": "text/html",
          ".json": "application/json",
          ".svg": "image/svg+xml",
          ".css": "text/css",
          ".png": "image/png",
          ".gif": "image/gif",
        }[extname(path)] ?? "application/octet-stream",
      "Content-Security-Policy": csp,
    });
    res.end(data);
  } catch {
    missing.push(pathname);
    res.writeHead(404).end();
  }
});
assetServer.listen(0, "127.0.0.1");
await once(assetServer, "listening");
const origin = `http://127.0.0.1:${assetServer.address().port}`;
const parentHtml = `<!doctype html><html lang="ja"><title>SVG-Edit integration smoke</title><body style="margin:0"><iframe title="editor" style="border:0;width:100%;height:100vh" sandbox="allow-scripts allow-same-origin" src="${origin}/index.html#parent=http%3A%2F%2Flocalhost%3A1420&session=smoke"></iframe><script>window.messages=[];addEventListener('message',e=>{if(e.origin==='${origin}')messages.push(e.data)});window.rpc=async(action,fields={})=>{const requestId=crypto.randomUUID();frames[0].postMessage({protocol:'mym-vector-v1',session:'smoke',requestId,documentId:'document',action,...fields},'${origin}');for(let i=0;i<600;i++){const message=messages.find(m=>m.requestId===requestId);if(message)return message;await new Promise(r=>setTimeout(r,50))}throw Error('timeout: '+action)};</script></body></html>`;
let browser;
let page;
const outgoing = [],
  errors = [];
try {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({
    permissions: ["local-network-access"],
    viewport: { width: 1440, height: 1000 },
  });
  page.on("requestfailed", (request) =>
    errors.push(`${request.url()} ${request.failure()?.errorText}`),
  );
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", async (dialog) => {
    errors.push(`unexpected native dialog: ${dialog.type()}`);
    await dialog.dismiss();
  });
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text().slice(0, 220));
  });
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === "http://localhost:1420")
      return route.fulfill({ contentType: "text/html", body: parentHtml });
    if (url.origin === origin) return route.continue();
    outgoing.push(url.href);
    return route.abort();
  });
  await page.goto("http://localhost:1420");
  await page.waitForFunction(
    () => window.messages.some((m) => ["ready", "failed"].includes(m.event)),
    null,
    { timeout: 30_000 },
  );
  assert.ok(
    (await page.evaluate(() => window.messages)).some((m) => m.event === "ready"),
    JSON.stringify(await page.evaluate(() => window.messages)),
  );
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="640" height="480"><defs><linearGradient id="paint"><stop offset="0" stop-color="#3366ff"/><stop offset="1" stop-color="#ff6699"/></linearGradient></defs><g><title>レイヤー 1</title><rect x="40" y="40" width="200" height="120" fill="url(#paint)"/><path d="M40 220 C90 150 200 290 260 200" stroke="#224466" fill="none"/><text x="40" y="320" font-size="32">ベクター描画 A&amp;B</text></g></svg>';
  const call = (action, fields) =>
    page.evaluate(({ action, fields }) => window.rpc(action, fields), { action, fields });
  assert.equal((await call("load", { svg })).event, "loaded");
  const initial = await call("snapshot");
  assert.equal(initial.event, "snapshot", JSON.stringify(initial));
  assert.ok(initial.svg.includes("linearGradient"));
  assert.ok(initial.text.includes("ベクター描画 A&B"));
  const frame = page.frames().find((f) => f.url().startsWith(origin));
  mkdirSync(".generated/vector-verification", { recursive: true });
  await verifyEditorRegressions({ frame, call, svg });
  const image = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 32;
    c.height = 32;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#12ab34";
    ctx.fillRect(0, 0, 32, 32);
    return c.toDataURL("image/png");
  });
  assert.equal((await call("insertImage", { data: image })).event, "inserted");
  const inserted = await call("snapshot");
  assert.ok(inserted.svg.includes("data:image/png;base64,"));
  await frame.evaluate(() => window.svgEditor.svgCanvas.undoMgr.undo());
  assert.ok(!(await call("snapshot")).svg.includes("data:image/png;base64,"));
  await frame.evaluate(() => window.svgEditor.svgCanvas.undoMgr.redo());
  assert.ok((await call("snapshot")).svg.includes("data:image/png;base64,"));
  // OS/JSON clipboard and source editing must use the same rejection boundary.
  await frame.evaluate(() => {
    const canvas = window.svgEditor.svgCanvas;
    sessionStorage.setItem(
      canvas.getClipboardID(),
      JSON.stringify([{ element: "script", children: ["alert(1)"] }]),
    );
    canvas.pasteElements();
    canvas.setImageURL("https://example.com/blocked.png");
    window.svgEditor.saveSourceEditor({
      detail: { value: '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject/></svg>' },
    });
  });
  assert.ok(!(await call("snapshot")).svg.includes("foreignObject"));
  assert.ok(!(await call("snapshot")).svg.includes("script"));
  const changedEvents = await page.evaluate(() =>
    window.messages.filter((m) => m.event === "changed"),
  );
  assert.ok(changedEvents.length > 0);
  assert.ok(changedEvents.every((m) => m.svg == null && m.text == null));
  const png = await call("png");
  assert.equal(png.event, "png", JSON.stringify(png));
  const bytes = Buffer.from(png.data.split(",")[1], "base64");
  assert.equal(bytes.readUInt32BE(16), 640);
  assert.equal(bytes.readUInt32BE(20), 480);
  const corner = await page.evaluate(async (data) => {
    const img = new Image();
    img.src = data;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = 640;
    c.height = 480;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    return [...ctx.getImageData(600, 440, 1, 1).data];
  }, png.data);
  assert.equal(corner[3], 0);
  assert.equal((await call("load", { svg: inserted.svg })).event, "loaded");
  for (const mime of ["image/jpeg", "image/webp"]) {
    const data = await page.evaluate((mime) => {
      const canvas = document.createElement("canvas");
      canvas.width = 8;
      canvas.height = 8;
      canvas.getContext("2d").fillRect(0, 0, 8, 8);
      return canvas.toDataURL(mime);
    }, mime);
    assert.ok(data.startsWith(`data:${mime};base64,`));
    assert.equal((await call("insertImage", { data })).event, "inserted");
    assert.ok((await call("snapshot")).svg.includes(`data:${mime};base64,`));
  }
  const beforeRejectedImage = (await call("snapshot")).svg;
  const tooLargeImage = image + "A".repeat(20 * 1024 * 1024);
  assert.equal((await call("insertImage", { data: tooLargeImage })).event, "error");
  assert.equal((await call("snapshot")).svg, beforeRejectedImage);
  // Hold only the decoder callback while the user adds content. Capacity must
  // use the current document, and rejecting the image must retain that edit.
  await frame.evaluate(() => {
    window.originalImage = window.Image;
    window.Image = class {
      naturalWidth = 32;
      naturalHeight = 32;
      set src(value) {
        if (value) window.finishImageDecode = () => this.onload();
      }
    };
  });
  await page.evaluate((data) => {
    window.delayedInsert = window.rpc("insertImage", { data });
  }, image);
  await frame.waitForFunction(() => typeof window.finishImageDecode === "function");
  await frame.evaluate(() => {
    const canvas = window.svgEditor.svgCanvas;
    const element = canvas.importSvgString(
      '<svg xmlns="http://www.w3.org/2000/svg"><g id="decode-race" data-padding=""/></svg>',
      true,
    );
    const size = new TextEncoder().encode(canvas.getSvgString()).length;
    element.setAttribute("data-padding", "a".repeat(20 * 1024 * 1024 - size - 128));
    window.beforeDelayedInsert = canvas.getSvgString();
    window.finishImageDecode();
  });
  const delayed = await page.evaluate(() => window.delayedInsert);
  assert.equal(delayed.event, "error");
  assert.ok(delayed.error.includes("20MiB"));
  assert.ok(
    await frame.evaluate(() => {
      window.Image = window.originalImage;
      return window.svgEditor.svgCanvas.getSvgString() === window.beforeDelayedInsert;
    }),
  );
  assert.equal((await call("load", { svg: beforeRejectedImage })).event, "loaded");
  const rejected = await call("load", {
    svg: '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/private.png"/></svg>',
  });
  assert.equal(rejected.event, "error");
  assert.ok((await call("snapshot")).svg.includes("data:image/png;base64,"));
  assert.deepEqual((await page.context().storageState()).origins, []);
  assert.equal(await frame.evaluate(() => window.svgEditor.configObj.pref("lang")), "ja");
  mkdirSync(".generated/vector-verification", { recursive: true });
  await page.screenshot({ path: ".generated/vector-verification/editor.png" });
  await frame.evaluate(() =>
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true }),
    ),
  );
  await page.waitForFunction(() =>
    window.messages.some(
      (m) => m.event === "action" && m.action === "save" && m.documentId === "document",
    ),
  );
  assert.deepEqual(outgoing, []);
  assert.deepEqual(missing, []);
  assert.deepEqual(errors, []);
  process.stdout.write(
    JSON.stringify({
      result: "pass",
      pngBytes: bytes.length,
      externalRequests: outgoing.length,
      screenshot: ".generated/vector-verification/editor.png",
    }) + "\n",
  );
} catch (error) {
  if (page) {
    console.log(page.frames().map((f) => f.url()));
  }
  process.stderr.write(JSON.stringify({ errors, missing, outgoing }) + "\n");
  throw error;
} finally {
  await browser?.close();
  assetServer.close();
}
