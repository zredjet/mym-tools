import { describe, expect, it } from "vitest";

import { inspectJwt } from "./jwtInspector";

function segment(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).split("+").join("-").split("/").join("_").replace(/=+$/, "");
}

describe("JWT inspector", () => {
  it("decodes claims and reports expiry without verifying the signature", () => {
    const token = `${segment({ alg: "none" })}.${segment({ sub: "u1", exp: 100, nbf: 10, iat: 5 })}.signature`;
    const result = inspectJwt(token, 200_000);
    expect(result.payload.sub).toBe("u1");
    expect(result.temporalClaims.find((claim) => claim.name === "exp")?.status).toBe("expired");
    expect(result.signature).toBe("signature");
  });

  it("rejects malformed and non-numeric temporal claims", () => {
    expect(() => inspectJwt("a.b")).toThrow(/3セグメント/);
    expect(() => inspectJwt(`${segment({})}.${segment({ exp: "soon" })}.x`)).toThrow(/NumericDate/);
  });
});
