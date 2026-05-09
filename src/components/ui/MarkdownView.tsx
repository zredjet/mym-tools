/**
 * Markdown レンダリングコンポーネント (`docs/ui-design.md` §6.3 P-2 / ADR-0002)。
 *
 * - `react-markdown` を使い、GFM (`remark-gfm`) でテーブル / タスクリスト / 自動リンク対応
 * - `rehype-highlight` でコードブロックのシンタックスハイライト
 * - 安全性: `react-markdown` は既定で raw HTML を **無効化** する (XSS リスク回避)
 *   ユーザー入力の Markdown を直に出すため、Phase 1 では rehype-raw を入れない
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
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {source}
      </ReactMarkdown>
    </div>
  );
}
