import { failureFingerprint } from "./notifier.mjs";

const TARGET = "https://game.maj-soul.com/1/";
const MAX_BROWSER_ATTEMPTS = 2;
/** Inclusive range: stay on lobby after SUCCESS before closing Edge. */
const SUCCESS_DWELL_MIN_MS = 10_000;
const SUCCESS_DWELL_MAX_MS = 30_000;

function isTerminalStatus(status) {
  return status === "SUCCESS" || status === "BLOCKED_MANUAL";
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Uniform inclusive integer ms in [SUCCESS_DWELL_MIN_MS, SUCCESS_DWELL_MAX_MS].
 * @param {() => number} random unit interval [0, 1)
 */
export function pickSuccessDwellMs(random = Math.random) {
  const span = SUCCESS_DWELL_MAX_MS - SUCCESS_DWELL_MIN_MS + 1;
  return SUCCESS_DWELL_MIN_MS + Math.floor(random() * span);
}

async function dwellAfterSuccess(dependencies) {
  const sleep =
    typeof dependencies.sleep === "function" ? dependencies.sleep : defaultSleep;
  const random =
    typeof dependencies.random === "function"
      ? dependencies.random
      : Math.random;
  await sleep(pickSuccessDwellMs(random));
}

function failurePayload(clock, fields, dependencies) {
  return {
    dateKey: clock.dateKey,
    time: clock.iso,
    kind: fields.kind,
    phase: fields.phase,
    attempts: fields.attempts,
    action: fields.action,
    logPath: dependencies.logPath ?? "%LOCALAPPDATA%\\MajSoulDaily\\logs"
  };
}

async function deliverNotification(clock, fields, dependencies) {
  const fingerprint = failureFingerprint(
    clock.dateKey,
    fields.kind,
    fields.phase
  );
  const existing = await dependencies.readState(clock.dateKey);
  if (
    existing?.notification?.status === "SENT" &&
    existing.notification.fingerprint === fingerprint
  ) {
    return { delivered: false, reason: "already-sent" };
  }

  const attempts = (existing?.notification?.attempts ?? 0) + 1;
  await dependencies.writeState(clock.dateKey, {
    notification: {
      fingerprint,
      status: "PENDING",
      attempts,
      lastAttemptAt: clock.iso,
      kind: fields.kind,
      phase: fields.phase,
      action: fields.action
    }
  });

  try {
    await dependencies.notifyOnce(
      clock,
      failurePayload(clock, fields, dependencies)
    );
    await dependencies.writeState(clock.dateKey, {
      notification: {
        fingerprint,
        status: "SENT",
        attempts,
        lastAttemptAt: clock.iso,
        sentAt: clock.iso,
        kind: fields.kind,
        phase: fields.phase,
        action: fields.action
      }
    });
    return { delivered: true };
  } catch (error) {
    if (typeof dependencies.log === "function") {
      await dependencies.log({
        level: "error",
        event: "notification-failed",
        code: error?.code || "NOTIFY_FAILED"
      });
    }
    return { delivered: false, reason: "send-failed" };
  }
}

async function servicePendingNotification(clock, state, dependencies) {
  const notification = state?.notification;
  if (!notification || notification.status !== "PENDING") return;

  const fields = {
    kind: notification.kind || state.kind || "FAILED_TRANSIENT",
    phase: notification.phase || state.phase || "unknown",
    attempts: state.attempts ?? notification.attempts ?? 1,
    action: notification.action || state.action || "请检查本地日志"
  };

  await deliverNotification(clock, fields, dependencies);
}

async function runBrowserAttempts(clock, dependencies) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_BROWSER_ATTEMPTS; attempt += 1) {
    const session = dependencies.createSession();
    try {
      await session.open(dependencies.targetUrl ?? TARGET);
      const result = await dependencies.detectLobby(session);

      if (result?.status === "SUCCESS") {
        await dependencies.writeState(clock.dateKey, {
          status: "SUCCESS",
          attempts: attempt
        });
        // Keep the lobby session open briefly so the game client can settle
        // (random 10–30s), then finally closes Edge.
        await dwellAfterSuccess(dependencies);
        return { status: "SUCCESS" };
      }

      if (result?.status === "MANUAL_ACTION_REQUIRED") {
        const fields = {
          kind: "MANUAL_ACTION_REQUIRED",
          phase: "lobby-detection",
          attempts: attempt,
          action: "请运行会话修复入口并手动完成登录或确认"
        };
        await dependencies.writeState(clock.dateKey, {
          status: "BLOCKED_MANUAL",
          attempts: attempt,
          kind: fields.kind,
          phase: fields.phase,
          action: fields.action,
          failure: result.reasonCode || result.status
        });
        await deliverNotification(clock, fields, dependencies);
        return { status: "BLOCKED_MANUAL" };
      }

      lastError = new Error(result?.status || "LOBBY_UNKNOWN");
      lastError.code = result?.status || "LOBBY_UNKNOWN";
    } catch (error) {
      lastError = error;
    } finally {
      if (session && typeof session.close === "function") {
        await session.close().catch(() => undefined);
      }
    }
  }

  const fields = {
    kind: "FAILED_TRANSIENT",
    phase: "browser-run",
    attempts: MAX_BROWSER_ATTEMPTS,
    action: "等待后续补跑或检查本机 Edge 与网络"
  };
  await dependencies.writeState(clock.dateKey, {
    status: "FAILED_TRANSIENT",
    attempts: MAX_BROWSER_ATTEMPTS,
    kind: fields.kind,
    phase: fields.phase,
    action: fields.action,
    failure: lastError?.code || "EDGE_FAILURE"
  });
  await deliverNotification(clock, fields, dependencies);
  return { status: "FAILED_TRANSIENT" };
}

async function runDailyBody(trigger, clock, dependencies) {
  let state = await dependencies.readState(clock.dateKey);

  if (state?.notification?.status === "PENDING") {
    await servicePendingNotification(clock, state, dependencies);
    state = await dependencies.readState(clock.dateKey);
  }

  if (
    isTerminalStatus(state?.status) &&
    state?.notification?.status !== "PENDING"
  ) {
    return { status: "SKIP_TERMINAL" };
  }

  const unlocked = await dependencies.isSessionUnlocked();
  const online = await dependencies.canReachTarget();
  const decision = dependencies.decideRun({
    trigger,
    minuteOfDay: clock.minuteOfDay,
    state,
    unlocked,
    online
  });

  if (decision.action === "MARK_DUE") {
    await dependencies.writeState(clock.dateKey, { status: "PENDING_DUE" });
    return { status: "PENDING_DUE" };
  }

  if (decision.action !== "RUN") {
    return { status: decision.action };
  }

  await dependencies.writeState(clock.dateKey, {
    status: "RUNNING",
    attempts: 0
  });

  return runBrowserAttempts(clock, dependencies);
}

export async function runDaily({
  trigger,
  now = new Date(),
  dependencies,
  assumeLock = false
}) {
  if (!dependencies || typeof dependencies !== "object") {
    throw new TypeError("dependencies are required");
  }

  const clock = dependencies.clock(now);

  if (assumeLock) {
    return runDailyBody(trigger, clock, dependencies);
  }

  try {
    return await dependencies.withRunLock(() =>
      runDailyBody(trigger, clock, dependencies)
    );
  } catch (error) {
    if (error?.code === "RUN_ALREADY_ACTIVE") {
      return { status: "SKIP_ACTIVE" };
    }
    throw error;
  }
}
