import { createHmac, randomBytes as nodeRandomBytes } from "node:crypto";
import { keyringStore } from "../keyring-store.mjs";

const SERVICE = "MajSoulDaily.Fingerprint";
const ACCOUNT = "lobby-fingerprint-key";
const KEY_BYTES = 32;
const BASE64URL_KEY = /^[A-Za-z0-9_-]{43}$/;

function invalidKey() {
  const error = new Error("The lobby fingerprint key is invalid.");
  error.code = "FINGERPRINT_KEY_INVALID";
  return error;
}

function closedTokenizer() {
  const error = new Error("The fingerprint tokenizer scope is closed.");
  error.code = "FINGERPRINT_TOKEN_SCOPE_CLOSED";
  return error;
}

function decodeStoredKey(value) {
  if (typeof value !== "string" || !BASE64URL_KEY.test(value)) {
    throw invalidKey();
  }

  const key = Buffer.from(value, "base64url");
  if (
    key.length !== KEY_BYTES ||
    key.toString("base64url") !== value
  ) {
    key.fill(0);
    throw invalidKey();
  }
  return key;
}

export async function withFingerprintTokenizer(callback, dependencies = {}) {
  const store =
    dependencies.store ?? keyringStore(dependencies.EntryType);
  const randomBytes = dependencies.randomBytes ?? nodeRandomBytes;
  let key;
  let active = true;

  try {
    const stored = store.get(SERVICE, ACCOUNT);
    if (stored === null || stored === undefined) {
      key = randomBytes(KEY_BYTES);
      if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
        if (Buffer.isBuffer(key)) key.fill(0);
        throw invalidKey();
      }
      store.set(SERVICE, ACCOUNT, key.toString("base64url"));
    } else {
      key = decodeStoredKey(stored);
    }

    const token = (message) => {
      if (!active) throw closedTokenizer();
      if (typeof message !== "string") {
        const error = new Error("Fingerprint token input is invalid.");
        error.code = "FINGERPRINT_TOKEN_INPUT_INVALID";
        throw error;
      }
      return createHmac("sha256", key)
        .update(message, "utf8")
        .digest("hex");
    };

    return await callback(token);
  } finally {
    active = false;
    if (key) key.fill(0);
  }
}

export function deleteFingerprintKey(dependencies = {}) {
  const store =
    dependencies.store ?? keyringStore(dependencies.EntryType);
  store.delete(SERVICE, ACCOUNT);
}
