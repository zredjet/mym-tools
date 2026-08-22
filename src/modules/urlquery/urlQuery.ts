export interface QueryEntry {
  key: string;
  value: string;
}

export interface UrlParts {
  protocol: string;
  hostname: string;
  port: string;
  pathname: string;
  hash: string;
  query: QueryEntry[];
}

export function parseAbsoluteUrl(input: string): UrlParts {
  const url = new URL(input);
  if (url.protocol === "" || url.hostname === "") throw new Error("絶対URLを入力してください");
  return {
    protocol: url.protocol.replace(/:$/, ""),
    hostname: url.hostname,
    port: url.port,
    pathname: url.pathname,
    hash: url.hash.replace(/^#/, ""),
    query: [...url.searchParams.entries()].map(([key, value]) => ({ key, value })),
  };
}

export function buildAbsoluteUrl(parts: UrlParts): string {
  if (!/^[a-zA-Z][a-zA-Z\d+.-]*$/.test(parts.protocol)) throw new Error("schemeが不正です");
  if (parts.hostname.trim() === "") throw new Error("hostを入力してください");
  if (parts.port !== "" && (!/^\d+$/.test(parts.port) || Number(parts.port) > 65535)) {
    throw new Error("portが不正です");
  }
  const url = new URL(`${parts.protocol}://${parts.hostname}${parts.port ? `:${parts.port}` : ""}`);
  url.pathname = parts.pathname.startsWith("/") ? parts.pathname : `/${parts.pathname}`;
  url.search = "";
  for (const entry of parts.query) url.searchParams.append(entry.key, entry.value);
  url.hash = parts.hash;
  return url.toString();
}
