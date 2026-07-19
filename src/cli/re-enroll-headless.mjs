import { pathToFileURL } from "node:url";
import { appPaths } from "../paths.mjs";
import { PassiveEdge } from "../browser/passive-edge.mjs";
import {
  enrollLobbyFrames,
  isMostlyDarkPng
} from "../browser/fingerprint.mjs";
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(message) {
  process.stdout.write(message + "\n");
}

async function main() {
  const paths = appPaths();
  const session = new PassiveEdge({
    profileDir: paths.profile,
    headless: true
  });

  try {
    log("使用已有登录态，无头打开雀魂并重新登记指纹…");
    await session.open(TARGET);

    const deadline = Date.now() + PAINT_WAIT_MS;
    while (Date.now() < deadline) {
      const png = await session.frame();
      try {
        const dark = await isMostlyDarkPng(png, MAX_DARK_RATIO);
        log(dark ? "等待画面…" : "画面已绘制。");
        if (!dark) break;
      } finally {
        if (Buffer.isBuffer(png)) png.fill(0);
      }
      await sleep(PAINT_POLL_MS);
    }

    let lastError;
    for (let round = 1; round <= MAX_CAPTURE_ROUNDS; round += 1) {
      log("采样 " + round + "/" + MAX_CAPTURE_ROUNDS);
      await sleep(SETTLE_MS);
      const frames = [];
      for (let index = 0; index < SAMPLE_COUNT; index += 1) {
        frames.push(await session.frame());
        if (index + 1 < SAMPLE_COUNT) await sleep(SAMPLE_INTERVAL_MS);
      }
      try {
        await withFingerprintTokenizer(async (tokenizer) => {
          const record = await enrollLobbyFrames(frames, tokenizer);
          await writeFingerprintRecord(paths, record);
        });
        log("SUCCESS");
        return 0;
      } catch (error) {
        lastError = error;
        log("本轮失败: " + (error?.code || error?.message || error));
      } finally {
        for (const frame of frames) {
          if (Buffer.isBuffer(frame)) frame.fill(0);
        }
      }
    }
    throw lastError;
  } finally {
    await session.close().catch(() => undefined);
  }
}

function isMainModule() {
  return Boolean(
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href
  );
}

if (isMainModule()) {
  main().then(
    (code) => {
      process.exitCode = code ?? 0;
    },
    (error) => {
      process.stderr.write("REENROLL_FAILED\n");
      process.stderr.write(
        (error?.code ? String(error.code) + " " : "") +
          (error?.message || String(error)) +
          "\n"
      );
      process.exitCode = 2;
    }
  );
}
