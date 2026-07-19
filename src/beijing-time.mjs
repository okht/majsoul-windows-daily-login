// Wall-clock helpers for the machine's current system timezone.
// Daily window 10:00-12:30 means local morning where the PC is configured,
// not a hard-coded Asia/Shanghai offset.

const formatter = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23"
});

export function minutes(hour, minute) {
  return hour * 60 + minute;
}

/**
 * Local wall clock for scheduling and daily state keys.
 * dateKey / minuteOfDay follow the OS timezone (e.g. China, US, EU).
 */
export function localClock(date = new Date()) {
  const parts = Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  return {
    dateKey: parts.year + "-" + parts.month + "-" + parts.day,
    minuteOfDay: minutes(Number(parts.hour), Number(parts.minute)),
    iso: date.toISOString(),
    timeZone:
      Intl.DateTimeFormat().resolvedOptions().timeZone || "local"
  };
}

/** @deprecated Use localClock. Kept so existing call sites keep working. */
export const beijingClock = localClock;
