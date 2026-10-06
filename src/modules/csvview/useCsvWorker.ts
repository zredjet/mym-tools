import { useCallback, useEffect, useRef } from "react";

import type { OutputFormat } from "./csvConvert";
import type {
  ConvertSummary,
  CsvRequest,
  CsvResponse,
  DelimiterChoice,
  ParseSummary,
} from "./csvWorkerCore";

/** 1 回の解析・変換の打ち切り時間。32 MiB の CSV でも収まる長さにする。 */
export const CSV_WORKER_TIMEOUT_MS = 15_000;

/** 新しい解析で置き換えたなど、画面に出さなくてよい中断。 */
export class CsvWorkerSuperseded extends Error {
  constructor() {
    super("superseded");
    this.name = "CsvWorkerSuperseded";
  }
}

/** union の各型から id を外す */
type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;

interface Pending {
  resolve: (result: ParseSummary | ConvertSummary) => void;
  reject: (error: Error) => void;
  timeout: number;
}

/**
 * 解析済みの行を持ち続ける Worker を 1 つ使う。行データはメインスレッドへ送らず、
 * プレビューと変換結果だけを受け取る。画面を離れたら Worker を止める。
 */
export function useCsvWorker() {
  const workerRef = useRef<Worker | null>(null);
  const pendingRef = useRef(new Map<number, Pending>());
  const nextIdRef = useRef(0);

  const stop = useCallback((error: Error) => {
    workerRef.current?.terminate();
    workerRef.current = null;
    for (const pending of pendingRef.current.values()) {
      window.clearTimeout(pending.timeout);
      pending.reject(error);
    }
    pendingRef.current.clear();
  }, []);

  useEffect(() => () => stop(new CsvWorkerSuperseded()), [stop]);

  const send = useCallback(
    (request: WithoutId<CsvRequest>) => {
      let worker = workerRef.current;
      if (worker == null) {
        worker = new Worker(new URL("./csvview.worker.ts", import.meta.url), { type: "module" });
        worker.onmessage = (event: MessageEvent<CsvResponse>) => {
          const pending = pendingRef.current.get(event.data.id);
          if (pending == null) return;
          pendingRef.current.delete(event.data.id);
          window.clearTimeout(pending.timeout);
          if (event.data.error != null) pending.reject(new Error(event.data.error));
          else if (event.data.result != null) pending.resolve(event.data.result);
        };
        // Worker 自体を起動できない (CSP / 読込失敗) 場合はタイムアウトと区別して伝える
        worker.onerror = () => stop(new Error("CSV を解析するワーカーを起動できませんでした"));
        workerRef.current = worker;
      }
      nextIdRef.current += 1;
      const id = nextIdRef.current;
      const target = worker;
      return new Promise<ParseSummary | ConvertSummary>((resolve, reject) => {
        const timeout = window.setTimeout(
          () => stop(new Error("処理が 15 秒を超えたため停止しました。もう一度読み込んでください")),
          CSV_WORKER_TIMEOUT_MS,
        );
        pendingRef.current.set(id, { resolve, reject, timeout });
        target.postMessage({ ...request, id });
      });
    },
    [stop],
  );

  /** 解析する。前の処理が終わっていなければ Worker ごと止めて作り直す。 */
  const parse = useCallback(
    async (text: string, delimiter: DelimiterChoice): Promise<ParseSummary> => {
      if (pendingRef.current.size > 0) stop(new CsvWorkerSuperseded());
      const result = await send({ type: "parse", text, delimiter });
      if (result.kind !== "parse") throw new Error("unexpected worker response");
      return result;
    },
    [send, stop],
  );

  const convert = useCallback(
    async (format: OutputFormat, header: boolean): Promise<ConvertSummary> => {
      const result = await send({ type: "convert", format, header });
      if (result.kind !== "convert") throw new Error("unexpected worker response");
      return result;
    },
    [send],
  );

  /** 入力を消したときなどに、持っている行ごと Worker を止める。 */
  const reset = useCallback(() => stop(new CsvWorkerSuperseded()), [stop]);

  return { parse, convert, reset };
}
