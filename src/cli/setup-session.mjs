import { pathToFileURL } from "node:url";
import { createInterface as nodeCreateInterface } from "node:readline/promises";
import { appPaths } from "../paths.mjs";
import { PassiveEdge } from "../browser/passive-edge.mjs";
import { enrollLobbyFrames } from "../browser/fingerprint.mjs";
import { withFingerprintTokenizer } from "../browser/fingerprint-key.mjs";
import { writeFingerprintRecord } from "../browser/fingerprint-store.mjs";

const TARGET = "https://game.maj-soul.com/1/";
const SAMPLE_COUNT = 8;
const SAMPLE_INTERVAL_MS = 400;
const SETTLE_MS = 1_500;
const MAX_CAPTURE_ROUNDS = 3;

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

async function captureFrames(session, sleep, count, intervalMs) {
  const frames = [];
  for (let index = 0; index < count; index += 1) {
    frames.push(await session.frame());
    if (index + 1 < count) {
      await sleep(intervalMs);
    }
  }
  return frames;
}

export async function runVisibleSetup(dependencies = {}) {
  const values = { ...defaultDependencies(), ...dependencies };
  const session = values.createSession({
    profileDir: values.paths.profile,
    headless: false
  });
  let frames = [];
  let prompt;

  try {
    values.output?.write?.(
      "正在打开专用 Edge（可见窗口）。若长时间黑屏，请关闭全部 Edge 后重试，或删除本地 edge-profile 再试。\n"
    );
    await session.open(TARGET);
    values.output?.write?.(
      "Edge 已打开目标页。请在窗口中手动登录并进入大厅（不要关窗口）。\n"
    );
    values.output?.write?.(
      "提示：尽量停在静止的大厅画面，少切页面；按 Enter 后会连拍数帧做指纹。\n"
    );
    prompt = values.createInterface({
      input: values.input,
      output: values.output
    });
    await prompt.question(
      "请在 Edge 中手动完成登录并进入大厅，然后回到终端按 Enter。"
    );

    let lastError;
    for (let round = 1; round <= MAX_CAPTURE_ROUNDS; round += 1) {
      for (const frame of frames) {
        if (Buffer.isBuffer(frame)) frame.fill(0);
      }
      frames = [];

      values.output?.write?.(
        "采样中 (" + round + "/" + MAX_CAPTURE_ROUNDS + ")，请保持大厅画面不动…\n"
      );
      await values.sleep(SETTLE_MS);
      frames = await captureFrames(
        session,
        values.sleep,
        SAMPLE_COUNT,
        SAMPLE_INTERVAL_MS
      );

      try {
        await values.withFingerprintTokenizer(async (tokenizer) => {
          const record = await values.enrollLobbyFrames(frames, tokenizer);
          await values.writeFingerprintRecord(values.paths, record);
        });
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        if (
          error?.code !== "FINGERPRINT_ENROLLMENT_UNSTABLE" &&
          error?.code !== "FINGERPRINT_FRAME_TOO_DARK"
        ) {
          throw error;
        }
        values.output?.write?.(
          "本轮指纹不稳定（" +
            error.code +
            "）。请确认已在大厅且画面稳定，将自动重试。\n"
        );
      }
    }

    if (lastError) throw lastError;
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
      process.stderr.write(code + message + "\n");
      if (error?.code === "FINGERPRINT_ENROLLMENT_UNSTABLE") {
        process.stderr.write(
          "HINT: 大厅动画过强或未停在大厅。请停在静止大厅界面后重试 setup-session。\n"
        );
      }
      if (error?.code === "FINGERPRINT_FRAME_TOO_DARK") {
        process.stderr.write(
          "HINT: 截到的画面几乎全黑。请确认 Edge 里雀魂已正常显示后再试。\n"
        );
      }
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
