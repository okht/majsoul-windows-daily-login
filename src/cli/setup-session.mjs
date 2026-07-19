import { pathToFileURL } from "node:url";
import { createInterface as nodeCreateInterface } from "node:readline/promises";
import sharp from "sharp";
import { appPaths } from "../paths.mjs";
import { PassiveEdge } from "../browser/passive-edge.mjs";
import { enrollLobbyFrames } from "../browser/fingerprint.mjs";
import { withFingerprintTokenizer } from "../browser/fingerprint-key.mjs";
import { writeFingerprintRecord } from "../browser/fingerprint-store.mjs";

const TARGET = "https://game.maj-soul.com/1/";
const SAMPLE_COUNT = 8;
const SAMPLE_INTERVAL_MS = 400;
const SETTLE_MS = 2_000;
const MAX_CAPTURE_ROUNDS = 3;
const PAINT_WAIT_MS = 90_000;
const PAINT_POLL_MS = 2_000;
const MAX_DARK_RATIO = 0.35;

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

async function darkRatio(png) {
  const { data } = await sharp(png)
    .raw()
    .ensureAlpha()
    .toBuffer({ resolveWithObject: true });
  let dark = 0;
  let total = 0;
  for (let index = 0; index < data.length; index += 16) {
    total += 1;
    if (data[index] < 20 && data[index + 1] < 20 && data[index + 2] < 20) {
      dark += 1;
    }
  }
  return total === 0 ? 1 : dark / total;
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

async function waitForPaintedFrame(session, sleep, log) {
  const deadline = Date.now() + PAINT_WAIT_MS;
  while (Date.now() < deadline) {
    const png = await session.frame();
    try {
      const ratio = await darkRatio(png);
      if (ratio <= MAX_DARK_RATIO) {
        log("画面已绘制（darkRatio=" + ratio.toFixed(3) + "）。");
        return;
      }
      log("等待画面绘制… darkRatio=" + ratio.toFixed(3));
    } finally {
      if (Buffer.isBuffer(png)) png.fill(0);
    }
    await sleep(PAINT_POLL_MS);
  }
  const error = new Error("Timed out waiting for a painted lobby frame.");
  error.code = "FINGERPRINT_FRAME_TOO_DARK";
  throw error;
}

async function enrollFromSession(session, values, log) {
  let frames = [];
  let lastError;

  await waitForPaintedFrame(session, values.sleep, log);

  for (let round = 1; round <= MAX_CAPTURE_ROUNDS; round += 1) {
    for (const frame of frames) {
      if (Buffer.isBuffer(frame)) frame.fill(0);
    }
    frames = [];

    log("无头采样中 (" + round + "/" + MAX_CAPTURE_ROUNDS + ")…");
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
      return;
    } catch (error) {
      lastError = error;
      if (
        error?.code !== "FINGERPRINT_ENROLLMENT_UNSTABLE" &&
        error?.code !== "FINGERPRINT_FRAME_TOO_DARK"
      ) {
        throw error;
      }
      log("本轮指纹不稳定（" + error.code + "），重试…");
    }
  }

  throw lastError;
}

export async function runVisibleSetup(dependencies = {}) {
  const values = { ...defaultDependencies(), ...dependencies };
  const log = (message) => {
    values.output?.write?.(message + (message.endsWith("\n") ? "" : "\n"));
  };

  let prompt;
  let headed;
  let headless;

  try {
    log("正在打开专用 Edge（可见窗口）。若长时间黑屏，请关闭全部 Edge 后重试。");
    headed = values.createSession({
      profileDir: values.paths.profile,
      headless: false
    });
    await headed.open(TARGET);
    log("Edge 已打开目标页。请在窗口中手动登录并进入大厅（不要关窗口）。");
    log("重要：按 Enter 后会关闭可见窗口，再用无头模式登记指纹（与每日验证一致）。");

    prompt = values.createInterface({
      input: values.input,
      output: values.output
    });
    await prompt.question(
      "请在 Edge 中手动完成登录并进入大厅，然后回到终端按 Enter。"
    );

    try {
      prompt.close();
    } finally {
      prompt = undefined;
    }

    log("正在关闭可见 Edge…");
    await headed.close();
    headed = undefined;

    log("正在以无头模式重新打开同一会话并登记指纹…");
    headless = values.createSession({
      profileDir: values.paths.profile,
      headless: true
    });
    await headless.open(TARGET);
    await enrollFromSession(headless, values, log);
  } finally {
    try {
      prompt?.close();
    } finally {
      try {
        if (headed) await headed.close();
      } finally {
        if (headless) await headless.close();
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
          "HINT: 大厅动画过强或未停在大厅。请停在静止大厅界面后重试。\n"
        );
      }
      if (error?.code === "FINGERPRINT_FRAME_TOO_DARK") {
        process.stderr.write(
          "HINT: 无头画面仍过暗。请确认登录态有效后重试。\n"
        );
      }
      process.exitCode = 2;
    }
  );
}
