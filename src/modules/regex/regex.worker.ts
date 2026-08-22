/// <reference lib="webworker" />
import { evaluateRegex } from "./regexEngine";

self.onmessage = (
  event: MessageEvent<{ id: number; input: Parameters<typeof evaluateRegex>[0] }>,
) => {
  try {
    self.postMessage({ id: event.data.id, result: evaluateRegex(event.data.input) });
  } catch (cause) {
    self.postMessage({
      id: event.data.id,
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
};
