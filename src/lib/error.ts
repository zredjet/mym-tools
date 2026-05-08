/**
 * Tauri `invoke` の reject 値を表示用文字列に整形する。
 *
 * Tauri 2 の `invoke` は以下のいずれかで reject する:
 * - 文字列 (Rust 側で `Result<_, String>` を返した場合)
 * - `Error` instance (frontend 側でネットワーク等の異常)
 * - シリアライズされたオブジェクト (`AppError` のように `{code, message}` 形)
 *
 * `JSON.stringify(Error instance)` は `message` フィールドが non-enumerable のため
 * `{}` になってしまう。各形を個別に処理して、ユーザーに有用な情報を渡す。
 */
export function formatInvokeError(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && e !== null) {
    const obj = e as { message?: unknown; code?: unknown };
    if (typeof obj.message === "string") {
      return typeof obj.code === "string" ? `[${obj.code}] ${obj.message}` : obj.message;
    }
    if (typeof obj.message === "object" && obj.message !== null) {
      const codeStr = typeof obj.code === "string" ? `[${obj.code}] ` : "";
      return `${codeStr}${JSON.stringify(obj.message)}`;
    }
    return JSON.stringify(e);
  }
  return String(e);
}
