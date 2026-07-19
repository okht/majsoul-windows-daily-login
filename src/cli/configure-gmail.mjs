import { mkdir as nodeMkdir, writeFile as nodeWriteFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createInterface as nodeCreateInterface } from "node:readline/promises";
import { localClock as defaultLocalClock } from "../beijing-time.mjs";
import { credentialStore } from "../credentials.mjs";
import { appPaths } from "../paths.mjs";
import { sendFailureMail as defaultSendFailureMail } from "../notifier.mjs";

const PRINTABLE = /^[\u0020-\u007e]$/;

export function readMaskedSecret(prompt, options = {}) {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;

  return new Promise((resolve, reject) => {
    const characters = [];
    let settled = false;
    const wasRaw = Boolean(input.isRaw);
    const canRaw = typeof input.setRawMode === "function";

    function cleanup() {
      input.removeListener("data", onData);
      input.removeListener("error", onError);
      if (canRaw) {
        input.setRawMode(wasRaw);
      }
      if (typeof input.pause === "function") {
        input.pause();
      }
    }

    function finish(error, value) {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        reject(error);
        return;
      }
      output.write("\n");
      resolve(value);
    }

    function onError(error) {
      finish(error);
    }

    function onData(chunk) {
      const text = typeof chunk === "string" ? chunk : String(chunk);
      for (const char of text) {
        if (char === "\u0003") {
          const error = new Error("Gmail secret entry was cancelled.");
          error.code = "GMAIL_SECRET_CANCELLED";
          finish(error);
          return;
        }
        if (char === "\r" || char === "\n") {
          finish(null, characters.join(""));
          return;
        }
        if (char === "\u007f" || char === "\b") {
          characters.pop();
          continue;
        }
        if (PRINTABLE.test(char)) {
          characters.push(char);
        }
      }
    }

    try {
      if (canRaw) {
        input.setRawMode(true);
      }
      if (typeof input.setEncoding === "function") {
        input.setEncoding("utf8");
      }
      if (typeof input.resume === "function") {
        input.resume();
      }
      output.write(prompt);
      input.on("data", onData);
      input.on("error", onError);
    } catch (error) {
      finish(error);
    }
  });
}

function defaultDependencies() {
  return {
    paths: appPaths(),
    input: process.stdin,
    output: process.stdout,
    createInterface: nodeCreateInterface,
    store: credentialStore(),
    mkdir: nodeMkdir,
    writeFile: nodeWriteFile,
    sendFailureMail: defaultSendFailureMail,
    readMaskedSecret,
    clock: defaultLocalClock
  };
}

export async function configureGmail(dependencies = {}) {
  const values = { ...defaultDependencies(), ...dependencies };
  const prompt = values.createInterface({
    input: values.input,
    output: values.output
  });

  let sender;
  let recipient;
  try {
    sender = (await prompt.question("Gmail 发件地址：")).trim();
    recipient = (await prompt.question("失败通知收件地址：")).trim();
  } finally {
    // Release stdin before raw-mode secret entry so the two readers never race.
    prompt.close();
  }

  const password = await values.readMaskedSecret("Gmail 应用专用密码：", {
    input: values.input,
    output: values.output
  });

  values.store.set(sender, password);
  await values.mkdir(values.paths.root, { recursive: true });
  await values.writeFile(
    values.paths.config,
    JSON.stringify({ sender, recipient }, null, 2) + "\n",
    "utf8"
  );

  const clock = values.clock();
  await values.sendFailureMail(
    { sender, recipient },
    {
      dateKey: clock.dateKey,
      time: clock.iso,
      kind: "CONFIG_TEST",
      phase: "gmail-setup",
      attempts: 1,
      action: "无需操作",
      logPath: values.paths.logs
    },
    { store: values.store }
  );
}

function isMainModule() {
  return Boolean(
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href
  );
}

if (isMainModule()) {
  configureGmail().catch((error) => {
    console.error(error && error.message ? error.message : error);
    process.exitCode = 1;
  });
}
