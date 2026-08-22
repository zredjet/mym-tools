import { useMemo, useState } from "react";

import { Button } from "@/components/ui/Button";
import { CopyButton, inputClass, ToolError, ToolPage, ToolPanel } from "@/components/ui/ToolPage";
import { availableTimeZones } from "@/lib/timeZones";

import { nextCronRuns, type CronMode } from "./cronBuilder";

const fieldLabels = ["秒", "分", "時", "日", "月", "曜日"];

export function CronPage() {
  const [mode, setMode] = useState<CronMode>("five");
  const [fields, setFields] = useState(["0", "9", "*", "*", "1-5"]);
  const [timeZone, setTimeZone] = useState("Asia/Tokyo");
  const [runs, setRuns] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const zones = useMemo(() => availableTimeZones(), []);
  const expression = fields.join(" ");

  const switchMode = (next: CronMode) => {
    setMode(next);
    setFields((current) => (next === "six" ? ["0", ...current] : current.slice(1)));
    setRuns([]);
  };
  const execute = () => {
    try {
      setRuns(nextCronRuns(expression, mode, timeZone));
      setError(null);
    } catch (cause) {
      setRuns([]);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const labels = mode === "six" ? fieldLabels : fieldLabels.slice(1);

  return (
    <ToolPage
      title="Cron式ビルダー"
      description="Unix 5フィールドまたは秒付き6フィールドの次回実行日時を確認します。"
    >
      <ToolPanel title="Cron式">
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <label className="text-[12px]">
            形式
            <select
              className={`${inputClass} mt-1 block`}
              value={mode}
              onChange={(event) => switchMode(event.target.value as CronMode)}
            >
              <option value="five">Unix 5 field</option>
              <option value="six">Seconds 6 field</option>
            </select>
          </label>
          <label className="text-[12px]">
            Timezone
            <input
              className={`${inputClass} mt-1 block w-56 font-mono`}
              list="cron-zones"
              value={timeZone}
              onChange={(event) => setTimeZone(event.target.value)}
            />
          </label>
          <datalist id="cron-zones">
            {zones.map((zone) => (
              <option key={zone} value={zone} />
            ))}
          </datalist>
          <Button variant="primary" onClick={execute}>
            次回を計算
          </Button>
        </div>
        <div className={`grid gap-2 ${mode === "six" ? "grid-cols-6" : "grid-cols-5"}`}>
          {fields.map((field, index) => (
            <label key={labels[index]} className="text-center text-[11px] text-[var(--fg-muted)]">
              {labels[index]}
              <input
                aria-label={labels[index]}
                className={`${inputClass} mt-1 w-full text-center font-mono`}
                value={field}
                onChange={(event) =>
                  setFields((current) =>
                    current.map((value, position) =>
                      position === index ? event.target.value : value,
                    ),
                  )
                }
              />
            </label>
          ))}
        </div>
        <div className="mt-3 flex items-center justify-between rounded bg-[var(--bg-muted)] p-2 font-mono text-[13px]">
          <span>{expression}</span>
          <CopyButton text={expression} />
        </div>
      </ToolPanel>
      <div className="mt-3">
        <ToolError message={error} />
      </div>
      <ToolPanel
        title="次回10件"
        className="mt-4"
        actions={<CopyButton text={runs.join("\n")} label="すべてコピー" />}
      >
        <ol className="list-decimal pl-8 font-mono text-[12px]">
          {runs.map((run) => (
            <li key={run} className="py-1">
              {run}
            </li>
          ))}
        </ol>
      </ToolPanel>
    </ToolPage>
  );
}
