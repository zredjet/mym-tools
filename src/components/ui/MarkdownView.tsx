/**
 * Markdown レンダリングコンポーネント (`docs/ui-design.md` §6.3 P-2 / ADR-0002)。
 *
 * - `react-markdown` を使い、GFM (`remark-gfm`) でテーブル / タスクリスト / 自動リンク対応
 * - `rehype-highlight` でコードブロックのシンタックスハイライト
 * - 安全性: `react-markdown` は既定で raw HTML を **無効化** する (XSS リスク回避)
 *   ユーザー入力の Markdown を直に出すため、Phase 1 では rehype-raw を入れない
 *
 * ## `ignoreMissing: true` の根拠 (PR #36 codex P1 対応)
 *
 * 既定では `rehype-highlight` は ` ```customlang ` のような **未登録の言語タグ** を
 * 含む fenced code block で例外を投げ、結果としてプレビュー全体が真っ白になる
 * (ユーザーが何の警告もなく内容を失ったように見える)。`ignoreMissing: true` を
 * 渡すことで未知の言語は **highlight なしのプレーンテキストとしてフォールバック**
 * 描画される。
 */
import "highlight.js/styles/github.css";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/cn";

interface Props {
  source: string;
  className?: string;
}

export function MarkdownView({ source, className }: Props) {
  return (
    <div className={cn("prose-mymtools max-w-none", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { ignoreMissing: true }]]}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
