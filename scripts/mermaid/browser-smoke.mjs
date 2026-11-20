// 同梱 Mermaid を実ブラウザ (Chromium) で動かす確認。アプリやデータベースには触れない。
// 単体テストは Mermaid をモックしているので、版を上げた時はこれで実際の描画を確かめる。
// 本番と同じ vite build の出力を、アプリの CSP を付けて 127.0.0.1 から配信し、
// src/modules/mermaid の renderMermaid / renderMermaidPng に見本の図を通す。
// 結果は .generated/mermaid-verification/<版>/ に出し、版ごとの PNG を compare.html で並べる。
import { Buffer } from "node:buffer";
import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { extname, relative, resolve, sep } from "node:path";
import { once } from "node:events";
import process from "node:process";
import { build } from "vite";

import { MERMAID_CORPUS, MERMAID_THEMES } from "./corpus.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const OUTPUT = resolve(ROOT, ".generated/mermaid-verification");
const WORK = resolve(OUTPUT, "work");
const ENTRY = resolve(WORK, "entry/index.html");
const DIST = resolve(WORK, "dist");
const VERSION = JSON.parse(
  readFileSync(resolve(ROOT, "node_modules/mermaid/package.json"), "utf8"),
).version;
const RESULT_DIR = resolve(OUTPUT, VERSION);
const CSP = JSON.parse(readFileSync(resolve(ROOT, "src-tauri/tauri.conf.json"), "utf8")).app
  .security.csp;
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

rmSync(WORK, { recursive: true, force: true });
rmSync(RESULT_DIR, { recursive: true, force: true });
mkdirSync(resolve(WORK, "entry"), { recursive: true });
mkdirSync(RESULT_DIR, { recursive: true });
writeFileSync(
  ENTRY,
  `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>Mermaid smoke</title></head>
<body style="margin:0"><div id="stage" style="display:inline-block;padding:16px"></div>
<script type="module">
import { renderMermaid } from "/src/modules/mermaid/mermaidRenderer.ts";
import { renderMermaidPng } from "/src/modules/mermaid/mermaidExporter.ts";
window.mermaidSmoke = { renderMermaid, renderMermaidPng };
</script></body></html>
`,
);

await build({
  root: ROOT,
  configFile: resolve(ROOT, "vite.config.ts"),
  mode: "production",
  logLevel: "warn",
  publicDir: false,
  build: {
    outDir: DIST,
    emptyOutDir: true,
    chunkSizeWarningLimit: Number.MAX_SAFE_INTEGER,
    rollupOptions: { input: ENTRY },
  },
});

const chunks = readdirSync(resolve(DIST, "assets")).filter((name) => name.endsWith(".js"));
const elkChunks = chunks.filter((name) => /elk/i.test(name));

const server = createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const path = resolve(DIST, `.${decodeURIComponent(url.pathname)}`);
  if (!path.startsWith(DIST + sep) || !existsSync(path)) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {
    "Content-Type": CONTENT_TYPES[extname(path)] ?? "application/octet-stream",
    "Content-Security-Policy": CSP,
  });
  response.end(readFileSync(path));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;

