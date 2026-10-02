import { describe, expect, it } from "vitest";

import {
  hostFromInput,
  isTrustedLocation,
  networkLocation,
  normalizeHost,
  parseTrustedHosts,
} from "./networkTrust";

describe("networkLocation", () => {
  it.each([
    [String.raw`\\NAS\share\dir`, "nas"],
    ["//nas/share/dir", "nas"],
    [String.raw`\/nas/share`, "nas"],
    ["  //nas/share", "nas"],
    ["\u0085//nas/share", "nas"],
    [String.raw`\\192.168.1.10\share`, "192.168.1.10"],
    [String.raw`\\fileserver.example.local`, "fileserver.example.local"],
    [String.raw`\\nas@SSL@443\DavWWWRoot`, "nas@ssl@443"],
    [String.raw`\\?\UNC\nas\share`, "nas"],
    [String.raw`\\.\unc\nas\share`, "nas"],
    ["//?/UNC/nas/share", "nas"],
  ])("returns the server of %s", (target, host) => {
    expect(networkLocation(target)).toEqual({ host });
  });

  // Rust 側 `is_network_path` が拒否するものは、サーバ名が取れなくても確認の対象にする
  it.each([
    String.raw`\\?\C:\Users\x`,
    String.raw`\\?\GLOBALROOT\Device\Mup\nas\share`,
    String.raw`\\.\pipe\x`,
    String.raw`\??\UNC\nas\share`,
    "/??/UNC/nas/share",
    "//",
    String.raw`\\\share`,
  ])("asks before opening %s without a trustable server", (target) => {
    expect(networkLocation(target)).toEqual({ host: null });
  });

  it.each([
    "/Users/x/Documents",
    String.raw`C:\Users\x`,
    String.raw`C:\??\x`,
    "~/x",
    "relative",
    "",
  ])("treats %s as local", (target) => {
    expect(networkLocation(target)).toBeNull();
  });
});

describe("normalizeHost / hostFromInput", () => {
  it("lowercases and rejects values that are not server names", () => {
    expect(normalizeHost(" NAS ")).toBe("nas");
    for (const value of ["", "  ", "nas share", "nas:445", "a*b", "nas\u0000", "x".repeat(254)]) {
      expect(normalizeHost(value)).toBeNull();
    }
  });

  it("accepts a server name or a network path", () => {
    expect(hostFromInput("NAS")).toBe("nas");
    expect(hostFromInput(String.raw`\\nas\share\dir`)).toBe("nas");
    expect(hostFromInput("//nas/share")).toBe("nas");
    expect(hostFromInput(String.raw`\\?\C:\x`)).toBeNull();
    expect(hostFromInput(String.raw`C:\x`)).toBeNull();
  });
});

describe("parseTrustedHosts / isTrustedLocation", () => {
  it("keeps valid, unique server names from settings.json", () => {
    expect(parseTrustedHosts(["NAS", "nas", 1, "", "bad host", "files.local"])).toEqual([
      "nas",
      "files.local",
    ]);
    expect(parseTrustedHosts("nas")).toEqual([]);
    expect(parseTrustedHosts(undefined)).toEqual([]);
  });

  it("trusts only registered servers", () => {
    expect(isTrustedLocation({ host: "nas" }, ["nas"])).toBe(true);
    expect(isTrustedLocation({ host: "attacker" }, ["nas"])).toBe(false);
    expect(isTrustedLocation({ host: null }, ["nas"])).toBe(false);
  });
});
