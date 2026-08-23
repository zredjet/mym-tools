/// <reference lib="webworker" />
import { computeTextDiff, type TextDiffInput } from "./textDiff";

self.onmessage = (event: MessageEvent<{ id: number; input: TextDiffInput }>) => {
  try {
    self.postMessage({ id: event.data.id, result: computeTextDiff(event.data.input) });
  } catch (cause) {
    self.postMessage({
      id: event.data.id,
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
};
