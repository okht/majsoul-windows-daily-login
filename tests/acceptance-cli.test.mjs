import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runAcceptance } from "../src/cli/acceptance.mjs";

describe("runAcceptance", () => {
  it("fails closed when lobby confirmation is declined", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "majsoul-accept-"));
    const result = await runAcceptance({
      paths: { root, logs: path.join(root, "logs") },
      packageJsonPath: path.join(process.cwd(), "package.json"),
      skipVerify: true,
      skipGmail: true,
      interactive: true,
      confirm: async () => false,
      runDryRun: async () => ({
        code: 0,
        stdout: "DryRun complete: no scheduled task was registered.\n",
        stderr: ""
      }),
      listScheduledTasks: async () => [],
      log: async () => {}
    });
    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.checks.interactiveRealLobby).toBe(false);
    expect(result.receiptPath).toBeNull();
  });

  it("writes a local receipt without Gmail when gates pass", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "majsoul-accept-"));
    const writeReceipt = vi.fn(async (receipt, paths) => {
      return path.join(paths.root, "acceptance-receipt.json");
    });
    const result = await runAcceptance({
      paths: { root, logs: path.join(root, "logs") },
      packageJsonPath: path.join(process.cwd(), "package.json"),
      skipVerify: true,
      skipGmail: true,
      interactive: true,
      confirm: async () => true,
      runDryRun: async () => ({
        code: 0,
        stdout: "no scheduled task was registered",
        stderr: ""
      }),
      listScheduledTasks: async () => [],
      writeReceipt,
      log: async () => {}
    });
    expect(result.passed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(writeReceipt).toHaveBeenCalledOnce();
    expect(result.receipt.checks).toMatchObject({
      verify: true,
      privacy: true,
      noInput: true,
      dryRun: true,
      noTasksRegistered: true,
      interactiveRealLobby: true,
      interactiveGmail: false
    });
  });

  it("fails when scheduled tasks already exist", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "majsoul-accept-"));
    const result = await runAcceptance({
      paths: { root, logs: path.join(root, "logs") },
      packageJsonPath: path.join(process.cwd(), "package.json"),
      skipVerify: true,
      skipGmail: true,
      interactive: false,
      forceInteractivePass: true,
      runDryRun: async () => ({
        code: 0,
        stdout: "no scheduled task was registered",
        stderr: ""
      }),
      listScheduledTasks: async () => ["MajSoulDaily-Primary"],
      log: async () => {}
    });
    expect(result.passed).toBe(false);
    expect(result.checks.noTasksRegistered).toBe(false);
  });
});
