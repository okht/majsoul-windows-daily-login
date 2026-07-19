import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureGmail,
  readMaskedSecret
} from "../src/cli/configure-gmail.mjs";

function makeTerminal(sequence) {
  const input = new EventEmitter();
  input.isTTY = true;
  input.setRawMode = vi.fn();
  input.resume = vi.fn();
  input.pause = vi.fn();
  input.setEncoding = vi.fn();

  const written = [];
  const output = {
    write: vi.fn((chunk) => {
      written.push(String(chunk));
      return true;
    })
  };

  queueMicrotask(() => {
    for (const chunk of sequence) {
      input.emit("data", chunk);
    }
  });

  return { input, output, written };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readMaskedSecret", () => {
  it("collects printable characters, supports backspace, and restores raw mode", async () => {
    const terminal = makeTerminal(["a", "b", "c", "\u007f", "d", "\r"]);

    const value = await readMaskedSecret("Gmail 应用专用密码：", {
      input: terminal.input,
      output: terminal.output
    });

    expect(value).toBe("abd");
    expect(terminal.input.setRawMode).toHaveBeenCalledWith(true);
    expect(terminal.input.setRawMode).toHaveBeenLastCalledWith(false);
    // Only the prompt and trailing newline are written — never the secret.
    expect(terminal.written.join("")).toBe("Gmail 应用专用密码：\n");
  });

  it("restores terminal mode when reading throws", async () => {
    const input = new EventEmitter();
    input.isTTY = true;
    input.setRawMode = vi.fn();
    input.resume = vi.fn();
    input.pause = vi.fn();
    input.setEncoding = vi.fn();
    const output = { write: vi.fn() };

    const pending = readMaskedSecret("secret:", { input, output });
    queueMicrotask(() => {
      input.emit("error", new Error("stream-failed"));
    });

    await expect(pending).rejects.toThrow("stream-failed");
    expect(input.setRawMode).toHaveBeenCalledWith(true);
    expect(input.setRawMode).toHaveBeenLastCalledWith(false);
  });

  it("restores terminal mode after Ctrl+C cancellation", async () => {
    const terminal = makeTerminal(["\u0003"]);

    await expect(
      readMaskedSecret("secret:", {
        input: terminal.input,
        output: terminal.output
      })
    ).rejects.toMatchObject({ code: "GMAIL_SECRET_CANCELLED" });

    expect(terminal.input.setRawMode).toHaveBeenLastCalledWith(false);
  });
});

describe("configureGmail", () => {
  it("stores only sender and recipient, saves the secret in keyring, and sends a test mail", async () => {
    const prompt = {
      question: vi
        .fn()
        .mockResolvedValueOnce("sender@example.com")
        .mockResolvedValueOnce("recipient@example.com"),
      close: vi.fn()
    };
    const store = {
      set: vi.fn(),
      get: vi.fn(),
      delete: vi.fn()
    };
    const mkdir = vi.fn(async () => {});
    const writeFile = vi.fn(async () => {});
    const sendFailureMail = vi.fn(async () => {});
    const readSecret = vi.fn(async () => "app-secret");
    const paths = {
      root: "C:\\fake\\MajSoulDaily",
      config: "C:\\fake\\MajSoulDaily\\config.json",
      logs: "C:\\fake\\MajSoulDaily\\logs"
    };

    await configureGmail({
      paths,
      createInterface: () => prompt,
      input: { terminal: "in" },
      output: { terminal: "out" },
      store,
      mkdir,
      writeFile,
      sendFailureMail,
      readMaskedSecret: readSecret,
      beijingClock: () => ({
        dateKey: "2026-07-16",
        iso: "2026-07-16T04:00:00.000Z",
        minuteOfDay: 720
      })
    });

    expect(prompt.question).toHaveBeenNthCalledWith(1, "Gmail 发件地址：");
    expect(prompt.question).toHaveBeenNthCalledWith(2, "失败通知收件地址：");
    expect(readSecret).toHaveBeenCalledWith("Gmail 应用专用密码：", {
      input: { terminal: "in" },
      output: { terminal: "out" }
    });
    expect(store.set).toHaveBeenCalledWith("sender@example.com", "app-secret");
    expect(mkdir).toHaveBeenCalledWith(paths.root, { recursive: true });
    expect(writeFile).toHaveBeenCalledWith(
      paths.config,
      JSON.stringify(
        { sender: "sender@example.com", recipient: "recipient@example.com" },
        null,
        2
      ) + "\n",
      "utf8"
    );
    const written = writeFile.mock.calls[0][1];
    expect(written).not.toContain("app-secret");
    expect(sendFailureMail).toHaveBeenCalledWith(
      {
        sender: "sender@example.com",
        recipient: "recipient@example.com"
      },
      {
        dateKey: "2026-07-16",
        time: "2026-07-16T04:00:00.000Z",
        kind: "CONFIG_TEST",
        phase: "gmail-setup",
        attempts: 1,
        action: "无需操作",
        logPath: paths.logs
      },
      { store }
    );
    expect(prompt.close).toHaveBeenCalledOnce();
  });

  it("closes the prompt when address entry fails", async () => {
    const prompt = {
      question: vi.fn(async () => {
        throw new Error("prompt-failed");
      }),
      close: vi.fn()
    };

    await expect(
      configureGmail({
        createInterface: () => prompt,
        store: { set: vi.fn() },
        mkdir: vi.fn(),
        writeFile: vi.fn(),
        sendFailureMail: vi.fn(),
        readMaskedSecret: vi.fn()
      })
    ).rejects.toThrow("prompt-failed");

    expect(prompt.close).toHaveBeenCalledOnce();
  });
});
