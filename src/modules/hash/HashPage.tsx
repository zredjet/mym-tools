/**
 * M-Hash 画面 (`docs/ui-design.md` §6.6 / §9.4)。
 *
 * PR-AC: ファイル D&D + テキスト入力の両方をサポート。
 * - テキスト: 即時計算 (`hash_compute_text`)
 * - ファイル: Tauri webview の `onDragDropEvent` で path を取得 → `hash_compute_file`
 *   + 進捗 Channel + `core_cancel_operation` (ADR-0009 §2)
 *
 * stateless モジュール (`is_stateless = true`) のため永続化はしない。
 * route は D-01 に従ってプロジェクト配下に置くが、計算結果は project ID に依存しない。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Copy, FileText, Loader2, X } from "lucide-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";

import { Button } from "@/components/ui/Button";
import {
  type HashAlgorithm,
  type HashFileProgress,
  cancelOperation,
  hashComputeFile,
  hashComputeText,
} from "@/ipc/hash";
import { cn } from "@/lib/cn";
import { formatInvokeError } from "@/lib/error";

interface FileJob {
  operationId: string;
  path: string;
  algorithm: HashAlgorithm;
  bytesProcessed: number;
  totalBytes: number;
  cancelling: boolean;
}

interface FileResult {
  path: string;
  algorithm: HashAlgorithm;
  hash: string;
  durationMs: number;
}

export function HashPage() {
  const [text, setText] = useState("");
  const [algorithm, setAlgorithm] = useState<HashAlgorithm>("sha256");
  const [textResult, setTextResult] = useState<string | null>(null);
  const [textPending, setTextPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ファイル D&D 関連
  const [dragOver, setDragOver] = useState(false);
  const [fileJob, setFileJob] = useState<FileJob | null>(null);
  const [fileResult, setFileResult] = useState<FileResult | null>(null);
  // 進行中の job を中断したい時に参照する current job ID (drop 連打や unmount 時に使う)
  const fileJobRef = useRef<FileJob | null>(null);
  useEffect(() => {
    fileJobRef.current = fileJob;
  }, [fileJob]);

  const computeText = async () => {
    setTextPending(true);
    setError(null);
    setTextResult(null);
    try {
      const hash = await hashComputeText({ text, algorithm });
      setTextResult(hash);
    } catch (e) {
      setError(formatInvokeError(e));
    } finally {
      setTextPending(false);
    }
  };

  const startFileHash = useCallback(async (path: string, algo: HashAlgorithm) => {
    // 既存 job があれば先にキャンセル (drop 連打対策)
    const prev = fileJobRef.current;
    if (prev != null) {
      try {
        await cancelOperation(prev.operationId);
      } catch {
        /* 既に終わっている場合は no-op */
      }
    }

    const operationId = crypto.randomUUID();
    setError(null);
    setFileResult(null);
    setFileJob({
      operationId,
      path,
      algorithm: algo,
      bytesProcessed: 0,
      totalBytes: 0,
      cancelling: false,
    });

    try {
      const hash = await hashComputeFile({
        operationId,
        path,
        algorithm: algo,
        onProgress: (p: HashFileProgress) => {
          // 同じ operationId の進捗のみ反映 (古い job の遅れ進捗を弾く)
          setFileJob((current) => {
            if (current == null || current.operationId !== operationId) {
              return current;
            }
            if (p.type === "progress") {
              return {
                ...current,
                bytesProcessed: p.bytes_processed,
                totalBytes: p.total_bytes,
              };
            }
            // done / cancelled は呼び出し側 (await 結果 / catch) で setFileJob(null) する
            return current;
          });
        },
      });
      // codex PR-AC P2: drop 連打などで古い job の Promise が新規 job 完了後に解決する
      // ケースを防ぐ。fileJobRef.current は常に **最新の** job を指すため、自分が最新かを
      // 確認してからのみ result を書き込む (setFileJob と同じガード)。
      if (fileJobRef.current?.operationId === operationId) {
        setFileResult({ path, algorithm: algo, hash, durationMs: 0 });
        setFileJob(null);
      }
    } catch (e) {
      // Cancelled / I/O error / Unsupported algo 等すべてここに来る
      const msg = formatInvokeError(e);
      // Cancelled エラーはエラー表示しない (ユーザー意図で止めたため)
      if (fileJobRef.current?.operationId === operationId) {
        if (!/cancel/i.test(msg)) {
          setError(msg);
        }
        setFileJob(null);
      }
      // 古い job の cancel エラーが来た場合は何もせず破棄する
    }
  }, []);

  const handleCancel = useCallback(async () => {
    const job = fileJobRef.current;
    if (job == null) return;
    setFileJob({ ...job, cancelling: true });
    try {
      await cancelOperation(job.operationId);
    } catch (e) {
      setError(formatInvokeError(e));
    }
  }, []);

  // Tauri webview レベルの D&D 購読 (ウィンドウ全体で発火)。
  // HTML5 の dragover/drop ではファイルの絶対パスを取れない (security)、Tauri が
  // OS イベントを intercept して `paths: string[]` で渡してくれる。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      const u = await getCurrentWebview().onDragDropEvent((event) => {
        if (event.payload.type === "over" || event.payload.type === "enter") {
          setDragOver(true);
        } else if (event.payload.type === "drop") {
          setDragOver(false);
          const first = event.payload.paths[0];
          if (first == null) return;
          // 複数ファイル時は最初の 1 件のみ採用 (Phase 1 仕様、複数同時は U-12 候補)
          void startFileHash(first, algorithm);
        } else {
          setDragOver(false);
        }
      });
      if (cancelled) {
        u();
      } else {
        unlisten = u;
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten != null) unlisten();
    };
    // algorithm 変更で listener を貼り替えるのは僅かな blip があるが、drop の瞬間に
    // 最新の algorithm が closure に入る方が単純 + 信頼性が高い。Phase 1 では UX 上問題なし
  }, [algorithm, startFileHash]);

  // codex PR-AC P2: コンポーネント unmount 時 (= Hash ページから離れた時) に進行中の
  // hash_compute_file を必ずキャンセルする。バックエンドの CPU / IO ヘビーな処理が
  // UI からアクセスできない状態で走り続けるのを防ぐ。algorithm 変更で listener が
  // 貼り替わる effect とは別出しにすることで、algorithm 切り替え時にキャンセルが
  // 走らないようにする (deps = [])。
  useEffect(() => {
    return () => {
      const active = fileJobRef.current;
      if (active != null) {
        void cancelOperation(active.operationId);
      }
    };
  }, []);

  const copyToClipboard = async (s: string) => {
    try {
      await navigator.clipboard.writeText(s);
    } catch {
      /* clipboard 不可な環境は無視 */
    }
  };

  return (
    <div className="flex h-full flex-col px-[var(--page-pad)] py-6">
      <header className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Hash</h1>
        <span className="text-[12px] text-[var(--fg-subtle)]">stateless モジュール</span>
      </header>

      {error !== null && (
        <section className="mb-3 rounded-[var(--radius)] border border-[var(--destructive)] bg-[var(--destructive)]/10 p-2 text-[13px] text-[var(--destructive)]">
          {error}
        </section>
      )}

      {/* 共通: アルゴリズム選択 */}
      <section className="mb-4 flex items-center gap-3">
        <label className="text-[13px] font-medium" htmlFor="algo-select">
          アルゴリズム
        </label>
        <select
          id="algo-select"
          className="h-7 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-2 text-[13px] text-[var(--fg)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none"
          value={algorithm}
          onChange={(e) => setAlgorithm(e.target.value as HashAlgorithm)}
          disabled={fileJob != null}
        >
          <option value="md5">MD5</option>
          <option value="sha1">SHA-1</option>
          <option value="sha256">SHA-256</option>
          <option value="sha512">SHA-512</option>
        </select>
        {fileJob != null && (
          <span className="text-[11px] text-[var(--fg-subtle)]">計算中は変更不可</span>
        )}
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* 左カラム: テキスト */}
        <section className="flex flex-col gap-2">
          <label className="text-[13px] font-medium" htmlFor="text-input">
            テキスト
          </label>
          <textarea
            id="text-input"
            className="h-40 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] p-2 font-mono text-[13px] text-[var(--fg)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="ここにテキストを入力 (改行可)"
          />
          <Button
            variant="primary"
            className="self-start"
            onClick={() => void computeText()}
            disabled={textPending || text === ""}
          >
            {textPending ? "計算中..." : "テキストをハッシュ"}
          </Button>
          {textResult !== null && (
            <ResultRow
              algorithm={algorithm}
              hash={textResult}
              onCopy={() => void copyToClipboard(textResult)}
            />
          )}
        </section>

        {/* 右カラム: ファイル D&D */}
        <section className="flex flex-col gap-2">
          <span className="text-[13px] font-medium">ファイル (ドラッグ&ドロップ)</span>
          <div
            className={cn(
              "flex h-40 flex-col items-center justify-center gap-2 rounded-[var(--radius)] border-2 border-dashed p-3 text-center transition-colors",
              dragOver
                ? "border-[var(--accent)] bg-[var(--bg-accent-soft)]"
                : "border-[var(--border)] bg-[var(--bg-muted)]",
            )}
          >
            {fileJob != null ? (
              <FileJobView job={fileJob} onCancel={() => void handleCancel()} />
            ) : (
              <>
                <FileText
                  size={28}
                  aria-hidden
                  className={dragOver ? "text-[var(--accent)]" : "text-[var(--fg-subtle)]"}
                />
                <p className="text-[13px] text-[var(--fg-muted)]">ファイルをここにドロップ</p>
                <p className="text-[11px] text-[var(--fg-subtle)]">
                  選択中のアルゴリズム ({algorithm.toUpperCase()}) で計算します
                </p>
              </>
            )}
          </div>
          {fileResult !== null && fileJob == null && (
            <FileResultView
              result={fileResult}
              onCopy={() => void copyToClipboard(fileResult.hash)}
            />
          )}
        </section>
      </div>
    </div>
  );
}

