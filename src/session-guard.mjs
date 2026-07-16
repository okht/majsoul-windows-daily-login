import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const defaultExecFile = promisify(execFileCallback);

export async function isSessionUnlocked(execFile = defaultExecFile) {
  const script = [
    "$sid=(Get-Process -Id $PID).SessionId",
    "$locked=Get-Process -Name LogonUI -ErrorAction SilentlyContinue | Where-Object SessionId -eq $sid",
    "if($locked){'LOCKED'}else{'UNLOCKED'}"
  ].join("; ");

  try {
    const result = await execFile("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script
    ], {
      windowsHide: true,
      timeout: 5000
    });
    return typeof result?.stdout === "string" && result.stdout.trim() === "UNLOCKED";
  } catch {
    return false;
  }
}
