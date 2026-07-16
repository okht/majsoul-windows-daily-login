import { fork } from "node:child_process";
import { once } from "node:events";
import {
  access,
  mkdtemp,
  rm,
  stat,
  utimes
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withRunLock } from "../src/run-lock.mjs";

const workerPath = fileURLToPath(new URL("./fixtures/run-lock-worker.mjs", import.meta.url));
const staleMs = 720_000;
const roots = [];
const workers = [];
const windowsIt = process.platform === "win32" ? it : it.skip;

function withTimeout(promise, label, timeoutMs = 10_000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function temporaryLockPaths() {
  const root = await mkdtemp(path.join(os.tmpdir(), "majsoul-lock-"));
  roots.push(root);
  return {
    root,
    paths: { lock: path.join(root, "nested", "run.lock") }
  };
}

function startWorker(lockPath) {
  const child = fork(workerPath, [lockPath], {
    execPath: process.execPath,
    stdio: ["ignore", "ignore", "pipe", "ipc"]
  });
  const messages = [];
  const waiters = [];
  let stderr = "";

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.on("message", (message) => {
    const index = waiters.findIndex((waiter) => waiter.predicate(message));
    if (index === -1) {
      messages.push(message);
      return;
    }
    const [waiter] = waiters.splice(index, 1);
    waiter.resolve(message);
  });

  const controller = {
    child,
    stderr: () => stderr,
    waitFor(predicate, label) {
      const index = messages.findIndex(predicate);
      if (index !== -1) return Promise.resolve(messages.splice(index, 1)[0]);
      return withTimeout(new Promise((resolve) => {
        waiters.push({ predicate, resolve });
      }), label);
    }
  };
  workers.push(controller);
  return controller;
}

async function waitForExit(controller) {
  const { child } = controller;
  if (child.exitCode !== null || child.signalCode !== null) return;
  await withTimeout(once(child, "exit"), `worker ${child.pid} to exit`);
}

afterEach(async () => {
  for (const controller of workers.splice(0)) {
    if (controller.child.exitCode === null && controller.child.signalCode === null) {
      controller.child.kill("SIGKILL");
    }
    await waitForExit(controller);
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true
  })));
});

