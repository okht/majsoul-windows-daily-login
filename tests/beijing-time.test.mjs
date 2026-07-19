import { describe, expect, it } from "vitest";
import { beijingClock, localClock, minutes } from "../src/beijing-time.mjs";

function expectedLocal(date) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  return {
    dateKey: parts.year + "-" + parts.month + "-" + parts.day,
    minuteOfDay: minutes(Number(parts.hour), Number(parts.minute))
  };
}

describe("localClock", () => {
  it("uses the machine local timezone wall clock", () => {
    const date = new Date("2026-07-16T16:30:00.000Z");
    const value = localClock(date);
    const expected = expectedLocal(date);
    expect(value.dateKey).toBe(expected.dateKey);
    expect(value.minuteOfDay).toBe(expected.minuteOfDay);
    expect(value.iso).toBe(date.toISOString());
    expect(typeof value.timeZone).toBe("string");
    expect(value.timeZone.length).toBeGreaterThan(0);
  });

  it("reports 12:30 as minute 750", () => {
    expect(minutes(12, 30)).toBe(750);
  });

  it("keeps beijingClock as a compatible alias of localClock", () => {
    const date = new Date("2026-03-01T08:15:00.000Z");
    expect(beijingClock(date)).toEqual(localClock(date));
  });
});
