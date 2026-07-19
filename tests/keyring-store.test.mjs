import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { keyringStore } from "../src/keyring-store.mjs";
import {
  deleteFingerprintKey,
  withFingerprintTokenizer
} from "../src/browser/fingerprint-key.mjs";

function fakeEntryType(initial = new Map()) {
  const values = new Map(initial);
  const calls = [];

  class Entry {
    constructor(service, account) {
      this.service = service;
      this.account = account;
      calls.push({ operation: "construct", service, account });
    }

    getPassword() {
      calls.push({
        operation: "get",
        service: this.service,
        account: this.account
      });
      return values.get(this.service + "\0" + this.account) ?? null;
    }

    setPassword(value) {
      calls.push({
        operation: "set",
        service: this.service,
        account: this.account
      });
      values.set(this.service + "\0" + this.account, value);
    }

    deletePassword() {
      calls.push({
        operation: "delete",
        service: this.service,
        account: this.account
      });
      return values.delete(this.service + "\0" + this.account);
    }
  }

  return { Entry, calls, values };
}

function storedValue(fake) {
  return [...fake.values.values()][0];
}

function consoleSpies() {
  return ["log", "info", "warn", "error"].map((method) =>
    vi.spyOn(console, method).mockImplementation(() => {})
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("keyringStore", () => {
  it("keeps service and account namespaces isolated", () => {
    const fake = fakeEntryType();
    const store = keyringStore(fake.Entry);

    store.set("MajSoulDaily.Fingerprint", "lobby", "fingerprint-secret");
    store.set("MajSoulDaily.Gmail", "sender", "gmail-secret");

    expect(store.get("MajSoulDaily.Fingerprint", "lobby")).toBe(
      "fingerprint-secret"
    );
    expect(store.get("MajSoulDaily.Gmail", "sender")).toBe("gmail-secret");
    expect(store.get("MajSoulDaily.Fingerprint", "sender")).toBeNull();

    expect(store.delete("MajSoulDaily.Fingerprint", "lobby")).toBe(true);
    expect(store.get("MajSoulDaily.Fingerprint", "lobby")).toBeNull();
    expect(store.get("MajSoulDaily.Gmail", "sender")).toBe("gmail-secret");
  });
});

describe("withFingerprintTokenizer", () => {
  it("generates exactly 32 bytes on first use and exposes only a tokenizer", async () => {
    const fake = fakeEntryType();
    const generated = Buffer.alloc(32, 0x2a);
    const expectedStored = generated.toString("base64url");
    const randomBytes = vi.fn((length) => {
      expect(length).toBe(32);
      return generated;
    });

    const result = await withFingerprintTokenizer(
      (...argumentsReceived) => {
        expect(argumentsReceived).toHaveLength(1);
        expect(typeof argumentsReceived[0]).toBe("function");
        return argumentsReceived[0]("frame-category");
      },
      { EntryType: fake.Entry, randomBytes }
    );

    expect(randomBytes).toHaveBeenCalledTimes(1);
    expect(storedValue(fake)).toBe(expectedStored);
    expect(Buffer.from(storedValue(fake), "base64url")).toHaveLength(32);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
    expect(generated.equals(Buffer.alloc(32))).toBe(true);

    const constructed = fake.calls.filter(
      ({ operation }) => operation === "construct"
    );
    expect(constructed).toHaveLength(2);
    expect(new Set(constructed.map(({ service }) => service))).toHaveLength(1);
    expect(new Set(constructed.map(({ account }) => account))).toHaveLength(1);
    expect(constructed[0].service).not.toMatch(/gmail/i);
    expect(constructed[0].account).toBeTruthy();
  });

  it("reuses a valid stored key without generating a replacement", async () => {
    const key = Buffer.alloc(32, 0x17);
    const fake = fakeEntryType(
      new Map([
        [
          "MajSoulDaily.Fingerprint\0lobby-fingerprint-key",
          key.toString("base64url")
        ]
      ])
    );
    const randomBytes = vi.fn(() => {
      throw new Error("must not generate");
    });

    const first = await withFingerprintTokenizer(
      (token) => token("same-message"),
      { EntryType: fake.Entry, randomBytes }
    );
    const second = await withFingerprintTokenizer(
      (token) => token("same-message"),
      { EntryType: fake.Entry, randomBytes }
    );

    expect(first).toBe(second);
    expect(randomBytes).not.toHaveBeenCalled();
    expect(storedValue(fake)).toBe(key.toString("base64url"));
  });

  it("fails closed with a bounded error for a malformed stored key", async () => {
    const invalid = "secret-payload-that-must-not-escape";
    const fake = fakeEntryType(
      new Map([
        ["MajSoulDaily.Fingerprint\0lobby-fingerprint-key", invalid]
      ])
    );
    const spies = consoleSpies();
    let caught;

    try {
      await withFingerprintTokenizer(
        () => {
          throw new Error("callback must not run");
        },
        { EntryType: fake.Entry }
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ code: "FINGERPRINT_KEY_INVALID" });
    expect(caught.message).not.toContain(invalid);
    expect(spies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
  });

  it("invalidates an escaped tokenizer after callback cleanup", async () => {
    const key = Buffer.alloc(32, 0x45);
    const fake = fakeEntryType(
      new Map([
        [
          "MajSoulDaily.Fingerprint\0lobby-fingerprint-key",
          key.toString("base64url")
        ]
      ])
    );
    let escapedToken;
    const expectedBeforeCleanup = createHmac("sha256", key)
      .update("category", "utf8")
      .digest("hex");

    const digest = await withFingerprintTokenizer(
      (token) => {
        escapedToken = token;
        return token("category");
      },
      { EntryType: fake.Entry }
    );

    expect(digest).toBe(expectedBeforeCleanup);
    let escapedError;
    try {
      escapedToken("category");
    } catch (error) {
      escapedError = error;
    }
    expect(escapedError).toMatchObject({
      code: "FINGERPRINT_TOKEN_SCOPE_CLOSED"
    });
  });

  it("zeroes the generated key and does not log when the callback throws", async () => {
    const fake = fakeEntryType();
    const generated = Buffer.alloc(32, 0x63);
    const spies = consoleSpies();

    await expect(
      withFingerprintTokenizer(
        (token) => {
          expect(token("category")).toMatch(/^[0-9a-f]{64}$/);
          throw new Error("callback-failure");
        },
        {
          EntryType: fake.Entry,
          randomBytes: () => generated
        }
      )
    ).rejects.toThrow("callback-failure");

    expect(generated.equals(Buffer.alloc(32))).toBe(true);
    expect(spies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
  });

  it("zeroes the generated key when Credential Manager persistence throws", async () => {
    const generated = Buffer.alloc(32, 0x72);
    const store = {
      get: () => null,
      set: () => {
        throw new Error("credential-write-failure");
      },
      delete: vi.fn()
    };

    await expect(
      withFingerprintTokenizer(
        () => {
          throw new Error("callback must not run");
        },
        {
          store,
          randomBytes: () => generated
        }
      )
    ).rejects.toThrow("credential-write-failure");

    expect(generated.equals(Buffer.alloc(32))).toBe(true);
  });
});

describe("deleteFingerprintKey", () => {
  it("deletes only the fixed fingerprint credential", () => {
    const fake = fakeEntryType();
    const store = keyringStore(fake.Entry);
    store.set(
      "MajSoulDaily.Fingerprint",
      "lobby-fingerprint-key",
      Buffer.alloc(32, 0x08).toString("base64url")
    );
    store.set("MajSoulDaily.Gmail", "sender", "gmail-secret");

    expect(deleteFingerprintKey({ EntryType: fake.Entry })).toBeUndefined();

    expect(
      store.get("MajSoulDaily.Fingerprint", "lobby-fingerprint-key")
    ).toBeNull();
    expect(store.get("MajSoulDaily.Gmail", "sender")).toBe("gmail-secret");
  });
});
