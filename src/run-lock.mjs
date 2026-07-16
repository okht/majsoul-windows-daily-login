import { mkdir } from "node:fs/promises";
import path from "node:path";
import properLockfile from "proper-lockfile";

const STALE_MS = 720_000;
const UPDATE_MS = 60_000;

function runAlreadyActiveError() {
  const error = new Error("A daily run is already active.");
  error.code = "RUN_ALREADY_ACTIVE";
  return error;
}

export async function withRunLock(paths, fn, options = {}) {
  await mkdir(path.dirname(paths.lock), { recursive: true });

  let release;
  try {
    release = await properLockfile.lock(paths.lock, {
      realpath: false,
      lockfilePath: paths.lock,
      stale: STALE_MS,
      update: UPDATE_MS,
      retries: 0,
      ...(typeof options.onCompromised === "function"
        ? { onCompromised: options.onCompromised }
        : {})
    });
  } catch (error) {
    if (error?.code === "ELOCKED") throw runAlreadyActiveError();
    throw error;
  }

  try {
    return await fn();
  } finally {
    await release();
  }
}
