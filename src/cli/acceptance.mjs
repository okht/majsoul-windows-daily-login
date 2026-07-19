import { spawn } from "node:child_process";
import { createInterface as nodeCreateInterface } from "node:readline/promises";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildAcceptanceReceipt,
  writeAcceptanceReceipt
} from "../acceptance-receipt.mjs";
import { appendLogLine } from "../logger.mjs";
import { localClock } from "../beijing-time.mjs";
import { appPaths } from "../paths.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? ROOT,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolve({ code: 1, stdout, stderr: String(error) });
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function askYesNo(question, dependencies) {
  if (typeof dependencies.confirm === "function") {
    return Boolean(await dependencies.confirm(question));
  }
  const rl = dependencies.createInterface({
    input: dependencies.input,
    output: dependencies.output
  });
  try {
    const answer = (await rl.question(question + " [y/N] ")).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

async function tasksRegistered(dependencies) {
  if (typeof dependencies.listScheduledTasks === "function") {
    return dependencies.listScheduledTasks();
  }
  const result = await runCommand("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "@('MajSoulDaily-Primary','MajSoulDaily-Catchup') | ForEach-Object { if (Get-ScheduledTask -TaskName $_ -ErrorAction SilentlyContinue) { $_ } }"
  ]);
  const names = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return names;
}

export async function runAcceptance(dependencies = {}) {
  const paths = dependencies.paths ?? appPaths();
  const packageJsonPath = dependencies.packageJsonPath ?? path.join(ROOT, "package.json");
  const pkg = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const version = pkg.version;
  const interactive = dependencies.interactive !== false;
  const skipVerify = dependencies.skipVerify === true;

  const checks = {
    verify: false,
    privacy: false,
    noInput: false,
    dryRun: false,
    noTasksRegistered: false,
    interactiveRealLobby: false,
    interactiveGmail: false
  };

  const details = [];

  if (skipVerify) {
    checks.verify = true;
    checks.privacy = true;
    checks.noInput = true;
    details.push("verify:skipped-by-test-harness");
  } else {
    const verify = await (dependencies.runVerify?.() ??
      runCommand(
        process.platform === "win32" ? "npm.cmd" : "npm",
        ["run", "verify"]
      ));
    checks.verify = verify.code === 0;
    details.push("verify:exit=" + verify.code);

    const privacy = await (dependencies.runPrivacy?.() ??
      runCommand(process.execPath, ["scripts/check-privacy.mjs"]));
    checks.privacy = privacy.code === 0;
    details.push("privacy:exit=" + privacy.code);

    const noInput = await (dependencies.runNoInput?.() ??
      runCommand(process.execPath, ["scripts/check-no-input.mjs"]));
    checks.noInput = noInput.code === 0;
    details.push("noInput:exit=" + noInput.code);
  }

  const dryRun = await (dependencies.runDryRun?.() ??
    runCommand("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "scripts/install.ps1",
      "-Mode",
      "DryRun",
      "-SkipVerify"
    ]));
  checks.dryRun =
    dryRun.code === 0 &&
    /no scheduled task was registered/i.test(dryRun.stdout + dryRun.stderr);
  details.push("dryRun:exit=" + dryRun.code);

  const registered = await tasksRegistered(dependencies);
  checks.noTasksRegistered = registered.length === 0;
  details.push("registeredTasks=" + registered.length);

  if (interactive) {
    checks.interactiveRealLobby = await askYesNo(
      "是否已完成 setup-session，并用 verify-session 连续三次确认大厅成功？",
      {
        confirm: dependencies.confirm,
        createInterface: dependencies.createInterface ?? nodeCreateInterface,
        input: dependencies.input ?? process.stdin,
        output: dependencies.output ?? process.stdout
      }
    );
    checks.interactiveGmail = await askYesNo(
      "是否已运行 configure-gmail，并收到纯文字 CONFIG_TEST 邮件（无截图/无密钥）？",
      {
        confirm: dependencies.confirm,
        createInterface: dependencies.createInterface ?? nodeCreateInterface,
        input: dependencies.input ?? process.stdin,
        output: dependencies.output ?? process.stdout
      }
    );
  } else if (dependencies.forceInteractivePass === true) {
    // Only for unit tests — never default in production CLI.
    checks.interactiveRealLobby = true;
    checks.interactiveGmail = true;
    details.push("interactive:forced-for-test");
  }

  const receipt = buildAcceptanceReceipt({ version, checks });
  let receiptPath = null;
  if (receipt.passed) {
    receiptPath = await (dependencies.writeReceipt?.(receipt, paths) ??
      writeAcceptanceReceipt(receipt, paths));
  }

  const clock = localClock();
  await (dependencies.log?.(paths, clock.dateKey, {
    level: "info",
    event: "acceptance",
    passed: receipt.passed,
    details
  }) ??
    appendLogLine(paths, clock.dateKey, {
      level: "info",
      event: "acceptance",
      passed: receipt.passed,
      details
    }));

  return {
    passed: receipt.passed,
    receipt,
    receiptPath,
    checks,
    details,
    exitCode: receipt.passed ? 0 : 3
  };
}

function isMainModule() {
  return Boolean(
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href
  );
}

if (isMainModule()) {
  const interactive = !process.argv.includes("--non-interactive");
  runAcceptance({ interactive }).then(
    (result) => {
      if (result.passed) {
        process.stdout.write("ACCEPTANCE_PASSED\n");
        process.stdout.write(
          "Receipt written under LOCALAPPDATA\\MajSoulDaily (not in git).\n"
        );
      } else {
        process.stdout.write("ACCEPTANCE_FAILED\n");
        process.stdout.write(
          "Failed checks: " +
            Object.entries(result.checks)
              .filter(([, ok]) => !ok)
              .map(([name]) => name)
              .join(", ") +
            "\n"
        );
        process.stdout.write(
          "Complete setup/verify/gmail interactively, then re-run acceptance.\n"
        );
      }
      process.exitCode = result.exitCode;
    },
    (error) => {
      process.stderr.write("ACCEPTANCE_CRASH\n");
      process.stderr.write(String(error?.message || error) + "\n");
      process.exitCode = 2;
    }
  );
}
