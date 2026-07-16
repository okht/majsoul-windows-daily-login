import { describe, expect, it, vi } from "vitest";
import { isSessionUnlocked } from "../src/session-guard.mjs";

describe("isSessionUnlocked", () => {
  it("uses an injected hidden noninteractive PowerShell process", async () => {
    const execFile = vi.fn(async () => ({ stdout: "UNLOCKED\r\n" }));

    await expect(isSessionUnlocked(execFile)).resolves.toBe(true);
    expect(execFile).toHaveBeenCalledTimes(1);

    const [executable, args, options] = execFile.mock.calls[0];
    expect(executable).toBe("powershell.exe");
    expect(args).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      expect.stringContaining("LogonUI")
    ]);
    expect(options).toMatchObject({
      windowsHide: true,
      timeout: 5000
    });
  });

  it("returns false when PowerShell reports a locked session", async () => {
    const execFile = vi.fn(async () => ({ stdout: "LOCKED\r\n" }));

    await expect(isSessionUnlocked(execFile)).resolves.toBe(false);
  });

  it.each(["", "UNKNOWN", "unlocked", "UNLOCKED extra", null, undefined])(
    "fails closed for unrecognized output %s",
    async (stdout) => {
      const execFile = vi.fn(async () => ({ stdout }));

      await expect(isSessionUnlocked(execFile)).resolves.toBe(false);
    }
  );

  it("fails closed when the process rejects", async () => {
    const execFile = vi.fn(async () => {
      throw Object.assign(new Error("synthetic process failure"), { code: "ENOENT" });
    });

    await expect(isSessionUnlocked(execFile)).resolves.toBe(false);
  });

  it("fails closed when the process times out", async () => {
    const execFile = vi.fn(async () => {
      throw Object.assign(new Error("synthetic timeout"), { code: "ETIMEDOUT" });
    });

    await expect(isSessionUnlocked(execFile)).resolves.toBe(false);
  });

  it("fails closed when the injected adapter throws synchronously", async () => {
    const execFile = vi.fn(() => {
      throw new Error("synthetic synchronous failure");
    });

    await expect(isSessionUnlocked(execFile)).resolves.toBe(false);
  });
});
