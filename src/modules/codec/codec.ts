export type CodecFormat = "base64" | "base64url" | "url" | "html" | "unicode";
export type CodecDirection = "encode" | "decode";

export function transformText(
  input: string,
  format: CodecFormat,
  direction: CodecDirection,
): string {
  if (direction === "encode") return encodeText(input, format);
  return decodeText(input, format);
}

function encodeText(input: string, format: CodecFormat): string {
  switch (format) {
    case "base64":
      return bytesToBase64(new TextEncoder().encode(input));
    case "base64url":
      return bytesToBase64(new TextEncoder().encode(input))
        .split("+")
        .join("-")
        .split("/")
        .join("_")
        .replace(/=+$/, "");
    case "url":
      return encodeURIComponent(input);
    case "html":
      return input
        .split("&")
        .join("&amp;")
        .split("<")
        .join("&lt;")
        .split(">")
        .join("&gt;")
        .split('"')
        .join("&quot;")
        .split("'")
        .join("&#39;");
    case "unicode":
      return [...input]
        .map((character) => {
          const codePoint = character.codePointAt(0)!;
          return codePoint <= 0xffff
            ? `\\u${codePoint.toString(16).padStart(4, "0")}`
            : `\\u{${codePoint.toString(16)}}`;
        })
        .join("");
  }
}

function decodeText(input: string, format: CodecFormat): string {
  switch (format) {
    case "base64":
      return new TextDecoder("utf-8", { fatal: true }).decode(base64ToBytes(input));
    case "base64url": {
      if (!/^[A-Za-z0-9_-]*={0,2}$/.test(input)) throw new Error("Base64URL として不正です");
      const normalized = input.split("-").join("+").split("_").join("/");
      return new TextDecoder("utf-8", { fatal: true }).decode(
        base64ToBytes(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")),
      );
    }
    case "url":
      return decodeURIComponent(input);
    case "html": {
      const textarea = document.createElement("textarea");
      textarea.innerHTML = input;
      return textarea.value;
    }
    case "unicode":
      return decodeUnicodeEscapes(input);
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(input: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input) || input.length % 4 !== 0) {
    throw new Error("Base64 として不正です");
  }
  const binary = atob(input);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeUnicodeEscapes(input: string): string {
  return input.replace(/\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})/g, (_, braced, fixed) => {
    const value = Number.parseInt((braced ?? fixed) as string, 16);
    if (value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) {
      throw new Error("Unicode code point が不正です");
    }
    return String.fromCodePoint(value);
  });
}
