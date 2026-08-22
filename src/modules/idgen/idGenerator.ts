import { nanoid } from "nanoid";
import { monotonicFactory } from "ulid";
import { v4 as uuidV4, v7 as uuidV7 } from "uuid";

export type IdFormat = "uuidv4" | "uuidv7" | "ulid" | "nanoid";

export function generateIds(format: IdFormat, count: number, nanoLength = 21): string[] {
  if (!Number.isInteger(count) || count < 1 || count > 100)
    throw new Error("件数は1〜100にしてください");
  if (!Number.isInteger(nanoLength) || nanoLength < 1 || nanoLength > 128) {
    throw new Error("NanoIDの長さは1〜128にしてください");
  }
  const monotonicUlid = monotonicFactory();
  return Array.from({ length: count }, () => {
    switch (format) {
      case "uuidv4":
        return uuidV4();
      case "uuidv7":
        return uuidV7();
      case "ulid":
        return monotonicUlid();
      case "nanoid":
        return nanoid(nanoLength);
    }
  });
}
