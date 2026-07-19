import { performance } from "node:perf_hooks";
import sharp from "sharp";
import {
  LOBBY_MATCH_THRESHOLD,
  scoreLobbyFrame
} from "./fingerprint.mjs";

const DEFAULT_DEADLINE_MS = 180_000;
const DEFAULT_INTERVAL_MS = 3_000;
const REQUIRED_CONSECUTIVE_MATCHES = 2;
const LOADING_DARK_RATIO = 0.75;

async function isMostlyDarkFrame(png, options = {}) {
  if (typeof options.isDarkFrame === "function") {
    return options.isDarkFrame(png);
  }
  if (!Buffer.isBuffer(png)) return false;
  try {
    const { data } = await sharp(png)
      .raw()
      .ensureAlpha()
      .toBuffer({ resolveWithObject: true });
    let dark = 0;
    let total = 0;
    for (let index = 0; index < data.length; index += 32) {
      total += 1;
      if (data[index] < 20 && data[index + 1] < 20 && data[index + 2] < 20) {
        dark += 1;
      }
    }
    return total > 0 && dark / total >= LOADING_DARK_RATIO;
  } catch {
    return false;
  }
}

const ENGLISH_MANUAL_MARKER =
  /\b(?:captcha|confirm|consent|log\s*in|login|sign\s*in|verification|verify)\b|^i\s+agree$/i;
const CHINESE_VERIFICATION_MARKER = /(?:安全)?(?:验证|驗證)(?:码|碼)?/u;
const CHINESE_CONFIRMATION_MARKER = /(?:确认|確認|同意|接受|授权|授權)/u;
const CHINESE_LOGIN_MARKER = /(?:登录|登錄|登入)(?:游戏|遊戲)?/u;
const LOGIN_REWARD_LABEL =
  /(?:每日)?(?:登录|登錄|登入)(?:奖励|獎勵)|(?:daily\s+)?login\s+reward/giu;

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function accessibleManualMarker(text) {
  if (typeof text !== "string") return false;

  return text.split(/\r?\n/u).some((rawLine) => {
    const line = rawLine
      .replace(LOGIN_REWARD_LABEL, " ")
      .trim()
      .replace(/\s+/gu, " ");
    if (!line) return false;
    return (
      ENGLISH_MANUAL_MARKER.test(line) ||
      CHINESE_VERIFICATION_MARKER.test(line) ||
      CHINESE_CONFIRMATION_MARKER.test(line) ||
      CHINESE_LOGIN_MARKER.test(line)
    );
  });
}

export async function detectLobby(
  session,
  record,
  tokenizer,
  options = {}
) {
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? defaultSleep;
  const scoreFrame = options.scoreFrame ?? scoreLobbyFrame;
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;

  const startedAt = now();
  let consecutiveMatches = 0;
  const deadlineReached = () => now() - startedAt >= deadlineMs;
  const unconfirmed = () => ({
    status: "MANUAL_ACTION_REQUIRED",
    reasonCode: "LOBBY_UNCONFIRMED"
  });

  while (!deadlineReached()) {
    const metadata = await session.metadata();
    if (deadlineReached()) return unconfirmed();

    const accessibleText = [metadata?.title, metadata?.text]
      .filter((value) => typeof value === "string")
      .join("\n");
    if (accessibleManualMarker(accessibleText)) {
      return {
        status: "MANUAL_ACTION_REQUIRED",
        reasonCode: "ACCESSIBLE_MANUAL_MARKER"
      };
    }

    const frame = await session.frame();
    if (deadlineReached()) {
      if (Buffer.isBuffer(frame)) frame.fill(0);
      return unconfirmed();
    }

    let score;
    try {
      // Skip nearly-black loading frames without resetting match streak.
      if (await isMostlyDarkFrame(frame, options)) {
        // still consume the frame buffer below
      } else {
        score = await scoreFrame(frame, record, tokenizer);
      }
    } finally {
      if (Buffer.isBuffer(frame)) frame.fill(0);
    }
    if (deadlineReached()) return unconfirmed();

    if (
      Number.isFinite(score) &&
      score >= LOBBY_MATCH_THRESHOLD
    ) {
      consecutiveMatches += 1;
      if (consecutiveMatches === REQUIRED_CONSECUTIVE_MATCHES) {
        return { status: "SUCCESS" };
      }
    } else if (score !== undefined) {
      consecutiveMatches = 0;
    }

    const remaining = deadlineMs - (now() - startedAt);
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
  }

  return unconfirmed();
}
