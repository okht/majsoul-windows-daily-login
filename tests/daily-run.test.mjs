import { describe, expect, it, vi } from "vitest";
import { runDaily } from "../src/daily-run.mjs";

function makeDependencies(overrides = {}) {
  const stateWrites = [];
  let currentState = null;
  const session = {
    open: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    metadata: vi.fn(),
    frame: vi.fn()
  };
  const lockHeld = { value: false };
  const released = { value: false };

  const value = {
    targetUrl: "https://game.maj-soul.com/1/",
    logPath: "%LOCALAPPDATA%\\MajSoulDaily\\logs",
    clock: () => ({
      dateKey: "2026-07-16",
      minuteOfDay: 800,
      iso: "2026-07-16T04:30:00.000Z"
    }),
    readState: vi.fn(async () => currentState),
    writeState: vi.fn(async (_date, state) => {
      currentState = { ...(currentState ?? {}), ...state };
      if (state.notification) {
        currentState.notification = {
          ...(currentState.notification ?? {}),
          ...state.notification
        };
      }
      stateWrites.push(structuredClone(currentState));
    }),
    isSessionUnlocked: vi.fn(async () => true),
    canReachTarget: vi.fn(async () => true),
    decideRun: vi.fn().mockReturnValue({ action: "RUN" }),
    withRunLock: vi.fn(async (callback) => {
      lockHeld.value = true;
      try {
        return await callback();
      } finally {
        lockHeld.value = false;
        released.value = true;
      }
    }),
    createSession: vi.fn(() => session),
    detectLobby: vi.fn(async () => ({ status: "SUCCESS" })),
    notifyOnce: vi.fn(async () => {}),
    log: vi.fn(async () => {}),
    ...overrides
  };

  return { stateWrites, session, lockHeld, released, value, getState: () => currentState, setState: (s) => { currentState = s; } };
}

