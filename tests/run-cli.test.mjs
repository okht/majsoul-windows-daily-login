import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { main } from "../src/cli/run.mjs";

describe("run CLI", () => {
  it("rejects missing trigger with exit 64", async () => {
    await expect(main([])).resolves.toBe(64);
  });

  it("maps SUCCESS to exit 0 and prunes logs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "majsoul-run-cli-"));
    const paths = {
      root,
      logs: path.join(root, "logs"),
      state: path.join(root, "state"),
      lock: path.join(root, "run.lock"),
      profile: path.join(root, "profile"),
      config: path.join(root, "config.json"),
      fingerprint: path.join(root, "fp.json")
    };
    await mkdir(paths.logs, { recursive: true });

    const code = await main(["--trigger", "primary"], {
      paths,
      clock: () => ({
        dateKey: "2026-07-16",
        minuteOfDay: 800,
        iso: "2026-07-16T04:30:00.000Z"
      }),
      targetUrl: "https://game.maj-soul.com/1/",
      logPath: paths.logs,
      readState: vi.fn(async () => null),
      writeState: vi.fn(async () => {}),
      isSessionUnlocked: vi.fn(async () => true),
      canReachTarget: vi.fn(async () => true),
      decideRun: vi.fn(() => ({ action: "RUN" })),
      withRunLock: async (callback) => callback(),
      createSession: () => ({
        open: vi.fn(async () => {}),
        close: vi.fn(async () => {})
      }),
      detectLobby: vi.fn(async () => ({ status: "SUCCESS" })),
      notifyOnce: vi.fn(async () => {}),
      log: vi.fn(async () => {})
    });

    expect(code).toBe(0);
  });
});
