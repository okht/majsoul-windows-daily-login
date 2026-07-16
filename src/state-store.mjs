import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm
} from "node:fs/promises";
import path from "node:path";

export const DAILY_STATUSES = Object.freeze([
  "PENDING_DUE",
  "RUNNING",
  "SUCCESS",
  "FAILED_TRANSIENT",
  "BLOCKED_MANUAL"
]);

const pendingWrites = new Map();

function invalidDateKey() {
  const error = new TypeError("dateKey must be a valid YYYY-MM-DD calendar date.");
  error.code = "INVALID_DATE_KEY";
  return error;
}

function assertDateKey(dateKey) {
  if (typeof dateKey !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    throw invalidDateKey();
  }

  const parsed = new Date(`${dateKey}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== dateKey) {
    throw invalidDateKey();
  }
}

function stateFile(dateKey, paths) {
  assertDateKey(dateKey);
  return path.join(paths.state, `${dateKey}.json`);
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function definedEntries(record) {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined)
  );
}

function invalidStatePatch() {
  const error = new TypeError("notification patch must be a record when provided.");
  error.code = "INVALID_STATE_PATCH";
  return error;
}

function mergeState(existing, update) {
  const patch = definedEntries(update);

  if (Object.hasOwn(patch, "notification")) {
    if (!isRecord(patch.notification)) throw invalidStatePatch();
    patch.notification = {
      ...(isRecord(existing.notification) ? existing.notification : {}),
      ...definedEntries(patch.notification)
    };
  }

  return { ...existing, ...patch };
}

async function quarantineCorruptState(file) {
  const quarantine = `${file}.corrupt-${randomUUID()}`;
  try {
    await rename(file, quarantine);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function readState(dateKey, paths) {
  const file = stateFile(dateKey, paths);
  let serialized;

  try {
    serialized = await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }

  try {
    return JSON.parse(serialized);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    await quarantineCorruptState(file);
    return null;
  }
}

async function writeStateOnce(dateKey, state, paths, file) {
  await mkdir(paths.state, { recursive: true });

  const existing = await readState(dateKey, paths) ?? {};
  const value = {
    ...mergeState(existing, state),
    dateKey,
    updatedAt: new Date().toISOString()
  };
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = path.join(
    paths.state,
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`
  );
  let handle;

  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, file);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function writeState(dateKey, state, paths) {
  const file = stateFile(dateKey, paths);
  const previous = pendingWrites.get(file) ?? Promise.resolve();
  const operation = previous
    .catch(() => {})
    .then(() => writeStateOnce(dateKey, state, paths, file));
  pendingWrites.set(file, operation);

  try {
    await operation;
  } finally {
    if (pendingWrites.get(file) === operation) pendingWrites.delete(file);
  }
}

export async function clearBlockedState(dateKey, paths) {
  const state = await readState(dateKey, paths);
  if (state?.status !== "BLOCKED_MANUAL") return;

  await writeState(dateKey, {
    status: "FAILED_TRANSIENT",
    repairedAt: new Date().toISOString()
  }, paths);
}
