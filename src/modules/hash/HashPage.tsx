/**
 * M-Hash 画面 (`docs/ui-design.md` §6.6 / §9.4)。
 *
 * Phase 1 PR-J: PR-A 由来の Q-22 PoC (テキストハッシュ計算) を Shell 配下に移植。
 * MD5/SHA1/SHA256/SHA512 同時計算と H-1 のドラッグ & ドロップは次 PR で拡張予定。
 *
 * stateless モジュール (`is_stateless = true`) のため、プロジェクト選択不要で動作する。
 */
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { Button } from "@/components/ui/Button";
import { formatInvokeError } from "@/lib/error";

type Algorithm = "md5" | "sha1" | "sha256" | "sha512";

export function HashPage() {
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
    <div className="flex h-full flex-col px-[var(--page-pad)] py-6">
      <header className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Hash</h1>
        <span className="text-[12px] text-[var(--fg-subtle)]">stateless モジュール</span>
      </header>

      <section className="flex flex-col gap-3">
        <label className="text-[13px] font-medium" htmlFor="text-input">
          テキスト
        </label>
        <textarea
          id="text-input"
          className="h-32 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] p-2 font-mono text-[13px] text-[var(--fg)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="ここにテキストを入力 — テキストを入力するか、ファイルをドロップ"
        />
        <div className="flex items-center gap-3">
          <label className="text-[13px] font-medium" htmlFor="algo-select">
            アルゴリズム
          </label>
          <select
            id="algo-select"
            className="h-7 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-2 text-[13px] text-[var(--fg)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none"
            value={algorithm}
            onChange={(e) => setAlgorithm(e.target.value as Algorithm)}
          >
            <option value="md5">MD5</option>
            <option value="sha1">SHA-1</option>
            <option value="sha256">SHA-256</option>
            <option value="sha512">SHA-512</option>
          </select>
          <Button
            variant="primary"
            className="ml-auto"
            onClick={() => void compute()}
            disabled={pending}
          >
            {pending ? "計算中..." : "ハッシュ計算"}
          </Button>
        </div>
      </section>

      {result !== null && (
        <section className="mt-4">
          <h2 className="mb-1 text-[13px] font-medium">結果 ({algorithm})</h2>
          <pre className="overflow-x-auto rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-muted)] p-2 font-mono text-[12px] text-[var(--fg)]">
            {result}
          </pre>
        </section>
      )}
      {error !== null && (
        <section className="mt-4">
          <h2 className="mb-1 text-[13px] font-medium text-[var(--destructive)]">エラー</h2>
          <pre className="overflow-x-auto rounded-[var(--radius)] border border-[var(--destructive)] bg-[var(--destructive)]/10 p-2 font-mono text-[12px] text-[var(--destructive)]">
            {error}
          </pre>
        </section>
      )}
    </div>
  );
}
