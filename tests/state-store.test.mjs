import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearBlockedState,
  readState,
  writeState
} from "../src/state-store.mjs";

const roots = [];

async function temporaryPaths() {
  const root = await mkdtemp(path.join(os.tmpdir(), "majsoul-state-"));
  roots.push(root);
  return {
    root,
    paths: { state: path.join(root, "state") }
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true
  })));
});

describe("state-store", () => {
  it("round-trips one Beijing date", async () => {
    const { paths } = await temporaryPaths();

    await writeState("2026-07-16", { status: "SUCCESS" }, paths);

    const stored = await readState("2026-07-16", paths);
    expect(stored).toMatchObject({
      dateKey: "2026-07-16",
      status: "SUCCESS"
    });
    expect(new Date(stored.updatedAt).toISOString()).toBe(stored.updatedAt);
  });

  it.each([
    "2026-7-16",
    "2026-02-30",
    "../2026-07-16",
    "2026-07-16/extra"
  ])("rejects invalid date key %s before resolving a state path", async (dateKey) => {
    const { paths } = await temporaryPaths();

    await expect(readState(dateKey, paths)).rejects.toMatchObject({
      code: "INVALID_DATE_KEY"
    });
    await expect(writeState(dateKey, { status: "RUNNING" }, paths)).rejects.toMatchObject({
      code: "INVALID_DATE_KEY"
    });
    await expect(clearBlockedState(dateKey, paths)).rejects.toMatchObject({
      code: "INVALID_DATE_KEY"
    });
  });

  it("atomically replaces the destination with the temporary file identity", async () => {
    const { paths } = await temporaryPaths();
    const dateKey = "2026-07-16";
    const file = path.join(paths.state, `${dateKey}.json`);

    await writeState(dateKey, { status: "RUNNING", attempt: 1 }, paths);
    const originalIdentity = (await stat(file, { bigint: true })).ino;

    await writeState(dateKey, { status: "SUCCESS", attempt: 2 }, paths);

    const replacementIdentity = (await stat(file, { bigint: true })).ino;
    expect(replacementIdentity).not.toBe(originalIdentity);
    expect(await readState(dateKey, paths)).toMatchObject({
      status: "SUCCESS",
      attempt: 2
    });
  });

  it("uses unique same-directory temporary files for concurrent replacements", async () => {
    const { paths } = await temporaryPaths();
    const dateKey = "2026-07-16";

    await writeState(dateKey, { status: "RUNNING", writer: -1 }, paths);
    await Promise.all(Array.from({ length: 12 }, (_, writer) => writeState(
      dateKey,
      { status: "RUNNING", writer },
      paths
    )));

    const stored = await readState(dateKey, paths);
    expect(stored.writer).toBeGreaterThanOrEqual(0);
    expect(stored.writer).toBeLessThan(12);
    expect(await readdir(paths.state)).toEqual([`${dateKey}.json`]);
  });

  it("merges preserved fields and partial notification updates", async () => {
    const { paths } = await temporaryPaths();
    const dateKey = "2026-07-16";

    await writeState(dateKey, {
      status: "FAILED_TRANSIENT",
      runtimeVersion: "0.1.0",
      notification: {
        fingerprint: "fixed-test-fingerprint",
        status: "PENDING",
        attempts: 1,
        lastAttemptAt: "2026-07-16T02:00:00.000Z"
      }
    }, paths);

    await writeState(dateKey, {
      status: "BLOCKED_MANUAL",
      notification: {
        status: "SENT",
        sentAt: "2026-07-16T02:01:00.000Z"
      }
    }, paths);

    expect(await readState(dateKey, paths)).toMatchObject({
      status: "BLOCKED_MANUAL",
      runtimeVersion: "0.1.0",
      notification: {
        fingerprint: "fixed-test-fingerprint",
        status: "SENT",
        attempts: 1,
        lastAttemptAt: "2026-07-16T02:00:00.000Z",
        sentAt: "2026-07-16T02:01:00.000Z"
      }
    });
  });

  it("quarantines invalid JSON without exposing its contents", async () => {
    const { paths } = await temporaryPaths();
    const dateKey = "2026-07-16";
    const file = path.join(paths.state, `${dateKey}.json`);
    const corruptValue = "{synthetic-corrupt-marker";
    const spies = ["log", "warn", "error"].map((method) => vi
      .spyOn(console, method)
      .mockImplementation(() => {}));

    try {
      await writeState(dateKey, { status: "RUNNING" }, paths);
      await writeFile(file, corruptValue, "utf8");

      expect(await readState(dateKey, paths)).toBeNull();

      const entries = await readdir(paths.state);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatch(/^2026-07-16\.json\.corrupt-[a-zA-Z0-9-]+$/);
      expect(await readFile(path.join(paths.state, entries[0]), "utf8")).toBe(corruptValue);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("clears a blocked state while preserving notification and runtime fields", async () => {
    const { paths } = await temporaryPaths();
    const dateKey = "2026-07-16";

    await writeState(dateKey, {
      status: "BLOCKED_MANUAL",
      runtimeVersion: "0.1.0",
      notification: {
        fingerprint: "repair-test-fingerprint",
        status: "PENDING",
        attempts: 1
      }
    }, paths);

    await clearBlockedState(dateKey, paths);

    const repaired = await readState(dateKey, paths);
    expect(repaired).toMatchObject({
      status: "FAILED_TRANSIENT",
      runtimeVersion: "0.1.0",
      notification: {
        fingerprint: "repair-test-fingerprint",
        status: "PENDING",
        attempts: 1
      }
    });
    expect(new Date(repaired.repairedAt).toISOString()).toBe(repaired.repairedAt);
  });

  it("leaves a non-blocked state unchanged during repair", async () => {
    const { root, paths } = await temporaryPaths();
    const dateKey = "2026-07-16";

    await writeState(dateKey, { status: "SUCCESS" }, paths);
    const before = await readState(dateKey, paths);
    await clearBlockedState(dateKey, paths);
    expect(await readState(dateKey, paths)).toEqual(before);

    const movedState = path.join(root, "moved-state");
    await rename(paths.state, movedState);
    expect(JSON.parse(await readFile(path.join(movedState, `${dateKey}.json`), "utf8")))
      .toEqual(before);
  });
});
