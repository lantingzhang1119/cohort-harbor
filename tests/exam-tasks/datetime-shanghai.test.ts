import { describe, expect, it } from "vitest";

import {
  formatShanghaiDisplay,
  shanghaiDatetimeLocalToDate,
  toShanghaiDatetimeLocalValue,
} from "@/features/exam-tasks/datetime-shanghai";

describe("shanghai datetime helpers", () => {
  it("round-trips datetime-local values in Asia/Shanghai", () => {
    const date = shanghaiDatetimeLocalToDate("2026-08-01T09:30");
    expect(date.toISOString()).toBe("2026-08-01T01:30:00.000Z");
    expect(toShanghaiDatetimeLocalValue(date)).toBe("2026-08-01T09:30");
    expect(formatShanghaiDisplay(date)).toContain("2026");
  });
});
