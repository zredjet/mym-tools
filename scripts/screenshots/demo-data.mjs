#!/usr/bin/env node
/**
 * README の画面イメージ用のデモデータ (エクスポート JSON、`docs/data-model.md` §12) を作る。
 *
 * 出力先は `.generated/screenshots/demo.mymtools.json`。撮影用の別 identifier で起動したアプリの
 * 「設定 > JSON からインポート」で取り込む。手順は `docs/images/screenshots/README.md`。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const output = join(root, ".generated", "screenshots", "demo.mymtools.json");

let nextId = 1;
const id = () => `5c0e1d2a-0000-4000-8000-${String(nextId++).padStart(12, "0")}`;

// 一覧の相対時刻 (「2 時間前」など) がばらけるよう、実行時刻から数分〜数日前に散らす。
// 一覧は updated_at の新しい順なので、並べたい順に古くする
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const AGES_MINUTES = [12, 65, 190, 420, 1_500, 2_900, 4_400, 7_300, 11_000, 15_000];
const now = Date.now();
let count = 0;
const timestamp = () => {
  const index = count++;
  const minutes =
    AGES_MINUTES[index % AGES_MINUTES.length] + Math.floor(index / AGES_MINUTES.length) * 7;
  return formatJst(now - minutes * 60_000);
};

function formatJst(epochMs) {
  return `${new Date(epochMs + JST_OFFSET_MS).toISOString().replace("Z", "")}+09:00`;
}

function item(moduleId, title, payload, tags = []) {
  const at = timestamp();
  return {
    id: id(),
    module_id: moduleId,
    title,
    tags,
    payload_schema_version: 1,
    payload,
    created_at: at,
    updated_at: at,
  };
}

function project(name, description, items) {
  const at = formatJst(now - 30 * 24 * 60 * 60_000);
  const counts = new Map();
  return {
    id: id(),
    name,
    description,
    created_at: at,
    updated_at: at,
    items: items.map((entry) => {
      const position = counts.get(entry.module_id) ?? 0;
      counts.set(entry.module_id, position + 1);
      return { ...entry, position };
    }),
  };
}

const prompts = [
  item(
    "prompt",
    "コードレビュー依頼",
    {
      body: [
        "あなたは経験豊富な {{言語}} のレビュアーです。",
        "次の差分をレビューし、バグ・読みやすさ・テストの観点で指摘してください。",
        "指摘には重要度 (高 / 中 / 低) を付け、修正案をコードで示してください。",
        "",
        "## 背景",
        "{{背景}}",
        "",
        "## 差分",
        "{{差分}}",
      ].join("\n"),
    },
    ["review"],
  ),
  item(
    "prompt",
    "コミットメッセージ作成",
    {
      body: [
        "次の変更から、Conventional Commits 形式のコミットメッセージを日本語で作ってください。",
        "1 行目は 50 文字以内、本文には変更の理由を書いてください。",
        "",
        "種類: {{種類}}",
        "変更内容: {{変更内容}}",
      ].join("\n"),
    },
    ["git"],
  ),
  item(
    "prompt",
    "SQL のチューニング相談",
    {
      body: [
        "{{DB}} で次のクエリが遅いです。実行計画を読み、インデックスと書き換えの案を出してください。",
        "",
        "```sql",
        "{{クエリ}}",
        "```",
        "",
        "テーブルの件数: {{件数}}",
      ].join("\n"),
    },
    ["db"],
  ),
  item(
    "prompt",
    "議事録の要約",
    {
      body: "次の会議メモを、決定事項・宿題 (担当と期限)・未決事項に分けて要約してください。\n\n{{メモ}}",
    },
    ["meeting"],
  ),
  item(
    "prompt",
    "英文メールの添削",
    {
      body: "次の英文メールを、{{相手}} 向けの丁寧なビジネス英語に直してください。変更点の理由も日本語で添えてください。\n\n{{本文}}",
    },
    ["english"],
  ),
];

const links = [
  item(
    "linkmemo",
    "リポジトリ (GitHub)",
    {
      type: "url",
      target: "https://github.com/example/portal",
      body: "main は保護ブランチ。PR は 1 承認でマージ",
    },
    ["dev"],
  ),
  item(
    "linkmemo",
    "ステージング環境",
    {
      type: "url",
      target: "https://staging.portal.example.com",
      body: "",
    },
    ["env"],
  ),
  item(
    "linkmemo",
    "Tauri 2 ドキュメント",
    {
      type: "url",
      target: "https://v2.tauri.app/",
      body: "",
    },
    ["docs"],
  ),
  item(
    "linkmemo",
    "MDN Web Docs",
    {
      type: "url",
      target: "https://developer.mozilla.org/ja/",
      body: "",
    },
    ["docs"],
  ),
  item(
    "linkmemo",
    "デザイン共有フォルダ",
    {
      type: "path",
      target: "\\\\nas\\share\\design\\portal",
      body: "デザイナーとの共有。週次で更新",
    },
    ["design"],
  ),
  item(
    "linkmemo",
    "作業ディレクトリ",
    {
      type: "path",
      target: "/Users/demo/Projects/portal",
      body: "",
    },
    ["dev"],
  ),
];

const memos = [
  item(
    "memo",
    "リリース手順メモ",
    {
      body: [
        "# リリース手順メモ",
        "",
        "ステージングで受入を終えてから、本番へ出す。",
        "",
        "## 手順",
        "",
        "1. `main` の CI がすべて通っていることを確認する",
        "2. タグを付けて push する",
        "3. デプロイのワークフローを実行する",
        "4. **本番の動作確認** をして、Slack で告知する",
        "",
        "## コマンド",
        "",
        "```bash",
        'git tag -a v2.4.0 -m "Release v2.4.0"',
        "git push origin v2.4.0",
        "```",
        "",
        "> 切り戻しは前のタグを再デプロイする。DB のマイグレーションを含む時は事前に相談。",
      ].join("\n"),
    },
    ["release"],
  ),
  item(
    "memo",
    "API 設計の検討",
    {
      body: [
        "# API 設計の検討",
        "",
        "| エンドポイント | 用途 | 認可 |",
        "|---|---|---|",
        "| `GET /me` | ログイン中のユーザー | 本人 |",
        "| `GET /requests` | 申請の一覧 | 部署 |",
        "| `POST /requests` | 申請の作成 | 本人 |",
        "",
        "- ページングはカーソル方式にする",
        "- エラーは RFC 9457 (Problem Details) に揃える",
      ].join("\n"),
    },
    ["api"],
  ),
  item(
    "memo",
    "週次定例 10/2",
    {
      body: "# 週次定例 10/2\n\n- 申請画面の改修はレビュー中\n- 通知メールの文面を法務に確認する (担当: 佐藤、10/9 まで)\n",
    },
    ["meeting"],
  ),
];

const colors = [
  ["ブランド ブルー", "#2563EB"],
  ["ブランド ネイビー", "#1E3A8A"],
  ["アクセント", "#F59E0B"],
  ["成功", "#16A34A"],
  ["エラー", "#DC2626"],
  ["背景", "#F8FAFC"],
  ["本文", "#0F172A"],
  ["補助テキスト", "#64748B"],
].map(([title, hex]) => item("color", title, { hex }, ["brand"]));

const palettes = [
  item("palette", "ポータル基調", {
    colors: ["#1E3A8A", "#2563EB", "#60A5FA", "#DBEAFE", "#F59E0B"],
    harmony: "custom",
    base_index: 1,
  }),
  item("palette", "夕焼け", {
    colors: ["#7C2D12", "#EA580C", "#FB923C", "#FDBA74", "#FEF3C7"],
    harmony: "custom",
    base_index: 1,
  }),
  item("palette", "グリーン系", {
    colors: ["#064E3B", "#047857", "#10B981", "#6EE7B7", "#ECFDF5"],
    harmony: "custom",
    base_index: 2,
  }),
];

const mermaids = [
  item("mermaid", "ログインのシーケンス", {
    source: [
      "sequenceDiagram",
      "    autonumber",
      "    actor U as ユーザー",
      "    participant W as ポータル (Web)",
      "    participant A as 認証サービス",
      "    participant API as ポータル API",
      "    U->>W: ログイン画面を開く",
      "    W->>A: 認可リクエスト (PKCE)",
      "    A-->>U: サインイン画面",
      "    U->>A: ID / パスワード",
      "    A-->>W: 認可コード",
      "    W->>A: トークン要求",
      "    A-->>W: アクセストークン",
      "    W->>API: GET /me",
      "    API-->>W: プロフィール",
      "    W-->>U: ダッシュボードを表示",
    ].join("\n"),
  }),
  item("mermaid", "デプロイの流れ", {
    source: [
      "flowchart TD",
      "    A[PR 作成] --> B{CI}",
      "    B -- 失敗 --> A",
      "    B -- 成功 --> C[レビュー]",
      "    C --> D[main へマージ]",
      "    D --> E[ステージング]",
      "    E --> F{受入確認}",
      "    F -- OK --> G[本番リリース]",
      "    F -- NG --> A",
    ].join("\n"),
  }),
];

const diagramLabels = [];
function vertex(cellId, parent, label, style, x, y, width, height) {
  diagramLabels.push(label);
  return `<mxCell id="${cellId}" value="${label}" style="${style}" vertex="1" parent="${parent}"><mxGeometry x="${x}" y="${y}" width="${width}" height="${height}" as="geometry"/></mxCell>`;
}
function edge(cellId, source, target, label = "") {
  if (label !== "") diagramLabels.push(label);
  return `<mxCell id="${cellId}" value="${label}" style="edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=block;endFill=1;strokeColor=#475569;" edge="1" parent="1" source="${source}" target="${target}"><mxGeometry relative="1" as="geometry"/></mxCell>`;
}
const lane = (fill, stroke) =>
  `swimlane;whiteSpace=wrap;html=1;rounded=1;startSize=30;fontStyle=1;fillColor=${fill};strokeColor=${stroke};`;
const box = (stroke) => `rounded=1;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=${stroke};`;
const architecture = [
  vertex("lane-client", "1", "クライアント", lane("#dae8fc", "#6c8ebf"), 40, 40, 200, 320),
  vertex("browser", "lane-client", "ブラウザ", box("#6c8ebf"), 30, 60, 140, 50),
  vertex("mobile", "lane-client", "モバイルアプリ", box("#6c8ebf"), 30, 210, 140, 50),
  vertex("lane-server", "1", "サーバ", lane("#d5e8d4", "#82b366"), 320, 40, 360, 320),
  vertex("gateway", "lane-server", "API Gateway", box("#82b366"), 20, 135, 130, 50),
  vertex("auth", "lane-server", "認証サービス", box("#82b366"), 210, 60, 130, 50),
  vertex("api", "lane-server", "ポータル API", box("#82b366"), 210, 210, 130, 50),
  vertex("lane-data", "1", "データ", lane("#ffe6cc", "#d79b00"), 760, 40, 220, 320),
  vertex(
    "db",
    "lane-data",
    "PostgreSQL",
    "shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=12;fillColor=#ffffff;strokeColor=#d79b00;",
    50,
    45,
    120,
    80,
  ),
  vertex("cache", "lane-data", "Redis", box("#d79b00"), 50, 160, 120, 50),
  vertex("storage", "lane-data", "S3 (添付ファイル)", box("#d79b00"), 50, 240, 120, 50),
  vertex(
    "note",
    "1",
    "2026 Q4 に段階リリース",
    "shape=note;whiteSpace=wrap;html=1;size=14;fillColor=#fff2cc;strokeColor=#d6b656;",
    40,
    400,
    200,
    60,
  ),
  edge("e1", "browser", "gateway", "HTTPS"),
  edge("e2", "mobile", "gateway", "HTTPS"),
  edge("e3", "gateway", "auth"),
  edge("e4", "gateway", "api"),
  edge("e5", "auth", "db"),
  edge("e6", "api", "cache"),
  edge("e7", "api", "storage"),
].join("");
const screens = ["ログイン", "ダッシュボード", "申請一覧", "申請詳細"];
const flow = [
  ...screens.map((label, index) =>
    vertex(`s${index}`, "1", label, box("#6c8ebf"), 40 + index * 200, 80, 140, 60),
  ),
  ...screens.slice(1).map((_, index) => edge(`f${index}`, `s${index}`, `s${index + 1}`)),
].join("");
const page = (pageId, name, cells) =>
  `<diagram id="${pageId}" name="${name}"><mxGraphModel dx="1200" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1100" pageHeight="700" math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells}</root></mxGraphModel></diagram>`;
const diagramXml = `<mxfile host="MyMyTools">${page("arch", "システム構成", architecture)}${page("flow", "画面遷移", flow)}</mxfile>`;
const diagrams = [
  item("diagram", "システム構成", { xml: diagramXml, text: diagramLabels.join(" ") }),
];

// SVG-Edit が保存する形 (レイヤーは title 付きの g)。text は Rust の抽出規則
// (text / title / desc の文字列を空白で区切る) と一致させる
const vectorSvg = [
  '<svg width="640" height="480" xmlns="http://www.w3.org/2000/svg" xmlns:svg="http://www.w3.org/2000/svg">',
  "<defs>",
  '<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">',
  '<stop offset="0" stop-color="#2563EB"/>',
  '<stop offset="1" stop-color="#7C3AED"/>',
  "</linearGradient>",
  "</defs>",
  '<g class="layer">',
  "<title>レイヤー 1</title>",
  '<rect id="svg_1" x="200" y="60" width="240" height="240" rx="56" fill="url(#bg)"/>',
  '<path id="svg_2" d="M260 240 V130 L320 195 L380 130 V240" fill="none" stroke="#ffffff" stroke-width="22" stroke-linecap="round" stroke-linejoin="round"/>',
  '<circle id="svg_3" cx="404" cy="96" r="18" fill="#F59E0B"/>',
  '<text id="svg_4" x="320" y="370" font-family="sans-serif" font-size="40" font-weight="bold" text-anchor="middle" fill="#0F172A">MyMyTools</text>',
  '<text id="svg_5" x="320" y="410" font-family="sans-serif" font-size="20" text-anchor="middle" fill="#64748B">アイコン案 A</text>',
  "</g>",
  "</svg>",
].join("");
const vectors = [
  item("vector", "アプリアイコン案", {
    svg: vectorSvg,
    text: "レイヤー 1 MyMyTools アイコン案 A",
  }),
];

const projects = [
  project("社内ポータル刷新", "フロントの全面リプレイスと API の整理", [
    ...prompts,
    ...links,
    ...memos,
    ...colors,
    ...palettes,
    ...mermaids,
    ...diagrams,
    ...vectors,
  ]),
  project("個人メモ", "読書メモと買い物リスト", [
    item("memo", "読書メモ: リファクタリング", {
      body: "# 読書メモ\n\n- 小さく変えてテストを回す\n",
    }),
    item("linkmemo", "技術ブログ", { type: "url", target: "https://example.com/blog", body: "" }),
  ]),
  project("デザイン資料", "配色とアイコンの検討", [
    item("palette", "モノトーン", {
      colors: ["#111827", "#374151", "#6B7280", "#D1D5DB", "#F9FAFB"],
      harmony: "custom",
      base_index: 2,
    }),
  ]),
].map((entry, index) => ({ ...entry, position: index }));

const document = {
  schema_version: 1,
  exported_at: formatJst(now),
  app_version: "0.1.0-alpha.21",
  scope: "app",
  module_versions: Object.fromEntries(
    ["prompt", "linkmemo", "memo", "color", "palette", "mermaid", "diagram", "vector"].map(
      (moduleId) => [moduleId, 1],
    ),
  ),
  projects,
};

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`);
console.log(output);
