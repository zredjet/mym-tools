import { validate, version } from "uuid";
import { describe, expect, it } from "vitest";

import { generateIds } from "./idGenerator";

describe("ID generator", () => {
  it.each([
    ["uuidv4", 4],
    ["uuidv7", 7],
  ] as const)("generates valid %s", (format, expectedVersion) => {
    const ids = generateIds(format, 4);
    expect(ids.every((id) => validate(id) && version(id) === expectedVersion)).toBe(true);
  });

  it("generates monotonic ULIDs and requested NanoID length", () => {
    const ulids = generateIds("ulid", 10);
    expect([...ulids].sort()).toEqual(ulids);
    expect(generateIds("nanoid", 3, 12).every((id) => id.length === 12)).toBe(true);
  });
});
