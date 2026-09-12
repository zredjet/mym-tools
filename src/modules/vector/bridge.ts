export const VECTOR_TIMEOUT_MS = 30_000;
export const VECTOR_PROTOCOL = "mym-vector-v1";
const MAX_MESSAGE_CHARS = 29 * 1024 * 1024;
export interface VectorMessage {
  event: string;
  requestId?: string;
  documentId?: string;
  revision?: number;
  svg?: string;
  text?: string;
  data?: string;
  action?: string;
  error?: string;
}

export function vectorUrl(base: string, session: string): string {
  const url = new URL(base);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.pathname !== "/index.html"
  )
    throw new Error("ベクターエディタのURLが不正です。");
  url.hash = new URLSearchParams({ parent: location.origin, session }).toString();
  return url.toString();
}

export class VectorBridge {
  readonly session = crypto.randomUUID();
  readonly ready: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private readyTimer: ReturnType<typeof setTimeout>;
  private pending = new Map<
    string,
    {
      documentId: string;
      event: string;
      resolve: (message: VectorMessage) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private disposed = false;
  constructor(
    private readonly target: () => Window | null,
    private readonly origin: string,
    private readonly notify: (message: VectorMessage) => void,
  ) {
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.readyTimer = setTimeout(
      () => this.readyReject(new Error("エディタの起動がタイムアウトしました。")),
      VECTOR_TIMEOUT_MS,
    );
    window.addEventListener("message", this.receive);
  }
  private receive = (event: MessageEvent) => {
    if (
      event.source !== this.target() ||
      event.origin !== this.origin ||
      !event.data ||
      typeof event.data !== "object"
    )
      return;
    const value = event.data;
    if (
      value.protocol !== VECTOR_PROTOCOL ||
      value.session !== this.session ||
      typeof value.event !== "string"
    )
      return;
    for (const key of ["svg", "text", "data", "error"])
      if (
        value[key] != null &&
        (typeof value[key] !== "string" || value[key].length > MAX_MESSAGE_CHARS)
      )
        return;
    if (value.event === "ready") {
      clearTimeout(this.readyTimer);
      this.readyResolve();
      return;
    }
    if (value.event === "failed") {
      clearTimeout(this.readyTimer);
      this.readyReject(new Error(value.error ?? "エディタの初期化に失敗しました。"));
      return;
    }
    if (typeof value.requestId === "string") {
      const request = this.pending.get(value.requestId);
      if (
        !request ||
        request.documentId !== value.documentId ||
        (value.event !== request.event && value.event !== "error")
      )
        return;
      this.pending.delete(value.requestId);
      clearTimeout(request.timer);
      if (value.event === "error")
        request.reject(new Error(value.error ?? "エディタ操作に失敗しました。"));
      else request.resolve(value);
    } else if (["changed", "action"].includes(value.event)) this.notify(value);
  };
  request(
    action: string,
    documentId: string,
    fields: Record<string, unknown> = {},
  ): Promise<VectorMessage> {
    if (this.disposed || !this.target())
      return Promise.reject(new Error("エディタに接続できません。"));
    const expected = { load: "loaded", snapshot: "snapshot", png: "png", insertImage: "inserted" }[
      action
    ];
    if (!expected) return Promise.reject(new Error("未対応のエディタ操作です。"));
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("エディタの応答がタイムアウトしました。もう一度お試しください。"));
      }, VECTOR_TIMEOUT_MS);
      this.pending.set(requestId, { documentId, event: expected, resolve, reject, timer });
      try {
        this.target()!.postMessage(
          {
            protocol: VECTOR_PROTOCOL,
            session: this.session,
            action,
            documentId,
            requestId,
            ...fields,
          },
          this.origin,
        );
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }
  dispose() {
    this.disposed = true;
    window.removeEventListener("message", this.receive);
    clearTimeout(this.readyTimer);
    this.readyReject(new Error("エディタを閉じました。"));
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("エディタを閉じました。"));
    }
    this.pending.clear();
  }
}
