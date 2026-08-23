import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { CopyButton, inputClass, ToolError, ToolPage, ToolPanel } from "@/components/ui/ToolPage";

import { generateIds, type IdFormat } from "./idGenerator";

export function IdGeneratorPage() {
  const [format, setFormat] = useState<IdFormat>("uuidv7");
  const [count, setCount] = useState(10);
  const [nanoLength, setNanoLength] = useState(21);
  const [ids, setIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const generate = () => {
    try {
      setIds(generateIds(format, count, nanoLength));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <ToolPage
      title="UUID／ULID／ランダムID生成"
      description="用途に応じた一意識別子を暗号学的乱数で生成します。"
    >
      <ToolPanel title="生成条件">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-[12px]">
            形式
            <select
              className={`${inputClass} mt-1 block`}
              value={format}
              onChange={(event) => setFormat(event.target.value as IdFormat)}
            >
              <option value="uuidv4">UUID v4</option>
              <option value="uuidv7">UUID v7</option>
              <option value="ulid">ULID</option>
              <option value="nanoid">NanoID</option>
            </select>
          </label>
          <label className="text-[12px]">
            件数
            <input
              className={`${inputClass} mt-1 block w-24`}
              type="number"
              min={1}
              max={100}
              value={count}
              onChange={(event) => setCount(event.currentTarget.valueAsNumber)}
            />
          </label>
          {format === "nanoid" && (
            <label className="text-[12px]">
              長さ
              <input
                className={`${inputClass} mt-1 block w-24`}
                type="number"
                min={1}
                max={128}
                value={nanoLength}
                onChange={(event) => setNanoLength(event.currentTarget.valueAsNumber)}
              />
            </label>
          )}
          <Button variant="primary" onClick={generate}>
            生成
          </Button>
        </div>
      </ToolPanel>
      <div className="mt-3">
        <ToolError message={error} />
      </div>
      <ToolPanel
        title="生成結果"
        className="mt-4"
        actions={<CopyButton text={ids.join("\n")} label="すべてコピー" />}
      >
        <ol className="max-h-96 overflow-auto rounded-[var(--radius)] bg-[var(--bg-muted)] p-3 font-mono text-[13px]">
          {ids.length === 0 ? (
            <li className="text-[var(--fg-subtle)]">まだ生成されていません。</li>
          ) : (
            ids.map((id, index) => (
              <li key={`${id}-${index}`} className="py-0.5 break-all">
                {id}
              </li>
            ))
          )}
        </ol>
      </ToolPanel>
    </ToolPage>
  );
}
