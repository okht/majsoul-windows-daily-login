import { describe, expect, it } from "vitest";
import { beijingClock, minutes } from "../src/beijing-time.mjs";

describe("beijingClock", () => {
  it("uses Asia/Shanghai across a UTC date boundary", () => {
    const value = beijingClock(new Date("2026-07-16T16:30:00.000Z"));
    expect(value.dateKey).toBe("2026-07-17");
    expect(value.minuteOfDay).toBe(minutes(0, 30));
  });

  it("reports 12:30 as minute 750", () => {
    expect(minutes(12, 30)).toBe(750);
  });
});
