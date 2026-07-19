import { describe, expect, it, vi } from "vitest";
import { repairSession } from "../src/cli/repair-session.mjs";

describe("repairSession", () => {
  it("holds one lock for setup, clear, and verification", async () => {
    const order = [];
    const paths = { lock: "lock", state: "state", logs: "logs", profile: "p" };

    const outcome = await repairSession({
      paths,
      beijingClock: () => ({
        dateKey: "2026-07-16",
        minuteOfDay: 900,
        iso: "2026-07-16T06:00:00.000Z"
      }),
      withRunLock: async (_paths, callback) => {
        order.push("lock");
        try {
          return await callback();
        } finally {
          order.push("unlock");
        }
      },
      runVisibleSetup: async () => {
        order.push("setup");
      },
      clearBlockedState: async () => {
        order.push("clear");
      },
      readState: async () => {
        order.push("read");
        return { status: "BLOCKED_MANUAL" };
      },
      writeState: async () => {
        order.push("write-block");
      },
      productionDependencies: () => ({ mark: true }),
      runDaily: async ({ assumeLock }) => {
        order.push("verify");
        expect(assumeLock).toBe(true);
        return { status: "SUCCESS" };
      }
    });

    expect(outcome).toMatchObject({ status: "SUCCESS", exitCode: 0 });
    expect(order).toEqual([
      "lock",
      "read",
      "setup",
      "clear",
      "verify",
      "unlock"
    ]);
  });

  it("restores BLOCKED_MANUAL when post-repair verification is not SUCCESS", async () => {
    const writes = [];
    const outcome = await repairSession({
      paths: { lock: "lock", state: "state", logs: "logs" },
      beijingClock: () => ({
        dateKey: "2026-07-16",
        minuteOfDay: 900,
        iso: "2026-07-16T06:00:00.000Z"
      }),
      withRunLock: async (_paths, callback) => callback(),
      runVisibleSetup: async () => {},
      clearBlockedState: async () => {},
      readState: async () => ({ status: "BLOCKED_MANUAL" }),
      writeState: async (dateKey, state) => {
        writes.push({ dateKey, state });
      },
      productionDependencies: () => ({}),
      runDaily: async () => ({ status: "BLOCKED_MANUAL" })
    });

    expect(outcome.exitCode).toBe(3);
    expect(writes[0].state.status).toBe("BLOCKED_MANUAL");
    expect(writes[0].state.previousStatus).toBe("BLOCKED_MANUAL");
  });
});
