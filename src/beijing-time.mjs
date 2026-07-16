const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
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

export function beijingClock(date = new Date()) {
  const parts = Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  return {
    dateKey: parts.year + "-" + parts.month + "-" + parts.day,
    minuteOfDay: minutes(Number(parts.hour), Number(parts.minute)),
    iso: date.toISOString()
  };
}
