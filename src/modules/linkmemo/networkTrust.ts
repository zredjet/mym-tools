/**
 * Link (`type=path`) のネットワーク上の場所の判定と、確認せずに開くサーバの扱い。
 *
 * Windows では UNC のパスにアクセスした時点で SMB 接続が走り、サインイン情報 (NTLM 認証) が
 * サーバへ送られる。インポートした JSON 由来の Link 1 クリックで外部のサーバへ送らないよう、
 * 登録済みでないサーバは開く前に確認する。Rust 側 `linkmemo_open` も、確認を経ていない
 * (`allowNetworkPath` の無い) ネットワーク上の場所を拒否する。判定は Rust 側
 * `is_network_path` と揃える。
 *
 * 確認せずに開くサーバは settings.json の `modules.linkmemo.trusted_network_hosts` に置く。
 * settings.json は export / import の対象外なので、インポートした JSON では増えない。
 */

export const TRUSTED_NETWORK_HOSTS_KEY = "trusted_network_hosts";

export interface NetworkLocation {
  /** 小文字のサーバ名。device path (`\\?\C:\...` など) のように取り出せない時は null */
  host: string | null;
}

/** Rust の `str::trim_start` と同じく、U+0085 (NEL) も前の空白として除く */
const LEADING_SPACE = /^[\s\u0085]+/;
const SEPARATOR = /[\\/]/;
const INVALID_HOST_CHARS = /[\s\\/:*?"<>|]/;
const MAX_HOST_LENGTH = 253;

/**
 * ネットワーク上の場所なら、そのサーバを返す。ローカルのパスなら null。
 *
 * - UNC: `\\server\share` / `//server/share` (区切りは `\` と `/` のどちらでもよい)
 * - Win32 の device path: `\\?\UNC\server\share` / `\\.\UNC\server\share`。
 *   それ以外の device path (`\\?\C:\` / `\\?\GLOBALROOT\...`) はサーバ名を取り出さない
 * - NT の object path: `\??\...`。サーバ名を取り出さない
 */
export function networkLocation(target: string): NetworkLocation | null {
  const path = target.replace(LEADING_SPACE, "");
  if (/^[\\/][\\/]/.test(path)) {
    let rest = path.slice(2);
    if (/^[?.][\\/]/.test(rest)) {
      const unc = /^[?.][\\/]UNC[\\/]/i.exec(rest);
      if (unc == null) return { host: null };
      rest = rest.slice(unc[0].length);
    }
    return { host: normalizeHost(rest.split(SEPARATOR, 1)[0] ?? "") };
  }
  if (/^[\\/]\?\?[\\/]/.test(path)) return { host: null };
  return null;
}

/** サーバ名を比較用に小文字へそろえる。サーバ名として使えない値は null */
export function normalizeHost(value: string): string | null {
  const host = value.trim().toLowerCase();
  if (host === "" || host.length > MAX_HOST_LENGTH || INVALID_HOST_CHARS.test(host)) return null;
  if ([...host].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)) {
    return null;
  }
  return host;
}

/** 設定画面の入力 (`nas` / `\\nas\share` / `//nas/share` など) からサーバ名を取り出す */
export function hostFromInput(input: string): string | null {
  const location = networkLocation(input);
  return location != null ? location.host : normalizeHost(input);
}

/** settings.json の値を読む。サーバ名として使えない値は除き、重複をまとめる */
export function parseTrustedHosts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const hosts = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const host = normalizeHost(item);
    if (host != null) hosts.add(host);
  }
  return [...hosts];
}

export function isTrustedLocation(location: NetworkLocation, trustedHosts: readonly string[]) {
  return location.host != null && trustedHosts.includes(location.host);
}
