/**
 * Q-22 PoC 動作確認用の最小 UI。
 *
 * `hash_compute_text` Tauri コマンドへの round-trip を検証する。
 * Phase 1 着手時にこのコンポーネントを Shell (サイドバー / 検索バー / モジュールルート)
 * に差し替える (`docs/architecture.md` §2 / `docs/ui-design.md` §6)。
 */
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { modules } from "@/modules/registry";

type Algorithm = "md5" | "sha1" | "sha256" | "sha512";

/**
 * `invoke` の reject 値を表示用文字列に整形する。
 *
 * Tauri 2 の `invoke` は以下のどれかで reject する:
 *  - 文字列 (Rust 側で `Result<_, String>` を返した場合)
 *  - `Error` instance (frontend 側でネットワーク等の異常)
 *  - シリアライズされたオブジェクト (`AppError` のように `{code, message}` 形)
 *
 * `JSON.stringify(Error instance)` は `message` フィールドが non-enumerable のため
 * `{}` になってしまう。各形を個別に処理して、ユーザーに有用な情報を渡す。
 */
function formatInvokeError(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && e !== null) {
    const obj = e as { message?: unknown; code?: unknown };
    if (typeof obj.message === "string") {
      return typeof obj.code === "string" ? `[${obj.code}] ${obj.message}` : obj.message;
    }
    return JSON.stringify(e);
  }
  return String(e);
}

function App() {
  const [text, setText] = useState("");
  const [algorithm, setAlgorithm] = useState<Algorithm>("sha256");
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const compute = async () => {
    setPending(true);
    setError(null);
    setResult(null);
    try {
      const hash = await invoke<string>("hash_compute_text", { text, algorithm });
      setResult(hash);
    } catch (e) {
      setError(formatInvokeError(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-8">
      <header>
        <h1 className="text-2xl font-semibold">MyMyTools — Q-22 PoC</h1>
        <p className="mt-1 text-sm opacity-70">
          ロード済モジュール: {modules.map((m) => `${m.displayName} (${m.id})`).join(" / ")}
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <label className="text-sm font-medium" htmlFor="text-input">
          テキスト
        </label>
        <textarea
          id="text-input"
          className="h-24 rounded border p-2 font-mono text-sm"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="ここにテキストを入力..."
        />

        <div className="flex items-center gap-3">
          <label className="text-sm font-medium" htmlFor="algo-select">
            アルゴリズム
          </label>
          <select
            id="algo-select"
            className="rounded border p-1 text-sm"
            value={algorithm}
            onChange={(e) => setAlgorithm(e.target.value as Algorithm)}
          >
            <option value="md5">MD5</option>
            <option value="sha1">SHA-1</option>
            <option value="sha256">SHA-256</option>
            <option value="sha512">SHA-512</option>
          </select>
          <button
            type="button"
            className="ml-auto rounded bg-black px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
            onClick={() => void compute()}
            disabled={pending}
          >
            {pending ? "計算中..." : "ハッシュ計算"}
          </button>
        </div>
      </section>

      {result !== null && (
        <section>
          <h2 className="text-sm font-medium">結果 ({algorithm})</h2>
          <pre className="mt-1 overflow-x-auto rounded border bg-stone-50 p-2 font-mono text-xs">
            {result}
          </pre>
        </section>
      )}
      {error !== null && (
        <section>
          <h2 className="text-sm font-medium text-red-600">エラー</h2>
          <pre className="mt-1 overflow-x-auto rounded border border-red-200 bg-red-50 p-2 font-mono text-xs text-red-700">
            {error}
          </pre>
        </section>
      )}
    </main>
  );
}

export default App;