const failures = [];
const requests = [];
const consoleErrors = [];
const results = [];
let browser;
let browserVersion;
try {
  browser = await chromium.launch({ headless: true });
  browserVersion = browser.version();
  const context = await browser.newContext({ viewport: { width: 1600, height: 1200 } });
  await context.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) =>
      window.__cspViolations.push(`${event.violatedDirective} ${event.blockedURI}`),
    );
  });
  const page = await context.newPage();
  page.on("request", (request) => requests.push(request.url()));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(String(error)));
  await page.goto(`${origin}/${relative(ROOT, ENTRY).split(sep).join("/")}`);
  await page.waitForFunction(() => window.mermaidSmoke != null);

  for (const sample of MERMAID_CORPUS) {
    for (const theme of MERMAID_THEMES) {
      const key = `${sample.name}-${theme}`;
      const started = Date.now();
      const outcome = await page.evaluate(
        async ({ source, theme, labels }) => {
          try {
            const svg = await window.mermaidSmoke.renderMermaid(source, theme);
            const document_ = new DOMParser().parseFromString(svg, "image/svg+xml");
            const text = document_.documentElement.textContent ?? "";
            const forbidden = document_.querySelectorAll(
              "script, foreignObject, iframe, object, embed",
            ).length;
            const external = [];
            for (const element of document_.querySelectorAll("*")) {
              for (const attribute of element.attributes) {
                const name = attribute.name.toLowerCase();
                const value = attribute.value.trim();
                if (/^on/.test(name)) external.push(name);
                if (["href", "xlink:href", "src"].includes(name) && !value.startsWith("#"))
                  external.push(`${name}=${value}`);
                if (/url\s*\(\s*["']?(?:https?:|\/\/)/i.test(value)) external.push(value);
              }
            }
            for (const style of document_.querySelectorAll("style")) {
              if (/@import|url\s*\(\s*["']?(?:https?:|\/\/)/i.test(style.textContent ?? ""))
                external.push("style");
            }
            const stage = document.getElementById("stage");
            stage.style.background = theme === "dark" ? "#1e1e1e" : "#ffffff";
            stage.innerHTML = svg;
            const png = await window.mermaidSmoke.renderMermaidPng(svg);
            return {
              ok: true,
              svgBytes: svg.length,
              missing: labels.filter((label) => !text.includes(label)),
              forbidden,
              external,
              gradients: document_.querySelectorAll("linearGradient, radialGradient").length,
              filters: document_.querySelectorAll("filter").length,
              png,
            };
          } catch (error) {
            return { ok: false, error: String(error?.message ?? error).split("\n")[0] };
          }
        },
        { source: sample.source, theme, labels: sample.labels },
      );
      const milliseconds = Date.now() - started;
      if (!outcome.ok) {
        failures.push(`${key}: 描画に失敗 (${outcome.error})`);
        results.push({ key, ok: false, error: outcome.error, milliseconds });
        continue;
      }
      await page.locator("#stage").screenshot({ path: resolve(RESULT_DIR, `${key}.png`) });
      writeFileSync(
        resolve(RESULT_DIR, `${key}.export.png`),
        Buffer.from(outcome.png.slice(outcome.png.indexOf(",") + 1), "base64"),
      );
      if (outcome.missing.length > 0)
        failures.push(`${key}: ラベルが SVG にない (${outcome.missing.join(", ")})`);
      if (outcome.forbidden > 0) failures.push(`${key}: active content が残った`);
      if (outcome.external.length > 0)
        failures.push(`${key}: 外部参照が残った (${outcome.external.slice(0, 3).join(", ")})`);
      const summary = { ...outcome };
      delete summary.png;
      results.push({ key, ...summary, milliseconds });
    }
  }

  const violations = await page.evaluate(() => window.__cspViolations);
  for (const violation of violations) failures.push(`CSP 違反: ${violation}`);
} finally {
  await browser?.close();
  server.close();
}

const outgoing = requests.filter(
  (url) => !url.startsWith(`${origin}/`) && !/^(data|blob):/.test(url),
);
for (const url of outgoing) failures.push(`外向きの通信: ${url}`);
for (const message of consoleErrors) failures.push(`console error: ${message}`);
const loadedChunks = [
  ...new Set(
    requests
      .filter((url) => url.startsWith(`${origin}/assets/`) && url.endsWith(".js"))
      .map((url) => url.slice(`${origin}/assets/`.length)),
  ),
];

const result = {
  mermaid: VERSION,
  chromium: browserVersion,
  samples: results.length,
  failures,
  requests: { total: requests.length, outgoing },
  chunks: { built: chunks.length, loaded: loadedChunks.length, elk: elkChunks },
  elkLoaded: loadedChunks.filter((name) => /elk/i.test(name)),
  results,
};
writeFileSync(resolve(RESULT_DIR, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
writeCompareHtml();

process.stdout.write(
  `Mermaid ${VERSION}: ${results.filter((entry) => entry.ok).length}/${results.length} 件を描画、` +
    `外向きの通信 ${outgoing.length} 件、ELK の chunk ${elkChunks.length} 個 ` +
    `(読み込み ${result.elkLoaded.length} 個)\n${relative(ROOT, RESULT_DIR)}/result.json\n`,
);
if (failures.length > 0) {
  process.stderr.write(`${failures.map((failure) => `- ${failure}`).join("\n")}\n`);
  process.exitCode = 1;
}

/** 出力済みの版をすべて並べた比較ページを作り直す。 */
function writeCompareHtml() {
  const versions = readdirSync(OUTPUT)
    .filter((name) => existsSync(resolve(OUTPUT, name, "result.json")))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const rows = MERMAID_CORPUS.flatMap((sample) =>
    MERMAID_THEMES.map((theme) => {
      const key = `${sample.name}-${theme}`;
      const cells = versions
        .map((version) => {
          const file = `${version}/${key}.png`;
          return existsSync(resolve(OUTPUT, file))
            ? `<td><img src="${file}" alt="${version} ${key}"></td>`
            : "<td>—</td>";
        })
        .join("");
      return `<tr><th>${key}</th>${cells}</tr>`;
    }),
  ).join("\n");
  writeFileSync(
    resolve(OUTPUT, "compare.html"),
    `<!doctype html><html lang="ja"><meta charset="utf-8"><title>Mermaid の版の比較</title>
<style>body{font:13px system-ui;margin:16px}td,th{border:1px solid #ccc;padding:6px;vertical-align:top}
th{text-align:left;white-space:nowrap}img{max-width:640px}</style>
<table><tr><th></th>${versions.map((version) => `<th>${version}</th>`).join("")}</tr>
${rows}
</table></html>
`,
  );
}
