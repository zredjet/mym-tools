import { Temporal } from "temporal-polyfill";

const favorites = ["UTC", "Asia/Tokyo", "America/Los_Angeles", "America/New_York", "Europe/London"];

export function availableTimeZones(): string[] {
  const supportedValuesOf = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] })
    .supportedValuesOf;
  const discovered = supportedValuesOf?.("timeZone") ?? [];
  return [...new Set([...favorites, ...discovered])];
}

export function assertTimeZone(value: string): void {
  try {
    Temporal.Now.instant().toZonedDateTimeISO(value);
  } catch {
    throw new Error(`IANAタイムゾーンが不正です: ${value}`);
  }
}
