import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const renderer = path.join(root, "scripts", "render-task-xml.ps1");

function render(mode, extras = []) {
  return execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      renderer,
      "-Mode",
      mode,
      "-LauncherPath",
      "C:\\AppData\\Local\\MajSoulDaily\\app\\MajSoulDaily.exe",
      "-UserId",
      "TEST\\user",
      ...extras
    ],
    {
      encoding: "utf8",
      cwd: root,
      windowsHide: true
    }
  );
}

function expectSharedSettings(xml) {
  expect(xml).toContain("<StartWhenAvailable>true</StartWhenAvailable>");
  expect(xml).toContain(
    "<RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable>"
  );
  expect(xml).toContain("<WakeToRun>false</WakeToRun>");
  expect(xml).toContain("<Priority>8</Priority>");
  expect(xml).toContain(
    "<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>"
  );
  expect(xml).toContain("<ExecutionTimeLimit>PT10M</ExecutionTimeLimit>");
  expect(xml).toContain("<Hidden>true</Hidden>");
  expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
  expect(xml).toContain("TEST\\user");
  expect(xml).toContain(
    "C:\\AppData\\Local\\MajSoulDaily\\app\\MajSoulDaily.exe"
  );
  // Scheduler XML may only pass primary|catchup — never acceptance CLI.
  expect(xml).not.toMatch(/accept|acceptance|verify-session|setup-session/i);
  expect(xml).not.toContain("node.exe");
  expect(xml).not.toContain("run.mjs");
}

describe("task XML", () => {
  it("renders the random primary trigger through the installed launcher", () => {
    const xml = render("Primary");
    expectSharedSettings(xml);
    expect(xml).toContain("<StartBoundary>2026-01-01T10:00:00</StartBoundary>");
    expect(xml).toContain("<RandomDelay>PT2H30M</RandomDelay>");
    expect(xml).toContain("<DaysInterval>1</DaysInterval>");
    expect(xml).toMatch(/<Arguments>primary<\/Arguments>/i);
    expect(xml).not.toContain("catchup");
  });

  it("renders unlock and repeated catch-up triggers", () => {
    const xml = render("Catchup");
    expectSharedSettings(xml);
    expect(xml).toContain("<LogonTrigger>");
    expect(xml).toContain("<StateChange>SessionUnlock</StateChange>");
    expect(xml).toContain("<StartBoundary>2026-01-01T12:30:00</StartBoundary>");
    expect(xml).toContain("<Interval>PT15M</Interval>");
    expect(xml).toContain("<Duration>PT11H15M</Duration>");
    expect(xml).toMatch(/<Arguments>catchup<\/Arguments>/i);
    expect(xml).not.toContain("primary");
  });

  it("escapes XML-special characters in paths and user ids", () => {
    const xml = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        renderer,
        "-Mode",
        "Primary",
        "-LauncherPath",
        "C:\\App&Data\\MajSoulDaily\\app\\MajSoulDaily.exe",
        "-UserId",
        "TEST\\user<admin>"
      ],
      { encoding: "utf8", cwd: root, windowsHide: true }
    );
    expect(xml).toContain("C:\\App&amp;Data\\MajSoulDaily\\app\\MajSoulDaily.exe");
    expect(xml).toContain("TEST\\user&lt;admin&gt;");
  });
});
