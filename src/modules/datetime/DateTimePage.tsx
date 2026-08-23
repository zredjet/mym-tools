import { useMemo, useState } from "react";

import { Button } from "@/components/ui/Button";
import { CopyButton, inputClass, ToolError, ToolPage, ToolPanel } from "@/components/ui/ToolPage";
import { availableTimeZones } from "@/lib/timeZones";

import { convertDateTime, type DateTimeInputKind, type DateTimeResult } from "./dateTime";

const kindLabels: Record<DateTimeInputKind, string> = {
  unix_seconds: "Unix秒",
  unix_milliseconds: "Unixミリ秒",
  iso: "ISO / RFC 3339（offset必須）",
  local: "ローカル日時",
};

export function DateTimePage() {
  const [kind, setKind] = useState<DateTimeInputKind>("unix_seconds");
  const [input, setInput] = useState(() => String(Math.floor(Date.now() / 1000)));
  const [timeZone, setTimeZone] = useState("Asia/Tokyo");
  const [result, setResult] = useState<DateTimeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const zones = useMemo(() => availableTimeZones(), []);

  const execute = () => {
    try {
      setResult(convertDateTime(input, kind, timeZone));
      setError(null);
    } catch (cause) {
      setResult(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <ToolPage
      title="日時・Unix Timestamp変換"
      description="Unix時刻、ISO日時、IANAタイムゾーンを相互変換します。DSTの曖昧な時刻は拒否します。"
    >
      <ToolPanel title="入力">
        <div className="grid gap-3 md:grid-cols-[12rem_1fr_16rem_auto]">
          <select
            className={inputClass}
            value={kind}
            onChange={(event) => setKind(event.target.value as DateTimeInputKind)}
          >
            {Object.entries(kindLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <input
            className={`${inputClass} font-mono`}
            value={input}
            onChange={(event) => setInput(event.target.value)}
          />
          <input
            className={`${inputClass} font-mono`}
            list="iana-time-zones"
            value={timeZone}
            onChange={(event) => setTimeZone(event.target.value)}
          />
          <datalist id="iana-time-zones">
            {zones.map((zone) => (
              <option key={zone} value={zone} />
            ))}
          </datalist>
          <Button variant="primary" onClick={execute}>
            変換
          </Button>
        </div>
      </ToolPanel>
      <div className="mt-3">
        <ToolError message={error} />
      </div>
      <ToolPanel title="結果" className="mt-4">
        {result == null ? (
          <p className="text-[12px] text-[var(--fg-subtle)]">変換結果はまだありません。</p>
        ) : (
          <dl className="grid gap-3">
            {(
              [
                ["Unix秒", String(result.unixSeconds)],
                ["Unixミリ秒", String(result.unixMilliseconds)],
                ["UTC", result.utc],
                [timeZone, result.zoned],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="grid grid-cols-[9rem_1fr_auto] items-center gap-3">
                <dt className="text-[12px] text-[var(--fg-muted)]">{label}</dt>
                <dd className="min-w-0 font-mono text-[13px] break-all">{value}</dd>
                <CopyButton text={value} />
              </div>
            ))}
          </dl>
        )}
      </ToolPanel>
    </ToolPage>
  );
}
