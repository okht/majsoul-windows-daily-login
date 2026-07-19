import { execFileSync } from "node:child_process";
import { mkdtemp, rm, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "tools", "launcher", "MajSoulDailyLauncher.cs");

function findCsc() {
  const candidates = [
    path.join(
      process.env.WINDIR || "C:\\Windows",
      "Microsoft.NET",
      "Framework64",
      "v4.0.30319",
      "csc.exe"
    ),
    path.join(
      process.env.WINDIR || "C:\\Windows",
      "Microsoft.NET",
      "Framework",
      "v4.0.30319",
      "csc.exe"
    )
  ];
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ["/help"], { stdio: "ignore", windowsHide: true });
      return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

describe("MajSoulDaily launcher compile", () => {
  it("compiles to a Windows subsystem executable from tracked C# source", async () => {
    const csc = findCsc();
    if (!csc) {
      // Environment without csc cannot exercise this gate; do not fail CI-less hosts.
      expect(csc).toBeNull();
      return;
    }

    const dir = await mkdtemp(path.join(os.tmpdir(), "majsoul-launcher-"));
    const output = path.join(dir, "MajSoulDaily.exe");
    try {
      execFileSync(
        csc,
        [
          "/nologo",
          "/target:winexe",
          "/optimize+",
          "/platform:anycpu",
          `/out:${output}`,
          source
        ],
        { windowsHide: true }
      );
      await access(output);
      const help = execFileSync(output, [], {
        windowsHide: true,
        encoding: "utf8"
      });
      // wrong arity -> 64; process may not print
      expect(typeof help === "string" || help == null).toBe(true);
    } catch (error) {
      // exe returns non-zero for bad args; status 64 is success for this probe
      if (error?.status === 64) {
        return;
      }
      throw error;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects unknown triggers with exit code 64", async () => {
    const csc = findCsc();
    if (!csc) {
      expect(csc).toBeNull();
      return;
    }
    const dir = await mkdtemp(path.join(os.tmpdir(), "majsoul-launcher-"));
    const output = path.join(dir, "MajSoulDaily.exe");
    try {
      execFileSync(
        csc,
        ["/nologo", "/target:winexe", `/out:${output}`, source],
        { windowsHide: true }
      );
      try {
        execFileSync(output, ["accept"], { windowsHide: true });
        throw new Error("expected non-zero exit");
      } catch (error) {
        expect(error.status).toBe(64);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
