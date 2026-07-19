import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm
} from "node:fs/promises";
import path from "node:path";

const SCHEMA = "majsoul-lobby-fingerprint/v1";
const RECORD_KEYS = ["enrollmentIdHex", "schema", "slots"];
const ENROLLMENT_ID = /^[0-9a-f]{32}$/;
const TOKEN = /^[0-9a-f]{64}$/;
const SLOT_COUNT = 216;
const TOKENS_PER_SLOT = 5;
const WINDOWS_RENAME_RETRY_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);
const WINDOWS_RENAME_ATTEMPTS = 5;

function invalidRecord() {
  const error = new Error("The lobby fingerprint record is invalid.");
  error.code = "FINGERPRINT_RECORD_INVALID";
  return error;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

async function renameAtomically(temporary, destination) {
  for (let attempt = 0; attempt < WINDOWS_RENAME_ATTEMPTS; attempt += 1) {
    try {
      await rename(temporary, destination);
      return;
    } catch (error) {
      if (
        process.platform !== "win32" ||
        !WINDOWS_RENAME_RETRY_CODES.has(error?.code) ||
        attempt + 1 === WINDOWS_RENAME_ATTEMPTS
      ) {
        throw error;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, (attempt + 1) * 5)
      );
    }
  }
}

export function validateFingerprintRecord(value) {
  if (!isPlainObject(value)) throw invalidRecord();

  const keys = Object.keys(value).sort();
  if (
    keys.length !== RECORD_KEYS.length ||
    keys.some((key, index) => key !== RECORD_KEYS[index])
  ) {
    throw invalidRecord();
  }
  if (value.schema !== SCHEMA) throw invalidRecord();
  if (!ENROLLMENT_ID.test(value.enrollmentIdHex)) throw invalidRecord();
  if (!Array.isArray(value.slots) || value.slots.length !== SLOT_COUNT) {
    throw invalidRecord();
  }

  for (const slot of value.slots) {
    if (!Array.isArray(slot) || slot.length !== TOKENS_PER_SLOT) {
      throw invalidRecord();
    }
    for (let index = 0; index < TOKENS_PER_SLOT; index += 1) {
      if (
        !Object.hasOwn(slot, index) ||
        typeof slot[index] !== "string" ||
        !TOKEN.test(slot[index])
      ) {
        throw invalidRecord();
      }
    }
    if (new Set(slot).size !== TOKENS_PER_SLOT) throw invalidRecord();
    for (let index = 1; index < slot.length; index += 1) {
      if (slot[index - 1] >= slot[index]) throw invalidRecord();
    }
  }

  return value;
}

export async function readFingerprintRecord(paths) {
  let serialized;
  try {
    serialized = await readFile(paths.fingerprint, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }

  let value;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw invalidRecord();
  }
  return validateFingerprintRecord(value);
}

export async function writeFingerprintRecord(paths, record) {
  validateFingerprintRecord(record);
  const serialized = JSON.stringify(record) + "\n";
  const directory = path.dirname(paths.fingerprint);
  const temporary = path.join(
    directory,
    "." + path.basename(paths.fingerprint) + "." + process.pid + "." +
      randomUUID() + ".tmp"
  );
  let handle;

  await mkdir(directory, { recursive: true });
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await renameAtomically(temporary, paths.fingerprint);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}
