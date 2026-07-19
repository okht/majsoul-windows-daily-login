import { afterEach, describe, expect, it, vi } from "vitest";
import { credentialStore } from "../src/credentials.mjs";

function fakeEntryType(initial = new Map()) {
  const values = new Map(initial);
  const calls = [];

  class Entry {
    constructor(service, account) {
      this.service = service;
      this.account = account;
      calls.push(["construct", service, account]);
    }

    getPassword() {
      calls.push(["get", this.service, this.account]);
      return values.get(this.service + "\0" + this.account) ?? null;
    }

    setPassword(value) {
      calls.push(["set", this.service, this.account, value]);
      values.set(this.service + "\0" + this.account, value);
    }

    deletePassword() {
      calls.push(["delete", this.service, this.account]);
      return values.delete(this.service + "\0" + this.account);
    }
  }

  return { Entry, calls, values };
}

function consoleSpies() {
  return ["log", "info", "warn", "error"].map((method) =>
    vi.spyOn(console, method).mockImplementation(() => {})
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("credentialStore", () => {
  it("uses the fixed Gmail service and supplied account", () => {
    const fake = fakeEntryType();
    const store = credentialStore(fake.Entry);

    store.set("person@example.com", "app-secret");
    expect(store.get("person@example.com")).toBe("app-secret");
    store.delete("person@example.com");

    expect(fake.calls[0]).toEqual([
      "construct",
      "MajSoulDaily.Gmail",
      "person@example.com"
    ]);
    expect(store.get("person@example.com")).toBeNull();
  });

  it("keeps the Gmail service separate from fingerprint credentials", () => {
    const fake = fakeEntryType(
      new Map([
        [
          "MajSoulDaily.Fingerprint\0lobby-fingerprint-key",
          "fingerprint-secret"
        ]
      ])
    );
    const store = credentialStore(fake.Entry);

    store.set("sender@example.com", "gmail-secret");

    expect(store.get("sender@example.com")).toBe("gmail-secret");
    expect(
      fake.values.get("MajSoulDaily.Fingerprint\0lobby-fingerprint-key")
    ).toBe("fingerprint-secret");
    expect(
      fake.values.get("MajSoulDaily.Gmail\0sender@example.com")
    ).toBe("gmail-secret");
  });

  it("never prints the app password on console channels", () => {
    const spies = consoleSpies();
    const fake = fakeEntryType();
    const store = credentialStore(fake.Entry);

    store.set("person@example.com", "app-secret");
    const secret = store.get("person@example.com");
    store.delete("person@example.com");

    expect(secret).toBe("app-secret");
    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain("app-secret");
    }
  });
});
