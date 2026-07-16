import { describe, expect, it } from "vitest";
import { decideRun } from "../src/schedule-policy.mjs";

const base = {
  trigger: "primary",
  minuteOfDay: 800,
  state: null,
  unlocked: true,
  online: true
};

function thrownBy(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the operation to throw.");
}

describe("decideRun", () => {
  it.each([undefined, null, "", "manual"])(
    "rejects the unknown trigger %s before reading state or adapters",
    (trigger) => {
      const input = {
        trigger,
        minuteOfDay: 800,
        get state() {
          throw new Error("state must not be read");
        },
        get unlocked() {
          throw new Error("session must not be read");
        },
        get online() {
          throw new Error("network must not be read");
        }
      };

      expect(thrownBy(() => decideRun(input))).toMatchObject({
        name: "TypeError",
        code: "INVALID_TRIGGER"
      });
    }
  );

  it("bounds an unknown trigger before validating its invalid minute", () => {
    expect(thrownBy(() => decideRun({
      ...base,
      trigger: "manual",
      minuteOfDay: -1
    }))).toMatchObject({ code: "INVALID_TRIGGER" });
  });

  it.each([-1, 1440, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "600", null, undefined])(
    "rejects the invalid Beijing minute %s before reading state or adapters",
    (minuteOfDay) => {
      const input = {
        trigger: "primary",
        minuteOfDay,
        get state() {
          throw new Error("state must not be read");
        },
        get unlocked() {
          throw new Error("session must not be read");
        },
        get online() {
          throw new Error("network must not be read");
        }
      };

      expect(thrownBy(() => decideRun(input))).toMatchObject({
        name: "TypeError",
        code: "INVALID_MINUTE"
      });
    }
  );

  it.each(["SUCCESS", "BLOCKED_MANUAL"])(
    "skips terminal state %s without reading session or network state",
    (status) => {
      const input = {
        trigger: "catchup",
        minuteOfDay: 800,
        state: { status },
        get unlocked() {
          throw new Error("session must not be read");
        },
        get online() {
          throw new Error("network must not be read");
        }
      };

      expect(decideRun(input)).toEqual({ action: "SKIP_TERMINAL" });
    }
  );

  it("applies the 10:00 boundary before reading a locked primary session", () => {
    const input = {
      trigger: "primary",
      minuteOfDay: 599,
      state: null,
      get unlocked() {
        throw new Error("session must not be read before 10:00");
      },
      get online() {
        throw new Error("network must not be read before 10:00");
      }
    };

    expect(decideRun(input)).toEqual({ action: "SKIP_BEFORE_WINDOW" });
  });

  it("marks a locked primary due at exactly 10:00", () => {
    const input = {
      ...base,
      minuteOfDay: 600,
      unlocked: false,
      get online() {
        throw new Error("network must not be read while locked");
      }
    };

    expect(decideRun(input)).toEqual({ action: "MARK_DUE" });
  });

  it("skips a locked catch-up without reading network state", () => {
    const input = {
      ...base,
      trigger: "catchup",
      unlocked: false,
      get online() {
        throw new Error("network must not be read while locked");
      }
    };

    expect(decideRun(input)).toEqual({ action: "SKIP_LOCKED" });
  });

  it("skips an offline unlocked run", () => {
    expect(decideRun({ ...base, online: false })).toEqual({ action: "SKIP_OFFLINE" });
  });

  it("runs a primary trigger at exactly 10:00", () => {
    expect(decideRun({ ...base, minuteOfDay: 600 })).toEqual({ action: "RUN" });
  });

  it.each([600, 749])(
    "skips catch-up at minute %s before 12:30 without a due marker",
    (minuteOfDay) => {
      expect(decideRun({
        ...base,
        trigger: "catchup",
        minuteOfDay
      })).toEqual({ action: "SKIP_BEFORE_WINDOW" });
    }
  );

  it.each([600, 749])(
    "runs catch-up at minute %s before 12:30 with a due marker",
    (minuteOfDay) => {
      expect(decideRun({
        ...base,
        trigger: "catchup",
        minuteOfDay,
        state: { status: "PENDING_DUE" }
      })).toEqual({ action: "RUN" });
    }
  );

  it("runs catch-up at exactly 12:30 without a due marker", () => {
    expect(decideRun({
      ...base,
      trigger: "catchup",
      minuteOfDay: 750
    })).toEqual({ action: "RUN" });
  });

  it.each([1425, 1439])(
    "allows same-day catch-up at minute %s without an artificial upper cap",
    (minuteOfDay) => {
      expect(decideRun({
        ...base,
        trigger: "catchup",
        minuteOfDay
      })).toEqual({ action: "RUN" });
    }
  );
});
