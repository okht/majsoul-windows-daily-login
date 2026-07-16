import { describe, expect, it, vi } from "vitest";
import { detectLobby } from "../src/browser/lobby-detector.mjs";

function clock() {
  let current = 0;
  return {
    now: vi.fn(() => current),
    sleep: vi.fn(async (milliseconds) => {
      current += milliseconds;
    })
  };
}

function guardedSession(text = "Lobby", frameCount = 20) {
  const metadata = vi.fn(async () => ({
    url: "https://game.maj-soul.com/1/",
    title: "Mahjong Soul",
    text
  }));
  const frames = Array.from({ length: frameCount }, (_, index) =>
    Buffer.from([index + 1])
  );
  const frame = vi.fn(async () => frames.shift());
  const session = new Proxy(Object.create(null), {
    get(_target, property) {
      if (property === "metadata") return metadata;
      if (property === "frame") return frame;
      throw new Error("forbidden-session-capability:" + String(property));
    }
  });
  return { session, metadata, frame };
}

function options(scores, overrides = {}) {
  const timer = clock();
  return {
    timer,
    scoreFrame: vi.fn(async () => scores.shift()),
    value: {
      now: timer.now,
      sleep: timer.sleep,
      scoreFrame: undefined,
      deadlineMs: 20_000,
      intervalMs: 5_000,
      ...overrides
    }
  };
}

