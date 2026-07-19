import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { failureFingerprint, sendFailureMail } from "../src/notifier.mjs";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("failureFingerprint", () => {
  it("is deterministic for the same date, kind, and phase", () => {
    expect(failureFingerprint("2026-07-16", "LOBBY_TIMEOUT", "lobby-detection"))
      .toBe(
        failureFingerprint("2026-07-16", "LOBBY_TIMEOUT", "lobby-detection")
      );
  });

  it("changes when any component changes", () => {
    const base = failureFingerprint(
      "2026-07-16",
      "LOBBY_TIMEOUT",
      "lobby-detection"
    );
    expect(
      failureFingerprint("2026-07-17", "LOBBY_TIMEOUT", "lobby-detection")
    ).not.toBe(base);
    expect(
      failureFingerprint("2026-07-16", "MANUAL_ACTION_REQUIRED", "lobby-detection")
    ).not.toBe(base);
    expect(
      failureFingerprint("2026-07-16", "LOBBY_TIMEOUT", "browser-open")
    ).not.toBe(base);
  });
});

describe("sendFailureMail", () => {
  it("sends one plain-text Gmail message without attachments or secrets", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "test" });
    const createTransport = vi.fn(() => ({ sendMail }));
    const store = {
      get: vi.fn(() => "app-secret")
    };
    const spies = ["log", "info", "warn", "error"].map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {})
    );

    await sendFailureMail(
      { sender: "sender@example.com", recipient: "recipient@example.com" },
      {
        dateKey: "2026-07-16",
        time: "2026-07-16T04:30:00.000Z",
        kind: "LOBBY_TIMEOUT",
        phase: "lobby-detection",
        attempts: 2,
        action: "请手动检查登录状态",
        logPath: "%LOCALAPPDATA%\\MajSoulDaily\\logs"
      },
      { createTransport, store }
    );

    expect(store.get).toHaveBeenCalledWith("sender@example.com");
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        auth: {
          user: "sender@example.com",
          pass: "app-secret"
        }
      })
    );

    expect(sendMail).toHaveBeenCalledTimes(1);
    const message = sendMail.mock.calls[0][0];
    expect(message).toMatchObject({
      from: "sender@example.com",
      to: "recipient@example.com",
      subject: "MajSoulDaily 2026-07-16 LOBBY_TIMEOUT"
    });
    expect(message).not.toHaveProperty("html");
    expect(message).not.toHaveProperty("attachments");

    expect(message.text).toContain("发生时间：2026-07-16T04:30:00.000Z");
    expect(message.text).toContain("设备名称：" + os.hostname());
    expect(message.text).toContain("失败类型：LOBBY_TIMEOUT");
    expect(message.text).toContain("当前阶段：lobby-detection");
    expect(message.text).toContain("执行次数：2");
    expect(message.text).toContain("建议操作：请手动检查登录状态");
    expect(message.text).toContain(
      "本地日志：%LOCALAPPDATA%\\MajSoulDaily\\logs"
    );

    const body = message.text.toLowerCase();
    expect(body).not.toContain("cookie");
    expect(body).not.toContain("local storage");
    expect(body).not.toContain("<html");
    expect(body).not.toContain("screenshot");
    expect(body).not.toContain("app-secret");
    expect(message.subject).not.toContain("app-secret");

    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain("app-secret");
    }
  });

  it("fails closed when the Gmail credential is missing", async () => {
    const sendMail = vi.fn();
    const createTransport = vi.fn(() => ({ sendMail }));

    await expect(
      sendFailureMail(
        { sender: "sender@example.com", recipient: "recipient@example.com" },
        {
          dateKey: "2026-07-16",
          time: "2026-07-16T04:30:00.000Z",
          kind: "LOBBY_TIMEOUT",
          phase: "lobby-detection",
          attempts: 1,
          action: "请手动检查登录状态",
          logPath: "%LOCALAPPDATA%\\MajSoulDaily\\logs"
        },
        { createTransport, store: { get: () => null } }
      )
    ).rejects.toMatchObject({ code: "GMAIL_CREDENTIAL_MISSING" });

    expect(createTransport).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("performs exactly one send attempt and leaves dedup to the caller", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "once" });
    const createTransport = vi.fn(() => ({ sendMail }));
    const store = { get: () => "app-secret" };
    const failure = {
      dateKey: "2026-07-16",
      time: "2026-07-16T04:30:00.000Z",
      kind: "LOBBY_TIMEOUT",
      phase: "lobby-detection",
      attempts: 1,
      action: "请手动检查登录状态",
      logPath: "%LOCALAPPDATA%\\MajSoulDaily\\logs"
    };

    await sendFailureMail(
      { sender: "sender@example.com", recipient: "recipient@example.com" },
      failure,
      { createTransport, store }
    );
    await sendFailureMail(
      { sender: "sender@example.com", recipient: "recipient@example.com" },
      failure,
      { createTransport, store }
    );

    expect(sendMail).toHaveBeenCalledTimes(2);
    expect(
      failureFingerprint(failure.dateKey, failure.kind, failure.phase)
    ).toBeTruthy();
  });
});
