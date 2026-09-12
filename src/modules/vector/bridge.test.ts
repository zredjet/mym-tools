import { afterEach, describe, expect, it, vi } from "vitest";
import { VectorBridge, VECTOR_PROTOCOL, VECTOR_TIMEOUT_MS, vectorUrl } from "./bridge";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function harness() {
  vi.useFakeTimers();
  const target = { postMessage: vi.fn() } as unknown as Window;
  const notify = vi.fn();
  const bridge = new VectorBridge(() => target, "http://127.0.0.1:4567", notify);
  const send = (data: object, origin = "http://127.0.0.1:4567", source = target) =>
    window.dispatchEvent(
      new MessageEvent("message", {
        origin,
        source,
        data: { protocol: VECTOR_PROTOCOL, session: bridge.session, ...data },
      }),
    );
  send({ event: "ready" });
  return { target, notify, bridge, send };
}
describe("VectorBridge", () => {
  it("accepts only the editor window, origin, session, document and request", async () => {
    const { bridge, target, send, notify } = harness();
    await bridge.ready;
    send({ event: "changed" }, "http://example.com");
    send({ event: "changed" }, "http://127.0.0.1:4567", window);
    send({ event: "changed", session: "old" });
    expect(notify).not.toHaveBeenCalled();
    const pending = bridge.request("snapshot", "current");
    const packet = vi.mocked(target.postMessage).mock.calls[0]![0];
    const resolved = vi.fn();
    void pending.then(resolved);
    send({ ...packet, event: "snapshot", documentId: "old" });
    send({ ...packet, event: "inserted" });
    send({ ...packet, event: "snapshot", requestId: "old" });
    await Promise.resolve();
    expect(resolved).not.toHaveBeenCalled();
    send({ ...packet, event: "snapshot", svg: "document", revision: 3 });
    expect((await pending).revision).toBe(3);
    bridge.dispose();
  });
  it("times out, ignores late responses and allows retry", async () => {
    const { bridge, target, send } = harness();
    await bridge.ready;
    const pending = bridge.request("snapshot", "doc");
    const failed = expect(pending).rejects.toThrow("タイムアウト");
    const old = vi.mocked(target.postMessage).mock.calls[0]![0];
    await vi.advanceTimersByTimeAsync(VECTOR_TIMEOUT_MS);
    await failed;
    const retry = bridge.request("snapshot", "doc");
    send({ ...old, event: "snapshot", revision: 1 });
    send({ ...vi.mocked(target.postMessage).mock.calls[1]![0], event: "snapshot", revision: 2 });
    expect((await retry).revision).toBe(2);
    bridge.dispose();
  });
  it("releases pending requests on disposal and on editor errors", async () => {
    const { bridge, target, send } = harness();
    await bridge.ready;
    const pending = bridge.request("load", "doc");
    send({ ...vi.mocked(target.postMessage).mock.calls[0]![0], event: "error", error: "不正SVG" });
    await expect(pending).rejects.toThrow("不正SVG");
    const next = bridge.request("snapshot", "doc");
    bridge.dispose();
    await expect(next).rejects.toThrow("閉じました");
    await expect(bridge.request("snapshot", "doc")).rejects.toThrow("接続");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("limits exposed operations and local endpoint shape", async () => {
    const { bridge } = harness();
    await bridge.ready;
    await expect(bridge.request("eval", "doc")).rejects.toThrow("未対応");
    expect(() => vectorUrl("https://127.0.0.1:1/index.html", "s")).toThrow();
    expect(() => vectorUrl("http://example.com:1/index.html", "s")).toThrow();
    expect(new URL(vectorUrl("http://127.0.0.1:1/index.html", "s")).hash).toContain("session=s");
    bridge.dispose();
  });
});
