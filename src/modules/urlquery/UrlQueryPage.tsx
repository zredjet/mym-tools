import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { CopyButton, inputClass, ToolError, ToolPage, ToolPanel } from "@/components/ui/ToolPage";

import { buildAbsoluteUrl, parseAbsoluteUrl, type UrlParts } from "./urlQuery";

const emptyParts: UrlParts = {
  protocol: "https",
  hostname: "",
  port: "",
  pathname: "/",
  hash: "",
  query: [],
};

export function UrlQueryPage() {
  const [source, setSource] = useState("https://example.com/path?foo=1&foo=2");
  const [parts, setParts] = useState<UrlParts>(emptyParts);
  const [error, setError] = useState<string | null>(null);
  const output = useMemo(() => {
    try {
      return buildAbsoluteUrl(parts);
    } catch {
      return "";
    }
  }, [parts]);

  const parse = () => {
    try {
      setParts(parseAbsoluteUrl(source));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const updateQuery = (index: number, next: Partial<{ key: string; value: string }>) => {
    setParts((current) => ({
      ...current,
      query: current.query.map((entry, position) =>
        position === index ? { ...entry, ...next } : entry,
      ),
    }));
  };

  const move = (index: number, delta: number) => {
    setParts((current) => {
      const next = [...current.query];
      const target = index + delta;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target]!, next[index]!];
      return { ...current, query: next };
    });
  };

  return (
    <ToolPage
      title="URL・クエリパラメータ編集"
      description="URLを構成要素へ分解し、重複キーと順序を保ったまま再構築します。"
    >
      <ToolPanel title="URL">
        <div className="flex gap-2">
          <input
            className={`${inputClass} min-w-0 flex-1 font-mono`}
            value={source}
            onChange={(event) => setSource(event.target.value)}
          />
          <Button variant="primary" onClick={parse}>
            分解
          </Button>
        </div>
      </ToolPanel>
      <div className="mt-3">
        <ToolError message={error} />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <ToolPanel title="構成要素">
          <div className="grid grid-cols-2 gap-3">
            {(["protocol", "hostname", "port", "pathname", "hash"] as const).map((field) => (
              <label
                key={field}
                className={field === "pathname" ? "col-span-2 text-[12px]" : "text-[12px]"}
              >
                {field}
                <input
                  className={`${inputClass} mt-1 w-full font-mono`}
                  value={parts[field]}
                  onChange={(event) =>
                    setParts((current) => ({ ...current, [field]: event.target.value }))
                  }
                />
              </label>
            ))}
          </div>
        </ToolPanel>
        <ToolPanel
          title="クエリパラメータ"
          actions={
            <Button
              size="sm"
              onClick={() =>
                setParts((current) => ({
                  ...current,
                  query: [...current.query, { key: "", value: "" }],
                }))
              }
            >
              <Plus size={13} />
              追加
            </Button>
          }
        >
          <div className="flex max-h-64 flex-col gap-2 overflow-auto">
            {parts.query.map((entry, index) => (
              <div key={index} className="flex items-center gap-1">
                <input
                  aria-label={`query key ${index + 1}`}
                  className={`${inputClass} min-w-0 flex-1 font-mono`}
                  value={entry.key}
                  onChange={(event) => updateQuery(index, { key: event.target.value })}
                />
                <span>=</span>
                <input
                  aria-label={`query value ${index + 1}`}
                  className={`${inputClass} min-w-0 flex-1 font-mono`}
                  value={entry.value}
                  onChange={(event) => updateQuery(index, { value: event.target.value })}
                />
                <Button size="sm" variant="ghost" aria-label="上へ" onClick={() => move(index, -1)}>
                  <ArrowUp size={13} />
                </Button>
                <Button size="sm" variant="ghost" aria-label="下へ" onClick={() => move(index, 1)}>
                  <ArrowDown size={13} />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="削除"
                  onClick={() =>
                    setParts((current) => ({
                      ...current,
                      query: current.query.filter((_, position) => position !== index),
                    }))
                  }
                >
                  <Trash2 size={13} />
                </Button>
              </div>
            ))}
          </div>
        </ToolPanel>
      </div>
      <ToolPanel title="再構築したURL" className="mt-4" actions={<CopyButton text={output} />}>
        <p className="font-mono text-[13px] break-all">{output || "—"}</p>
      </ToolPanel>
    </ToolPage>
  );
}
