import { minutes } from "./beijing-time.mjs";

const VALID_TRIGGERS = new Set(["primary", "catchup"]);
const START_MINUTE = minutes(10, 0);
const CATCHUP_MINUTE = minutes(12, 30);

function invalidInput(code, message) {
  const error = new TypeError(message);
  error.code = code;
  return error;
}

export function decideRun(input) {
  const trigger = input?.trigger;
  if (!VALID_TRIGGERS.has(trigger)) {
    throw invalidInput("INVALID_TRIGGER", "trigger must be primary or catchup.");
  }

  const minuteOfDay = input.minuteOfDay;
  if (!Number.isInteger(minuteOfDay) || minuteOfDay < 0 || minuteOfDay >= minutes(24, 0)) {
    throw invalidInput("INVALID_MINUTE", "minuteOfDay must be an integer from 0 through 1439.");
  }

  const state = input.state;
  if (state?.status === "SUCCESS" || state?.status === "BLOCKED_MANUAL") {
    return { action: "SKIP_TERMINAL" };
  }

  if (minuteOfDay < START_MINUTE) {
    return { action: "SKIP_BEFORE_WINDOW" };
  }

  if (!input.unlocked) {
    return trigger === "primary"
      ? { action: "MARK_DUE" }
      : { action: "SKIP_LOCKED" };
  }

  if (!input.online) {
    return { action: "SKIP_OFFLINE" };
  }

  if (
    trigger === "catchup"
    && minuteOfDay < CATCHUP_MINUTE
    && state?.status !== "PENDING_DUE"
  ) {
    return { action: "SKIP_BEFORE_WINDOW" };
  }

  return { action: "RUN" };
}
