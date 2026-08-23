import { CronExpressionParser } from "cron-parser";
import { Temporal } from "temporal-polyfill";

import { assertTimeZone } from "@/lib/timeZones";

export type CronMode = "five" | "six";

export function nextCronRuns(
  expression: string,
  mode: CronMode,
  timeZone: string,
  count = 10,
  currentDate: Date = new Date(),
): string[] {
  assertTimeZone(timeZone);
  const fields = expression.trim().split(/\s+/);
  const expected = mode === "five" ? 5 : 6;
  if (fields.length !== expected) throw new Error(`${expected}フィールドで入力してください`);
  for (const field of fields) {
    if (!/^[\dA-Za-z*,/?#-]+$/.test(field) || containsUnsupportedMarker(field)) {
      throw new Error("Quartz固有記号または未対応の文字が含まれています");
    }
  }
  if (!Number.isInteger(count) || count < 1 || count > 100)
    throw new Error("件数は1〜100にしてください");
  const interval = CronExpressionParser.parse(expression, { currentDate, tz: timeZone });
  return Array.from({ length: count }, () => {
    const iso = interval.next().toISOString();
    if (iso == null) throw new Error("次回実行日時をISO形式へ変換できません");
    const instant = Temporal.Instant.from(iso);
    return instant
      .toZonedDateTimeISO(timeZone)
      .toString({ smallestUnit: mode === "six" ? "second" : "minute" });
  });
}

function containsUnsupportedMarker(field: string): boolean {
  if (/[?#]/.test(field)) return true;

  return field
    .split(/[,*/-]/)
    .filter(Boolean)
    .some((token) => /^(?:H|L|W|LW|\d+[LW])$/i.test(token));
}
