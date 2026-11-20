// Mermaid の版を上げる時に、実ブラウザで描画を確かめる図の見本 (browser-smoke.mjs が使う)。
// labels は、描画後の SVG の文字に残っていなければならない語。HTML ラベルは無効なので、
// ラベルは <text> で描かれ、sanitizeRenderedSvg を通っても消えないはず。

export const MERMAID_CORPUS = [
  {
    name: "flowchart",
    labels: ["開始", "判定", "処理", "保存先", "完了", "はい", "外部"],
    source: `flowchart LR
  A[開始] --> B{判定}
  B -->|はい| C[処理]
  B -->|いいえ| D[(保存先)]
  C --> E([完了])
  subgraph 外部
    D
  end`,
  },
  {
    name: "sequence",
    labels: ["利用者", "サーバ", "要求", "応答", "往復"],
    source: `sequenceDiagram
  participant U as 利用者
  participant S as サーバ
  U->>S: 要求
  S-->>U: 応答
  Note over U,S: 往復`,
  },
  {
    name: "class",
    labels: ["Animal", "Dog", "name", "eat()"],
    source: `classDiagram
  class Animal {
    +String name
    +eat()
  }
  Animal <|-- Dog`,
  },
  {
    name: "state",
    labels: ["待機", "実行", "開始"],
    source: `stateDiagram-v2
  [*] --> 待機
  待機 --> 実行 : 開始
  実行 --> [*]`,
  },
  {
    name: "er",
    labels: ["CUSTOMER", "ORDER", "LINE_ITEM", "places"],
    source: `erDiagram
  CUSTOMER ||--o{ ORDER : places
  ORDER ||--|{ LINE_ITEM : contains`,
  },
  {
    name: "gantt",
    labels: ["作業", "設計", "実装"],
    source: `gantt
  dateFormat YYYY-MM-DD
  section 作業
  設計 :a1, 2026-11-01, 3d
  実装 :after a1, 5d`,
  },
  {
    name: "pie",
    labels: ["割合", "A", "B"],
    source: `pie title 割合
  "A" : 40
  "B" : 60`,
  },
  {
    name: "mindmap",
    labels: ["中心", "枝A", "葉1", "枝B"],
    source: `mindmap
  root((中心))
    枝A
      葉1
    枝B`,
  },
  {
    name: "timeline",
    labels: ["年表", "2025", "構想", "公開"],
    source: `timeline
  title 年表
  2025 : 構想
  2026 : 公開`,
  },
  {
    name: "gitgraph",
    labels: ["init", "work", "main", "feature"],
    source: `gitGraph
  commit id: "init"
  branch feature
  commit id: "work"
  checkout main
  merge feature`,
  },
  {
    name: "journey",
    labels: ["一日", "朝", "起きる", "出かける"],
    source: `journey
  title 一日
  section 朝
    起きる: 3: 私
    出かける: 4: 私`,
  },
  {
    name: "quadrant",
    labels: ["Reach", "Expand", "Campaign A"],
    source: `quadrantChart
  title Reach and engagement
  x-axis Low Reach --> High Reach
  y-axis Low Engagement --> High Engagement
  quadrant-1 Expand
  quadrant-2 Promote
  quadrant-3 Re-evaluate
  quadrant-4 Improve
  Campaign A: [0.3, 0.6]`,
  },
  {
    name: "xychart",
    labels: ["売上", "jan", "mar"],
    source: `xychart-beta
  title "売上"
  x-axis [jan, feb, mar]
  y-axis "円" 0 --> 100
  bar [30, 60, 90]`,
  },
  {
    name: "sankey",
    labels: ["Source", "Sink A", "Sink B"],
    source: `sankey-beta

Source,Sink A,10
Source,Sink B,5`,
  },
  {
    name: "requirement",
    labels: ["offline", "app", "satisfies"],
    source: `requirementDiagram
  requirement offline {
    id: 1
    text: works offline
    risk: high
    verifymethod: test
  }
  element app {
    type: desktop
  }
  app - satisfies -> offline`,
  },
  {
    name: "block",
    labels: ["入力", "処理", "出力"],
    source: `block-beta
  columns 3
  a["入力"] b["処理"] c["出力"]`,
  },
  {
    name: "architecture",
    labels: ["App", "DB", "API"],
    source: `architecture-beta
  group app(cloud)[App]
  service db(database)[DB] in app
  service api(server)[API] in app
  db:L -- R:api`,
  },
];

export const MERMAID_THEMES = ["default", "dark"];
