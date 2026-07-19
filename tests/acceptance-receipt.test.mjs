import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildAcceptanceReceipt,
  isReceiptValid,
  writeAcceptanceReceipt
} from "../src/acceptance-receipt.mjs";

describe("acceptance receipt", () => {
  it("can pass without Gmail when lobby and automated gates succeed", () => {
    const deferredMail = buildAcceptanceReceipt({
      version: "0.1.0",
      checks: {
        verify: true,
        privacy: true,
        noInput: true,
        dryRun: true,
        noTasksRegistered: true,
        interactiveRealLobby: true,
        interactiveGmail: false
      }
    });
    expect(deferredMail.passed).toBe(true);
    expect(isReceiptValid(deferredMail, "0.1.0")).toBe(true);

    const missingLobby = buildAcceptanceReceipt({
      version: "0.1.0",
      checks: {
        verify: true,
        privacy: true,
        noInput: true,
        dryRun: true,
        noTasksRegistered: true,
        interactiveRealLobby: false,
        interactiveGmail: false
      }
    });
    expect(missingLobby.passed).toBe(false);
    expect(isReceiptValid(missingLobby, "0.1.0")).toBe(false);
  });

  it("writes receipt only under the provided local app root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "majsoul-receipt-"));
    const paths = { root };
    const receipt = buildAcceptanceReceipt({
      version: "0.1.0",
      checks: {
        verify: true,
        privacy: true,
        noInput: true,
        dryRun: true,
        noTasksRegistered: true,
        interactiveRealLobby: true,
        interactiveGmail: false
      }
    });
    const file = await writeAcceptanceReceipt(receipt, paths);
    expect(file.startsWith(root)).toBe(true);
    const body = JSON.parse(await readFile(file, "utf8"));
    expect(body.passed).toBe(true);
    expect(body.version).toBe("0.1.0");
  });
});