function ResultRow({
  algorithm,
  hash,
  onCopy,
}: {
  algorithm: HashAlgorithm;
  hash: string;
  onCopy: () => void;
}) {
  return (
    <div className="mt-1 flex items-start gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-muted)] p-2">
      <span className="shrink-0 font-mono text-[11px] font-semibold text-[var(--fg-muted)]">
        {algorithm.toUpperCase()}
      </span>
      <pre className="min-w-0 flex-1 font-mono text-[12px] break-all whitespace-pre-wrap text-[var(--fg)]">
        {hash}
      </pre>
      <button
        type="button"
        aria-label="ハッシュをコピー"
        title="ハッシュをコピー"
        onClick={onCopy}
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--fg-subtle)] hover:bg-[var(--bg)] hover:text-[var(--accent)]"
      >
        <Copy size={13} aria-hidden />
      </button>
    </div>
  );
}

function FileJobView({ job, onCancel }: { job: FileJob; onCancel: () => void }) {
  const percent = useMemo(() => {
    if (job.totalBytes === 0) return 0;
    return Math.min(100, Math.floor((job.bytesProcessed / job.totalBytes) * 100));
  }, [job.bytesProcessed, job.totalBytes]);
  const fileName = useMemo(() => job.path.split(/[/\\]/).pop() ?? job.path, [job.path]);

  return (
    <div className="flex w-full flex-col gap-2 text-left">
      <div className="flex items-center gap-2">
        <Loader2 size={14} aria-hidden className="animate-spin text-[var(--accent)]" />
        <span
          className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--fg)]"
          title={job.path}
        >
          {fileName}
        </span>
        <button
          type="button"
          aria-label="キャンセル"
          title="キャンセル"
          onClick={onCancel}
          disabled={job.cancelling}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--fg-subtle)] hover:bg-[var(--bg)] hover:text-[var(--destructive)] disabled:opacity-50"
        >
          <X size={13} aria-hidden />
        </button>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--border)]">
        <div
          className="h-full bg-[var(--accent)] transition-all"
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="flex justify-between font-mono text-[11px] text-[var(--fg-subtle)] tabular-nums">
        <span>
          {formatBytes(job.bytesProcessed)} / {formatBytes(job.totalBytes)}
        </span>
        <span>{job.cancelling ? "中止中..." : `${percent}% · ${job.algorithm.toUpperCase()}`}</span>
      </div>
    </div>
  );
}

function FileResultView({ result, onCopy }: { result: FileResult; onCopy: () => void }) {
  const fileName = useMemo(() => result.path.split(/[/\\]/).pop() ?? result.path, [result.path]);
  return (
    <div className="mt-1 flex flex-col gap-1">
      <p className="truncate text-[12px] text-[var(--fg-muted)]" title={result.path}>
        {fileName}
      </p>
      <ResultRow algorithm={result.algorithm} hash={result.hash} onCopy={onCopy} />
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
