import { pathToFileURL } from "node:url";
import { createInterface as nodeCreateInterface } from "node:readline/promises";
import { appPaths } from "../paths.mjs";
import { PassiveEdge } from "../browser/passive-edge.mjs";
import { enrollLobbyFrames } from "../browser/fingerprint.mjs";
import { withFingerprintTokenizer } from "../browser/fingerprint-key.mjs";
import { writeFingerprintRecord } from "../browser/fingerprint-store.mjs";

const TARGET = "https://game.maj-soul.com/1/";
const SAMPLE_COUNT = 5;
const SAMPLE_INTERVAL_MS = 2_000;

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function defaultDependencies() {
  return {
    paths: appPaths(),
    input: process.stdin,
    output: process.stdout,
    createSession: (options) => new PassiveEdge(options),
    createInterface: nodeCreateInterface,
    sleep: defaultSleep,
    withFingerprintTokenizer,
    enrollLobbyFrames,
    writeFingerprintRecord
  };
}

export async function runVisibleSetup(dependencies = {}) {
  const values = { ...defaultDependencies(), ...dependencies };
  const session = values.createSession({
    profileDir: values.paths.profile,
    headless: false
  });
  const frames = [];
  let prompt;

  try {
    values.output?.write?.(
      "正在打开专用 Edge（可见窗口）。若长时间黑屏，请关闭全部 Edge 后重试，或删除本地 edge-profile 再试。\n"
    );
    await session.open(TARGET);
    values.output?.write?.(
      "Edge 已打开目标页。请在窗口中手动登录并进入大厅（不要关窗口）。\n"
    );
    prompt = values.createInterface({
      input: values.input,
      output: values.output
    });
    await prompt.question(
      "请在 Edge 中手动完成登录并进入大厅，然后回到终端按 Enter。"
    );

    for (let index = 0; index < SAMPLE_COUNT; index += 1) {
      frames.push(await session.frame());
      if (index + 1 < SAMPLE_COUNT) {
        await values.sleep(SAMPLE_INTERVAL_MS);
      }
    }

    await values.withFingerprintTokenizer(async (tokenizer) => {
      const record = await values.enrollLobbyFrames(frames, tokenizer);
      await values.writeFingerprintRecord(values.paths, record);
    });
  } finally {
    try {
      prompt?.close();
    } finally {
      try {
        await session.close();
      } finally {
        for (const frame of frames) {
          if (Buffer.isBuffer(frame)) frame.fill(0);
        }
      }
    }
  }
}

function isMainModule() {
  return Boolean(
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href
  );
}

if (isMainModule()) {
  runVisibleSetup().then(
    () => {
      process.stdout.write("SUCCESS\n");
      process.exitCode = 0;
    },
    (error) => {
      process.stderr.write("SETUP_FAILED\n");
      const code = error?.code ? String(error.code) + " " : "";
      const message = error?.message ? String(error.message) : String(error);
      // Never print paths under the user profile; keep the error class/message only.
      process.stderr.write(code + message + "\n");
      if (message.includes("Target page, context or browser has been closed")) {
        process.stderr.write(
          "HINT: Edge 被提前关闭或崩溃。请关闭所有 Edge 进程后重试。\n"
        );
      }
      if (/EBUSY|locked|in use|SingletonLock/i.test(message)) {
        process.stderr.write(
          "HINT: 专用配置目录被占用。请结束所有 msedge/Edge 后重试。\n"
        );
      }
      process.exitCode = 2;
    }
  );
}
