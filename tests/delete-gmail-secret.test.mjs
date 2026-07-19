import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { deleteLocalSecrets } from "../src/cli/delete-gmail-secret.mjs";

describe("deleteLocalSecrets", () => {
  it("deletes gmail and fingerprint secrets without echoing the sender", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "majsoul-del-secret-"));
    const paths = {
      root,
      config: path.join(root, "config.json")
    };
    await writeFile(
      paths.config,
      JSON.stringify({
        sender: "sender@example.com",
        recipient: "recipient@example.com"
      }),
      "utf8"
    );

    const gmailDelete = vi.fn(() => true);
    const keyringDelete = vi.fn(() => true);
    const spies = ["log", "info", "warn", "error"].map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {})
    );

    const result = await deleteLocalSecrets({
      paths,
      gmailStore: { delete: gmailDelete },
      keyring: { delete: keyringDelete }
    });

    expect(result).toEqual({
      gmailDeleted: true,
      fingerprintDeleted: true,
      hadSender: true
    });
    expect(gmailDelete).toHaveBeenCalledWith("sender@example.com");
    expect(keyringDelete).toHaveBeenCalledWith(
      "MajSoulDaily.Fingerprint",
      "lobby-fingerprint-key"
    );
    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain("sender@example.com");
    }
    spies.forEach((spy) => spy.mockRestore());
  });

  it("tolerates a missing config file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "majsoul-del-secret-"));
    const result = await deleteLocalSecrets({
      paths: { root, config: path.join(root, "missing.json") },
      gmailStore: { delete: vi.fn() },
      keyring: { delete: vi.fn(() => false) }
    });
    expect(result.hadSender).toBe(false);
    expect(result.gmailDeleted).toBe(false);
  });
});
