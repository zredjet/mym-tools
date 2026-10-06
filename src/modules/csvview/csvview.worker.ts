/// <reference lib="webworker" />
import { createCsvSession, type CsvRequest, handleCsvRequest } from "./csvWorkerCore";

const session = createCsvSession();

self.onmessage = (event: MessageEvent<CsvRequest>) => {
  self.postMessage(handleCsvRequest(session, event.data));
};
