import { Temporal } from "temporal-polyfill";

import { assertTimeZone } from "@/lib/timeZones";

export type DateTimeInputKind = "unix_seconds" | "unix_milliseconds" | "iso" | "local";

export interface DateTimeResult {
  unixSeconds: number;
  unixMilliseconds: number;
  utc: string;
  zoned: string;
}

export function convertDateTime(
  input: string,
  kind: DateTimeInputKind,
  timeZone: string,
): DateTimeResult {
  assertTimeZone(timeZone);
  const instant = toInstant(input.trim(), kind, timeZone);
  const milliseconds = instant.epochMilliseconds;
  return {
    unixSeconds: Math.floor(milliseconds / 1000),
    unixMilliseconds: milliseconds,
    utc: instant.toString({ smallestUnit: "millisecond" }),
    zoned: instant.toZonedDateTimeISO(timeZone).toString({ smallestUnit: "millisecond" }),
  };
}

function toInstant(input: string, kind: DateTimeInputKind, timeZone: string): Temporal.Instant {
  if (input === "") throw new Error("日時を入力してください");
  switch (kind) {
    case "unix_seconds": {
      const value = parseFinite(input);
      return Temporal.Instant.fromEpochMilliseconds(Math.round(value * 1000));
    }
    case "unix_milliseconds":
      return Temporal.Instant.fromEpochMilliseconds(Math.round(parseFinite(input)));
    case "iso":
      return Temporal.Instant.from(input);
    case "local": {
      const local = Temporal.PlainDateTime.from(input);
      return local.toZonedDateTime(timeZone, { disambiguation: "reject" }).toInstant();
    }
  }
}

function parseFinite(input: string): number {
  const value = Number(input);
  if (!Number.isFinite(value)) throw new Error("有限の数値を入力してください");
  return value;
}
