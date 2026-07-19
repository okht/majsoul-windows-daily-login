import { createHash } from "node:crypto";
import {
  link,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readFingerprintRecord,
  validateFingerprintRecord,
  writeFingerprintRecord
} from "../src/browser/fingerprint-store.mjs";

const temporaryRoots = [];

function tokenFor(seed, slot, variant) {
  return createHash("sha256")
    .update(seed + ":" + slot + ":" + variant)
    .digest("hex");
}

function validRecord(seed = "record") {
  return {
    schema: "majsoul-lobby-fingerprint/v1",
    enrollmentIdHex: createHash("sha256")
      .update(seed)
      .digest("hex")
      .slice(0, 32),
    slots: Array.from({ length: 216 }, (_, slot) =>
      Array.from({ length: 5 }, (_unused, variant) =>
        tokenFor(seed, slot, variant)
      ).sort()
    )
  };
}

async function temporaryPaths() {
  const root = await mkdtemp(path.join(os.tmpdir(), "majsoul-fingerprint-"));
  temporaryRoots.push(root);
  return {
    root,
    paths: { fingerprint: path.join(root, "lobby-fingerprint.json") }
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { force: true, recursive: true })
    )
  );
});

describe("validateFingerprintRecord", () => {
  it("accepts and returns the exact v1 HMAC-only record", () => {
    const record = validRecord();
    expect(validateFingerprintRecord(record)).toEqual(record);
  });

  it.each([
    [
      "an extra top-level key",
      (record) => {
        record.width = 192;
      }
    ],
    [
      "the wrong schema",
      (record) => {
        record.schema = "majsoul-lobby-fingerprint/v2";
      }
    ],
    [
      "a malformed enrollment ID",
      (record) => {
        record.enrollmentIdHex = "A".repeat(32);
      }
    ],
    [
      "the wrong slot count",
      (record) => {
        record.slots.pop();
      }
    ],
    [
      "the wrong token count",
      (record) => {
        record.slots[0].pop();
      }
    ],
    [
      "a duplicate token",
      (record) => {
        record.slots[0][1] = record.slots[0][0];
      }
    ],
    [
      "a sparse token slot",
      (record) => {
        delete record.slots[0][2];
      }
    ],
    [
      "an unsorted token slot",
      (record) => {
        record.slots[0].reverse();
      }
    ],
    [
      "a non-hex token",
      (record) => {
        record.slots[0][0] = "z".repeat(64);
      }
    ],
    [
      "a token of the wrong length",
      (record) => {
        record.slots[0][0] = "a".repeat(63);
      }
    ]
  ])("rejects %s", (_label, mutate) => {
    const record = validRecord();
    mutate(record);

    expect(() => validateFingerprintRecord(record)).toThrow(
      expect.objectContaining({ code: "FINGERPRINT_RECORD_INVALID" })
    );
  });
});

describe("fingerprint record persistence", () => {
  it("returns null when no fingerprint has been enrolled", async () => {
    const { paths } = await temporaryPaths();
    await expect(readFingerprintRecord(paths)).resolves.toBeNull();
  });

  it("round-trips a strict record and leaves no temporary files", async () => {
    const { root, paths } = await temporaryPaths();
    const record = validRecord();

    await writeFingerprintRecord(paths, record);

    await expect(readFingerprintRecord(paths)).resolves.toEqual(record);
    expect(await readdir(root)).toEqual(["lobby-fingerprint.json"]);
  });

  it("atomically replaces file identity instead of rewriting it in place", async () => {
    const { root, paths } = await temporaryPaths();
    const first = validRecord("first");
    const second = validRecord("second");
    const snapshot = path.join(root, "first-hard-link.json");

    await writeFingerprintRecord(paths, first);
    await link(paths.fingerprint, snapshot);
    await writeFingerprintRecord(paths, second);

    expect(JSON.parse(await readFile(snapshot, "utf8"))).toEqual(first);
    await expect(readFingerprintRecord(paths)).resolves.toEqual(second);

    await rm(snapshot);
    expect(await readdir(root)).toEqual(["lobby-fingerprint.json"]);
  });

  it("uses unique same-directory temporaries for concurrent replacements", async () => {
    const { root, paths } = await temporaryPaths();
    const first = validRecord("concurrent-first");
    const second = validRecord("concurrent-second");

    await Promise.all([
      writeFingerprintRecord(paths, first),
      writeFingerprintRecord(paths, second)
    ]);

    const persisted = await readFingerprintRecord(paths);
    expect([first, second]).toContainEqual(persisted);
    expect(await readdir(root)).toEqual(["lobby-fingerprint.json"]);
  });

  it("fails closed on damaged JSON without logging record contents", async () => {
    const { paths } = await temporaryPaths();
    const sensitiveFragment = "damaged-record-fragment";
    await writeFile(
      paths.fingerprint,
      '{"schema":"' + sensitiveFragment + '"',
      "utf8"
    );
    const spies = ["log", "info", "warn", "error"].map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {})
    );
    let caught;

    try {
      await readFingerprintRecord(paths);
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ code: "FINGERPRINT_RECORD_INVALID" });
    expect(caught.message).not.toContain(sensitiveFragment);
    expect(spies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
  });

  it("rejects invalid schema and extra fields on read", async () => {
    const { paths } = await temporaryPaths();
    const record = validRecord();
    record.threshold = 0.55;
    await writeFile(paths.fingerprint, JSON.stringify(record), "utf8");

    await expect(readFingerprintRecord(paths)).rejects.toMatchObject({
      code: "FINGERPRINT_RECORD_INVALID"
    });
  });

  it("validates before writing and leaves no partial record", async () => {
    const { root, paths } = await temporaryPaths();
    const record = validRecord();
    record.slots[0][0] = "secret-record-fragment";

    await expect(writeFingerprintRecord(paths, record)).rejects.toMatchObject({
      code: "FINGERPRINT_RECORD_INVALID"
    });

    expect(await readdir(root)).toEqual([]);
  });
});
