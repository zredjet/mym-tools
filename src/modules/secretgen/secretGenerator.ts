import { secureBytes, secureShuffle, secureString } from "@/lib/secureRandom";

const groups = {
  lower: "abcdefghijklmnopqrstuvwxyz",
  upper: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  digits: "0123456789",
  symbols: "!@#$%^&*()-_=+[]{};:,.?",
} as const;
const ambiguous = new Set([..."0OolI1"]);

export interface PasswordOptions {
  length: number;
  lower: boolean;
  upper: boolean;
  digits: boolean;
  symbols: boolean;
  excludeAmbiguous: boolean;
}

export function generatePassword(options: PasswordOptions): string {
  if (!Number.isInteger(options.length) || options.length < 8 || options.length > 256) {
    throw new Error("パスワード長は8〜256にしてください");
  }
  const enabled = (Object.keys(groups) as (keyof typeof groups)[])
    .filter((key) => options[key])
    .map((key) =>
      [...groups[key]]
        .filter((character) => !options.excludeAmbiguous || !ambiguous.has(character))
        .join(""),
    );
  if (enabled.length === 0) throw new Error("少なくとも1つの文字種を選択してください");
  if (options.length < enabled.length) throw new Error("長さが選択文字種数より短すぎます");
  const required = enabled.map((alphabet) => secureString(alphabet, 1));
  const alphabet = enabled.join("");
  return secureShuffle([
    ...required,
    ...secureString(alphabet, options.length - required.length),
  ]).join("");
}

export function generateToken(byteLength: number, encoding: "hex" | "base64url"): string {
  if (!Number.isInteger(byteLength) || byteLength < 1 || byteLength > 128) {
    throw new Error("token長は1〜128 bytesにしてください");
  }
  const bytes = secureBytes(byteLength);
  if (encoding === "hex")
    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).split("+").join("-").split("/").join("_").replace(/=+$/, "");
}
