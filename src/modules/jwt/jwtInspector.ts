export type TemporalClaimStatus = "expired" | "not_yet_valid" | "valid" | "informational";

export interface TemporalClaimView {
  name: "exp" | "nbf" | "iat";
  numericDate: number;
  utc: string;
  jst: string;
  status: TemporalClaimStatus;
}

export interface JwtInspection {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signature: string;
  temporalClaims: TemporalClaimView[];
}

export function inspectJwt(token: string, nowMilliseconds = Date.now()): JwtInspection {
  const segments = token.trim().split(".");
  if (segments.length !== 3) throw new Error("3セグメントのJWS形式を入力してください");
  const header = decodeJsonObject(segments[0]!, "Header");
  const payload = decodeJsonObject(segments[1]!, "Payload");
  const nowSeconds = nowMilliseconds / 1000;
  const temporalClaims = (["exp", "nbf", "iat"] as const).flatMap((name) => {
    const value = payload[name];
    if (value == null) return [];
    if (typeof value !== "number" || !Number.isFinite(value))
      throw new Error(`${name}はNumericDateである必要があります`);
    const date = new Date(value * 1000);
    const status: TemporalClaimStatus =
      name === "exp"
        ? nowSeconds >= value
          ? "expired"
          : "valid"
        : name === "nbf"
          ? nowSeconds < value
            ? "not_yet_valid"
            : "valid"
          : "informational";
    return [{ name, numericDate: value, utc: date.toISOString(), jst: formatJst(date), status }];
  });
  return { header, payload, signature: segments[2]!, temporalClaims };
}

function decodeJsonObject(segment: string, label: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new Error(`${label}のBase64URLが不正です`);
  const normalized = segment.split("-").join("+").split("_").join("/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error(`${label}はUTF-8のJSON objectではありません`);
  }
  if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) {
    throw new Error(`${label}はJSON objectである必要があります`);
  }
  return parsed as Record<string, unknown>;
}

function formatJst(date: Date): string {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}T${value("hour")}:${value("minute")}:${value("second")}+09:00`;
}
