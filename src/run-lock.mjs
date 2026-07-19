import { mkdir } from "node:fs/promises";
import path from "node:path";
import properLockfile from "proper-lockfile";

const STALE_MS = 720_000;
const UPDATE_MS = 60_000;
const MAX_ACQUIRE_ATTEMPTS = 3;
const WINDOWS_STALE_CLEANUP_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

function runAlreadyActiveError() {
  const error = new Error("A daily run is already active.");
  error.code = "RUN_ALREADY_ACTIVE";
  return error;
}

function lockOptions(paths, onCompromised) {
  return {
    realpath: false,
    lockfilePath: paths.lock,
    stale: STALE_MS,
    update: UPDATE_MS,
    retries: 0,
    ...(typeof onCompromised === "function" ? { onCompromised } : {})
  };
}

function checkOptions(paths) {
  return {
    realpath: false,
    lockfilePath: paths.lock,
    stale: STALE_MS
  };
}

async function acquire(paths, options) {
  const lock = options.lock ?? properLockfile.lock;
  const check = options.check ?? properLockfile.check;
  let originalTransient;

  for (let attempt = 1; attempt <= MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
    try {
      return await lock(paths.lock, lockOptions(paths, options.onCompromised));
    } catch (error) {
      if (error?.code === "ELOCKED") throw runAlreadyActiveError();

      const isWindowsStaleCleanupRace = process.platform === "win32"
        && WINDOWS_STALE_CLEANUP_CODES.has(error?.code);
      if (!isWindowsStaleCleanupRace) throw error;

      originalTransient ??= error;
      let active;
      try {
        active = await check(paths.lock, checkOptions(paths));
      } catch {
        throw originalTransient;
      }

      if (active) throw runAlreadyActiveError();
      if (attempt === MAX_ACQUIRE_ATTEMPTS) throw originalTransient;
    }
  }

  throw originalTransient;
}

export async function withRunLock(paths, fn, options = {}) {
  await mkdir(path.dirname(paths.lock), { recursive: true });

  const release = await acquire(paths, options);

  try {
    return await fn();
  } finally {
    await release();
  }
}
