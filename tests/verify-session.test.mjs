import { describe, expect, it, vi } from "vitest";
import { verifyStoredSession } from "../src/cli/verify-session.mjs";

const TARGET = "https://game.maj-soul.com/1/";

function fixture(overrides = {}) {
  const open = vi.fn(async () => {});
  const close = vi.fn(async () => {});
  const session = { open, close };
  const tokenizer = vi.fn(() => "a".repeat(64));
  const dependencies = {
    paths: { profile: "private-profile", fingerprint: "strict-record" },
    readFingerprintRecord: vi.fn(async () => ({ strict: "record" })),
    createSession: vi.fn(() => session),
    withFingerprintTokenizer: vi.fn(async (callback) => callback(tokenizer)),
    detectLobby: vi.fn(async () => ({ status: "SUCCESS" })),
    ...overrides
  };
  return { open, close, session, tokenizer, dependencies };
}

describe("verifyStoredSession", () => {
  it.each([
    [
      "success",
      { status: "SUCCESS" },
      { status: "SUCCESS", exitCode: 0 }
    ],
    [
      "manual action",
      {
        status: "MANUAL_ACTION_REQUIRED",
        reasonCode: "LOBBY_UNCONFIRMED"
      },
      {
        status: "MANUAL_ACTION_REQUIRED",
        reasonCode: "LOBBY_UNCONFIRMED",
        exitCode: 3
      }
    ]
  ])("maps %s and closes the fresh headless session", async (
    _label,
    detectorResult,
    expected
  ) => {
    const value = fixture({
      detectLobby: vi.fn(async () => detectorResult)
    });

    await expect(verifyStoredSession(value.dependencies)).resolves.toEqual(
      expected
    );

    expect(value.dependencies.createSession).toHaveBeenCalledWith({
      profileDir: "private-profile",
      headless: true
    });
    expect(value.open).toHaveBeenCalledWith(TARGET);
    expect(value.dependencies.detectLobby).toHaveBeenCalledWith(
      value.session,
      { strict: "record" },
      value.tokenizer
    );
    expect(value.close).toHaveBeenCalledOnce();
  });

  it("maps a missing record to a bounded configuration failure", async () => {
    const value = fixture({
      readFingerprintRecord: vi.fn(async () => null)
    });

    await expect(verifyStoredSession(value.dependencies)).resolves.toEqual({
      status: "CONFIG_ERROR",
      reasonCode: "FINGERPRINT_NOT_ENROLLED",
      exitCode: 2
    });

    expect(value.dependencies.createSession).not.toHaveBeenCalled();
  });

  it("maps an invalid record to a bounded configuration failure", async () => {
    const invalid = Object.assign(new Error("sensitive invalid payload"), {
      code: "FINGERPRINT_RECORD_INVALID"
    });
    const value = fixture({
      readFingerprintRecord: vi.fn(async () => {
        throw invalid;
      })
    });

    await expect(verifyStoredSession(value.dependencies)).resolves.toEqual({
      status: "CONFIG_ERROR",
      reasonCode: "FINGERPRINT_RECORD_INVALID",
      exitCode: 2
    });
  });

  it("maps detector exceptions to a bounded transient failure and cleans up", async () => {
    const secret = "private-page-or-token-fragment";
    const value = fixture({
      detectLobby: vi.fn(async () => {
        throw new Error(secret);
      })
    });
    const consoleSpies = ["log", "info", "warn", "error"].map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {})
    );

    try {
      await expect(verifyStoredSession(value.dependencies)).resolves.toEqual({
        status: "TRANSIENT_ERROR",
        reasonCode: "SESSION_VERIFICATION_FAILED",
        exitCode: 2
      });

      expect(value.close).toHaveBeenCalledOnce();
      expect(consoleSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
      expect(JSON.stringify(consoleSpies.flatMap((spy) => spy.mock.calls)))
        .not.toContain(secret);
    } finally {
      for (const spy of consoleSpies) spy.mockRestore();
    }
  });

  it("closes the session when navigation fails", async () => {
    const failure = new Error("navigation failed");
    const value = fixture();
    value.open.mockRejectedValueOnce(failure);

    await expect(verifyStoredSession(value.dependencies)).resolves.toEqual({
      status: "TRANSIENT_ERROR",
      reasonCode: "SESSION_VERIFICATION_FAILED",
      exitCode: 2
    });

    expect(value.close).toHaveBeenCalledOnce();
  });

  it.each([
    ["synchronously", () => {
      throw new Error("private constructor failure");
    }],
    ["asynchronously", async () => {
      throw new Error("private asynchronous constructor failure");
    }]
  ])("maps a session factory failure %s without leaking it", async (
    _label,
    createSession
  ) => {
    const value = fixture({ createSession: vi.fn(createSession) });

    await expect(verifyStoredSession(value.dependencies)).resolves.toEqual({
      status: "TRANSIENT_ERROR",
      reasonCode: "SESSION_VERIFICATION_FAILED",
      exitCode: 2
    });

    expect(value.close).not.toHaveBeenCalled();
  });
});
