import { describe, expect, it } from "vitest";

import { nextCronRuns } from "./cronBuilder";

describe("cron builder", () => {
  it("supports five and six field expressions", () => {
    const current = new Date("2026-01-01T00:00:00Z");
    expect(nextCronRuns("0 9 * * *", "five", "Asia/Tokyo", 1, current)[0]).toContain("T09:00");
    expect(nextCronRuns("30 0 9 * * *", "six", "Asia/Tokyo", 1, current)[0]).toContain("T09:00:30");
  });

  it("rejects Quartz-specific tokens", () => {
    expect(() => nextCronRuns("0 9 ? * MON", "five", "UTC", 1)).toThrow(/Quartz/);
    expect(() => nextCronRuns("0 9 L * *", "five", "UTC", 1)).toThrow(/Quartz/);
    expect(() => nextCronRuns("0 9 15W * *", "five", "UTC", 1)).toThrow(/Quartz/);
    expect(() => nextCronRuns("0 9 * * 5L", "five", "UTC", 1)).toThrow(/Quartz/);
    expect(() => nextCronRuns("H 9 * * *", "five", "UTC", 1)).toThrow(/Quartz/);
    expect(() => nextCronRuns("0 9 * * MON#2", "five", "UTC", 1)).toThrow(/Quartz/);
  });

  it("accepts month and weekday names containing marker letters", () => {
    const runs = nextCronRuns("0 9 * JUL WED", "five", "UTC", 1, new Date("2026-01-01T00:00:00Z"));

    expect(runs).toHaveLength(1);
    expect(
      nextCronRuns("0 9 * MAR THU", "five", "UTC", 1, new Date("2026-01-01T00:00:00Z")),
    ).toHaveLength(1);
  });
});