describe("runDaily", () => {
  it("writes SUCCESS, closes Edge, and sends no email", async () => {
    const deps = makeDependencies();
    await expect(
      runDaily({ trigger: "primary", dependencies: deps.value })
    ).resolves.toEqual({ status: "SUCCESS" });
    expect(deps.stateWrites.at(-1).status).toBe("SUCCESS");
    expect(deps.value.notifyOnce).not.toHaveBeenCalled();
    expect(deps.session.close).toHaveBeenCalledOnce();
    expect(deps.released.value).toBe(true);
  });

  it("never launches Edge for an existing SUCCESS state", async () => {
    const deps = makeDependencies();
    deps.setState({ status: "SUCCESS" });
    deps.value.decideRun = vi.fn(() => {
      throw new Error("decideRun should not run for pure terminal success");
    });

    await expect(
      runDaily({ trigger: "primary", dependencies: deps.value })
    ).resolves.toEqual({ status: "SKIP_TERMINAL" });
    expect(deps.value.createSession).not.toHaveBeenCalled();
    expect(deps.value.isSessionUnlocked).not.toHaveBeenCalled();
    expect(deps.value.canReachTarget).not.toHaveBeenCalled();
  });

  it("writes PENDING_DUE for a locked primary and exits", async () => {
    const deps = makeDependencies({
      decideRun: vi.fn().mockReturnValue({ action: "MARK_DUE" }),
      isSessionUnlocked: vi.fn(async () => false)
    });

    await expect(
      runDaily({ trigger: "primary", dependencies: deps.value })
    ).resolves.toEqual({ status: "PENDING_DUE" });
    expect(deps.stateWrites.at(-1).status).toBe("PENDING_DUE");
    expect(deps.value.createSession).not.toHaveBeenCalled();
  });

  it("honors catch-up policy skips without launching Edge", async () => {
    const deps = makeDependencies({
      decideRun: vi.fn().mockReturnValue({ action: "SKIP_BEFORE_WINDOW" })
    });

    await expect(
      runDaily({ trigger: "catchup", dependencies: deps.value })
    ).resolves.toEqual({ status: "SKIP_BEFORE_WINDOW" });
    expect(deps.value.createSession).not.toHaveBeenCalled();
  });

  it("writes BLOCKED_MANUAL, closes Edge, and sends one text notification", async () => {
    const deps = makeDependencies({
      detectLobby: vi.fn(async () => ({
        status: "MANUAL_ACTION_REQUIRED",
        reasonCode: "ACCESSIBLE_MANUAL_MARKER"
      }))
    });

    await expect(
      runDaily({ trigger: "primary", dependencies: deps.value })
    ).resolves.toEqual({ status: "BLOCKED_MANUAL" });
    expect(deps.stateWrites.at(-1).status).toBe("BLOCKED_MANUAL");
    expect(deps.value.notifyOnce).toHaveBeenCalledTimes(1);
    expect(deps.session.close).toHaveBeenCalledOnce();
    expect(deps.stateWrites.some((s) => s.notification?.status === "PENDING")).toBe(
      true
    );
    expect(deps.stateWrites.at(-1).notification?.status).toBe("SENT");
  });

  it("retries Edge crashes once then writes FAILED_TRANSIENT and notifies", async () => {
    const deps = makeDependencies();
    deps.value.createSession = vi
      .fn()
      .mockImplementationOnce(() => ({
        open: vi.fn(async () => {
          throw Object.assign(new Error("edge boom"), { code: "EDGE_FAILURE" });
        }),
        close: vi.fn(async () => {})
      }))
      .mockImplementationOnce(() => ({
        open: vi.fn(async () => {
          throw Object.assign(new Error("edge boom again"), {
            code: "EDGE_FAILURE"
          });
        }),
        close: vi.fn(async () => {})
      }));

    await expect(
      runDaily({ trigger: "primary", dependencies: deps.value })
    ).resolves.toEqual({ status: "FAILED_TRANSIENT" });
    expect(deps.value.createSession).toHaveBeenCalledTimes(2);
    expect(deps.stateWrites.at(-1).status).toBe("FAILED_TRANSIENT");
    expect(deps.value.notifyOnce).toHaveBeenCalledTimes(1);
  });

  it("closes Edge and releases the lock even when detection throws", async () => {
    const closed = vi.fn(async () => {});
    const deps = makeDependencies({
      createSession: () => ({
        open: vi.fn(async () => {}),
        close: closed
      }),
      detectLobby: vi.fn(async () => {
        throw new Error("detector-crash");
      })
    });
    // both attempts throw
    deps.value.detectLobby = vi
      .fn()
      .mockRejectedValueOnce(new Error("detector-crash"))
      .mockRejectedValueOnce(new Error("detector-crash"));

    await runDaily({ trigger: "primary", dependencies: deps.value });
    expect(closed).toHaveBeenCalledTimes(2);
    expect(deps.released.value).toBe(true);
  });

  it("maps an active run lock to an intentional skip", async () => {
    const deps = makeDependencies({
      withRunLock: async () => {
        const error = new Error("busy");
        error.code = "RUN_ALREADY_ACTIVE";
        throw error;
      }
    });

    await expect(
      runDaily({ trigger: "primary", dependencies: deps.value })
    ).resolves.toEqual({ status: "SKIP_ACTIVE" });
  });

  it("services a pending terminal notification before skipping browser work", async () => {
    const deps = makeDependencies();
    deps.setState({
      status: "BLOCKED_MANUAL",
      kind: "MANUAL_ACTION_REQUIRED",
      phase: "lobby-detection",
      action: "请运行会话修复",
      attempts: 1,
      notification: {
        fingerprint: "2026-07-16\u001fMANUAL_ACTION_REQUIRED\u001flobby-detection",
        status: "PENDING",
        attempts: 1
      }
    });

    await expect(
      runDaily({ trigger: "catchup", dependencies: deps.value })
    ).resolves.toEqual({ status: "SKIP_TERMINAL" });
    expect(deps.value.notifyOnce).toHaveBeenCalledTimes(1);
    expect(deps.value.createSession).not.toHaveBeenCalled();
    expect(deps.stateWrites.at(-1).notification.status).toBe("SENT");
  });

  it("leaves notification PENDING when SMTP fails", async () => {
    const deps = makeDependencies({
      detectLobby: vi.fn(async () => ({
        status: "MANUAL_ACTION_REQUIRED",
        reasonCode: "ACCESSIBLE_MANUAL_MARKER"
      })),
      notifyOnce: vi.fn(async () => {
        throw new Error("smtp-down");
      })
    });

    await expect(
      runDaily({ trigger: "primary", dependencies: deps.value })
    ).resolves.toEqual({ status: "BLOCKED_MANUAL" });
    expect(deps.stateWrites.at(-1).status).toBe("BLOCKED_MANUAL");
    expect(deps.stateWrites.at(-1).notification.status).toBe("PENDING");
  });

  it("does not re-send a notification that is already SENT for the same fingerprint", async () => {
    const deps = makeDependencies({
      detectLobby: vi.fn(async () => ({
        status: "MANUAL_ACTION_REQUIRED",
        reasonCode: "ACCESSIBLE_MANUAL_MARKER"
      }))
    });
    deps.setState({
      status: null,
      notification: {
        fingerprint: "2026-07-16\u001fMANUAL_ACTION_REQUIRED\u001flobby-detection",
        status: "SENT",
        sentAt: "2026-07-16T01:00:00.000Z"
      }
    });

    await runDaily({ trigger: "primary", dependencies: deps.value });
    expect(deps.value.notifyOnce).not.toHaveBeenCalled();
  });

  it("reads and decides only while the run lock is held", async () => {
    const order = [];
    const deps = makeDependencies({
      withRunLock: async (callback) => {
        order.push("lock");
        try {
          return await callback();
        } finally {
          order.push("unlock");
        }
      },
      readState: vi.fn(async () => {
        order.push("read");
        return null;
      }),
      isSessionUnlocked: vi.fn(async () => {
        order.push("session");
        return true;
      }),
      canReachTarget: vi.fn(async () => {
        order.push("online");
        return true;
      }),
      decideRun: vi.fn(() => {
        order.push("decide");
        return { action: "SKIP_OFFLINE" };
      })
    });

    await runDaily({ trigger: "primary", dependencies: deps.value });
    expect(order).toEqual(["lock", "read", "session", "online", "decide", "unlock"]);
  });
});