describe("detectLobby", () => {
  it.each([
    "登录",
    "登入遊戲",
    "请完成安全验证",
    "請完成驗證碼",
    "Please complete CAPTCHA",
    "Confirm",
    "I agree"
  ])("returns manual action immediately for accessible marker %s", async (text) => {
    const { session, frame } = guardedSession(text);
    const scoreFrame = vi.fn();

    await expect(
      detectLobby(session, {}, () => "token", {
        now: () => 0,
        sleep: vi.fn(),
        scoreFrame
      })
    ).resolves.toEqual({
      status: "MANUAL_ACTION_REQUIRED",
      reasonCode: "ACCESSIBLE_MANUAL_MARKER"
    });

    expect(frame).not.toHaveBeenCalled();
    expect(scoreFrame).not.toHaveBeenCalled();
  });

  it("requires exactly three consecutive scores at the fixed threshold", async () => {
    const { session, frame } = guardedSession();
    const timer = clock();
    const scoreFrame = vi
      .fn()
      .mockResolvedValueOnce(0.88)
      .mockResolvedValueOnce(0.91)
      .mockResolvedValueOnce(0.88);

    await expect(
      detectLobby(session, { strict: true }, () => "token", {
        now: timer.now,
        sleep: timer.sleep,
        scoreFrame,
        deadlineMs: 20_000,
        intervalMs: 5_000
      })
    ).resolves.toEqual({ status: "SUCCESS" });

    expect(frame).toHaveBeenCalledTimes(3);
    expect(scoreFrame).toHaveBeenCalledTimes(3);
    expect(timer.sleep).toHaveBeenCalledTimes(2);
  });

  it("resets the consecutive counter after a low score", async () => {
    const { session, frame } = guardedSession();
    const timer = clock();
    const scores = [0.9, 0.9, 0.2, 0.9, 0.9, 0.9];
    const scoreFrame = vi.fn(async () => scores.shift());

    await expect(
      detectLobby(session, {}, () => "token", {
        now: timer.now,
        sleep: timer.sleep,
        scoreFrame,
        deadlineMs: 30_000,
        intervalMs: 5_000
      })
    ).resolves.toEqual({ status: "SUCCESS" });

    expect(frame).toHaveBeenCalledTimes(6);
  });

  it("turns a reached deadline into conservative manual action", async () => {
    const { session, frame } = guardedSession();
    const timer = clock();
    const scoreFrame = vi.fn(async () => 0.87);

    await expect(
      detectLobby(session, {}, () => "token", {
        now: timer.now,
        sleep: timer.sleep,
        scoreFrame,
        deadlineMs: 10_000,
        intervalMs: 5_000
      })
    ).resolves.toEqual({
      status: "MANUAL_ACTION_REQUIRED",
      reasonCode: "LOBBY_UNCONFIRMED"
    });

    expect(frame).toHaveBeenCalledTimes(2);
  });

  it("treats unknown scores as unconfirmed instead of success", async () => {
    const { session } = guardedSession();
    const timer = clock();
    const scoreFrame = vi.fn(async () => Number.NaN);

    await expect(
      detectLobby(session, {}, () => "token", {
        now: timer.now,
        sleep: timer.sleep,
        scoreFrame,
        deadlineMs: 5_000,
        intervalMs: 5_000
      })
    ).resolves.toEqual({
      status: "MANUAL_ACTION_REQUIRED",
      reasonCode: "LOBBY_UNCONFIRMED"
    });
  });

  it("does not mistake 每日登录奖励 for a manual login control", async () => {
    const { session, frame } = guardedSession("每日登录奖励\n大厅");
    const timer = clock();
    const scoreFrame = vi.fn(async () => 0.95);

    await expect(
      detectLobby(session, {}, () => "token", {
        now: timer.now,
        sleep: timer.sleep,
        scoreFrame,
        deadlineMs: 20_000,
        intervalMs: 5_000
      })
    ).resolves.toEqual({ status: "SUCCESS" });

    expect(frame).toHaveBeenCalledTimes(3);
  });

  it.each([
    "登录奖励\n大厅",
    "登錄獎勵\n大廳",
    "Login reward\nLobby"
  ])("does not mistake a same-line reward label for a manual control: %s", async (
    text
  ) => {
    const { session, frame } = guardedSession(text);
    const timer = clock();
    const scoreFrame = vi.fn(async () => 0.95);

    await expect(
      detectLobby(session, {}, () => "token", {
        now: timer.now,
        sleep: timer.sleep,
        scoreFrame,
        deadlineMs: 20_000,
        intervalMs: 5_000
      })
    ).resolves.toEqual({ status: "SUCCESS" });

    expect(frame).toHaveBeenCalledTimes(3);
  });

  it("checks normalized title text for a manual marker", async () => {
    const { session, frame, metadata } = guardedSession("Lobby");
    metadata.mockResolvedValueOnce({
      url: "https://game.maj-soul.com/1/",
      title: "  Please   verify  ",
      text: "Lobby"
    });

    await expect(
      detectLobby(session, {}, () => "token", {
        now: () => 0,
        sleep: vi.fn(),
        scoreFrame: vi.fn()
      })
    ).resolves.toEqual({
      status: "MANUAL_ACTION_REQUIRED",
      reasonCode: "ACCESSIBLE_MANUAL_MARKER"
    });

    expect(frame).not.toHaveBeenCalled();
  });

  it("stops when a manual marker appears during polling", async () => {
    const { session, frame, metadata } = guardedSession("Lobby");
    metadata
      .mockResolvedValueOnce({ title: "Mahjong Soul", text: "Lobby" })
      .mockResolvedValueOnce({ title: "Mahjong Soul", text: "登录" });
    const timer = clock();

    await expect(
      detectLobby(session, {}, () => "token", {
        now: timer.now,
        sleep: timer.sleep,
        scoreFrame: vi.fn(async () => 0.2),
        deadlineMs: 20_000,
        intervalMs: 5_000
      })
    ).resolves.toEqual({
      status: "MANUAL_ACTION_REQUIRED",
      reasonCode: "ACCESSIBLE_MANUAL_MARKER"
    });

    expect(metadata).toHaveBeenCalledTimes(2);
    expect(frame).toHaveBeenCalledTimes(1);
  });

  it("propagates frame and score exceptions as transient errors", async () => {
    const frameError = Object.assign(new Error("frame failed"), {
      code: "FRAME_FAILED"
    });
    const scoreError = Object.assign(new Error("score failed"), {
      code: "SCORE_FAILED"
    });
    const first = guardedSession();
    first.frame.mockRejectedValueOnce(frameError);

    await expect(
      detectLobby(first.session, {}, () => "token", {
        now: () => 0,
        sleep: vi.fn(),
        scoreFrame: vi.fn()
      })
    ).rejects.toBe(frameError);

    const second = guardedSession();
    await expect(
      detectLobby(second.session, {}, () => "token", {
        now: () => 0,
        sleep: vi.fn(),
        scoreFrame: vi.fn(async () => {
          throw scoreError;
        })
      })
    ).rejects.toBe(scoreError);
  });
});
