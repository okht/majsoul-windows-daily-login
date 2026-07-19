import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installScript = path.join(root, "scripts", "install.ps1");

describe("install.ps1 DryRun", () => {
  it("validates both task contracts without registering tasks", () => {
    const output = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        installScript,
        "-Mode",
        "DryRun"
      ],
      {
        encoding: "utf8",
        cwd: root,
        windowsHide: true,
        timeout: 60_000
      }
    );

    expect(output).toContain("Mode=DryRun");
    expect(output).toContain("MajSoulDaily-Primary");
    expect(output).toContain("MajSoulDaily-Catchup");
    expect(output).toContain("no scheduled task was registered");
    // Privacy: do not dump absolute user profile paths or emails.
    expect(output).not.toMatch(/@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(output).not.toMatch(/C:\\Users\\[^\\\s]+/i);
  });
});