describe("withRunLock", () => {
  it("creates the lock parent and lets only the holder callback enter", async () => {
    const { paths } = await temporaryLockPaths();
    let releaseHolder;
    let markHolderEntered;
    const holderEntered = new Promise((resolve) => {
      markHolderEntered = resolve;
    });
    let holderEntries = 0;
    let contenderEntries = 0;
    const holder = withRunLock(paths, async () => {
      holderEntries += 1;
      markHolderEntered();
      await new Promise((resolve) => {
        releaseHolder = resolve;
      });
    });

    await holderEntered;
    try {
      await expect(withRunLock(paths, async () => {
        contenderEntries += 1;
      })).rejects.toMatchObject({ code: "RUN_ALREADY_ACTIVE" });
      expect(holderEntries).toBe(1);
      expect(contenderEntries).toBe(0);
      expect((await stat(path.dirname(paths.lock))).isDirectory()).toBe(true);
    } finally {
      releaseHolder();
      await holder;
    }
  });

  it("releases the lock when the callback throws", async () => {
    const { paths } = await temporaryLockPaths();
    const callbackError = new Error("synthetic callback failure");

    await expect(withRunLock(paths, async () => {
      throw callbackError;
    })).rejects.toBe(callbackError);

    await expect(withRunLock(paths, async () => "released"))
      .resolves.toBe("released");
  });

  windowsIt("normalizes a stale-cleanup transient when a fresh owner exists", async () => {
    const { paths } = await temporaryLockPaths();
    const transient = Object.assign(new Error("synthetic stale cleanup race"), {
      code: "EPERM"
    });
    const lock = vi.fn(async () => {
      throw transient;
    });
    const check = vi.fn(async () => true);
    const callback = vi.fn();

    await expect(withRunLock(paths, callback, { lock, check }))
      .rejects.toMatchObject({ code: "RUN_ALREADY_ACTIVE" });

    expect(callback).not.toHaveBeenCalled();
    expect(lock).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith(paths.lock, {
      realpath: false,
      lockfilePath: paths.lock,
      stale: staleMs
    });
  });

  windowsIt("retries acquisition after a transient when no lock exists", async () => {
    const { paths } = await temporaryLockPaths();
    const transient = Object.assign(new Error("synthetic stale cleanup race"), {
      code: "EBUSY"
    });
    const release = vi.fn(async () => {});
    const lock = vi.fn()
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce(release);
    const check = vi.fn(async () => false);

    await expect(withRunLock(paths, async () => "acquired", { lock, check }))
      .resolves.toBe("acquired");

    expect(lock).toHaveBeenCalledTimes(2);
    expect(lock).toHaveBeenNthCalledWith(1, paths.lock, {
      realpath: false,
      lockfilePath: paths.lock,
      stale: staleMs,
      update: 60_000,
      retries: 0
    });
    expect(check).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  windowsIt("rethrows a persistent permission fault when no lock exists", async () => {
    const { paths } = await temporaryLockPaths();
    const persistent = Object.assign(new Error("synthetic permission failure"), {
      code: "EACCES"
    });
    const lock = vi.fn(async () => {
      throw persistent;
    });
    const check = vi.fn(async () => false);
    const callback = vi.fn();

    await expect(withRunLock(paths, callback, { lock, check }))
      .rejects.toBe(persistent);

    expect(callback).not.toHaveBeenCalled();
    expect(lock).toHaveBeenCalledTimes(3);
    expect(check).toHaveBeenCalledTimes(3);
  });

  it("allows exactly one contender to take over a killed holder's stale lock", async () => {
    const { paths } = await temporaryLockPaths();
    const holder = startWorker(paths.lock);
    await holder.waitFor((message) => message.type === "ready", "holder readiness");
    holder.child.send({ type: "start" });
    await holder.waitFor((message) => message.type === "entered", "holder lock entry");

    expect(holder.child.kill("SIGKILL")).toBe(true);
    await waitForExit(holder);
    expect((await stat(paths.lock)).isDirectory()).toBe(true);

    const staleTime = new Date(Date.now() - staleMs - 60_000);
    await utimes(paths.lock, staleTime, staleTime);

    const contenders = [startWorker(paths.lock), startWorker(paths.lock)];
    await Promise.all(contenders.map((controller, index) => controller.waitFor(
      (message) => message.type === "ready",
      `contender ${index + 1} readiness`
    )));

    const entries = [];
    let markFirstEntry;
    const firstEntry = new Promise((resolve) => {
      markFirstEntry = resolve;
    });
    contenders.forEach((controller, index) => {
      controller.child.on("message", (message) => {
        if (message.type !== "entered") return;
        entries.push(index);
        markFirstEntry(index);
      });
    });

    for (const controller of contenders) controller.child.send({ type: "start" });
    const winnerIndex = await withTimeout(firstEntry, "one stale-lock contender to enter");
    const loserIndex = winnerIndex === 0 ? 1 : 0;
    const loserResult = await contenders[loserIndex].waitFor(
      (message) => message.type === "result",
      "the losing contender result"
    );

    expect(loserResult).toMatchObject({
      outcome: "error",
      code: "RUN_ALREADY_ACTIVE"
    });
    expect(entries).toEqual([winnerIndex]);

    contenders[winnerIndex].child.send({ type: "release" });
    expect(await contenders[winnerIndex].waitFor(
      (message) => message.type === "result",
      "the winning contender result"
    )).toMatchObject({ outcome: "completed" });
    await Promise.all(contenders.map(waitForExit));
    await expect(access(paths.lock)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
