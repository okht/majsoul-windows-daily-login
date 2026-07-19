import { randomBytes as nodeRandomBytes } from "node:crypto";
import sharp from "sharp";
import { validateFingerprintRecord } from "./fingerprint-store.mjs";

const SCHEMA = "majsoul-lobby-fingerprint/v1";
const WIDTH = 192;
const HEIGHT = 120;
const GRID_COLUMNS = 12;
const GRID_ROWS = 6;
const BLOCK_WIDTH = WIDTH / GRID_COLUMNS;
const BLOCK_HEIGHT = HEIGHT / GRID_ROWS;
const BLOCK_COUNT = GRID_COLUMNS * GRID_ROWS;
const FEATURES_PER_BLOCK = 3;
const SLOT_COUNT = BLOCK_COUNT * FEATURES_PER_BLOCK;
const DROP_LOWEST_BLOCKS = 12;
// Real lobbies animate; require mutual similarity at least as strong as live match.
const ENROLLMENT_MINIMUM = 0.88;
const ENROLLMENT_FRAME_MIN = 3;
const ENROLLMENT_FRAME_MAX = 12;
const MAX_INPUT_PIXELS = 16_000_000;
const DARK_PIXEL_THRESHOLD = 18;
const DARK_FRAME_RATIO = 0.92;
const MAX_PADDING_ATTEMPTS = 32;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const TONE_BOUNDARIES = [-48, -24, -8, 8, 24, 48];
const SPREAD_BOUNDARIES = [8, 20, 40];
const FEATURE_WEIGHTS = [0.5, 0.2, 0.3];

export const LOBBY_MATCH_THRESHOLD = 0.88;

sharp.cache(false);

function boundedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function frameCountInvalid() {
  return boundedError(
    "FINGERPRINT_FRAME_COUNT_INVALID",
    "Fingerprint enrollment requires three through twelve frames."
  );
}

function frameTooDark() {
  return boundedError(
    "FINGERPRINT_FRAME_TOO_DARK",
    "A lobby fingerprint frame is too dark to enroll."
  );
}

function imageInvalid() {
  return boundedError(
    "FINGERPRINT_IMAGE_INVALID",
    "A lobby fingerprint frame is invalid."
  );
}

function tokenInvalid() {
  return boundedError(
    "FINGERPRINT_TOKEN_INVALID",
    "A lobby fingerprint token is invalid."
  );
}

function enrollmentUnstable() {
  return boundedError(
    "FINGERPRINT_ENROLLMENT_UNSTABLE",
    "The lobby fingerprint enrollment is unstable."
  );
}

function clearOwnedBuffers(buffers) {
  if (!Array.isArray(buffers)) return;
  for (const buffer of buffers) {
    if (Buffer.isBuffer(buffer)) buffer.fill(0);
  }
}

async function decodePng(png) {
  if (!Buffer.isBuffer(png)) throw imageInvalid();

  try {
    const image = sharp(png, {
      failOn: "error",
      limitInputPixels: MAX_INPUT_PIXELS,
      sequentialRead: true
    });
    const metadata = await image.metadata();
    if (metadata.format !== "png") throw imageInvalid();

    const raw = await image
      .flatten({ background: { r: 0, g: 0, b: 0 } })
      .greyscale()
      .resize(WIDTH, HEIGHT, { fit: "fill" })
      .raw()
      .toBuffer();
    if (raw.length !== WIDTH * HEIGHT) {
      raw.fill(0);
      throw imageInvalid();
    }
    return raw;
  } catch (error) {
    if (error?.code === "FINGERPRINT_IMAGE_INVALID") throw error;
    throw imageInvalid();
  }
}

function medianOfSorted(sorted) {
  const middle = sorted.length / 2;
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[Math.floor(middle)];
}

function quantileOfSorted(sorted, fraction) {
  return sorted[Math.floor((sorted.length - 1) * fraction)];
}

function numericCategory(value, boundaries, prefix) {
  let category = 0;
  while (
    category < boundaries.length &&
    value >= boundaries[category]
  ) {
    category += 1;
  }

  const aliases = new Set([prefix + category]);
  for (let index = 0; index < boundaries.length; index += 1) {
    if (Math.abs(value - boundaries[index]) <= 3) {
      aliases.add(prefix + index);
      aliases.add(prefix + (index + 1));
    }
  }

  return {
    symbol: prefix + category,
    aliases: [...aliases]
  };
}

function edgeCategory(horizontalGradient, verticalGradient) {
  if (horizontalGradient < 6 && verticalGradient < 6) {
    return { symbol: "ef", aliases: ["ef"] };
  }

  const horizontalDominant = horizontalGradient >= verticalGradient;
  const largest = Math.max(horizontalGradient, verticalGradient);
  const smallest = Math.min(horizontalGradient, verticalGradient);
  const ratio = smallest === 0 ? Number.POSITIVE_INFINITY : largest / smallest;
  const directional = horizontalDominant ? "eh" : "ev";
  const symbol = ratio > 1.5 ? directional : "em";
  const aliases = new Set([symbol]);

  if (ratio >= 1.35 && ratio <= 1.65) {
    aliases.add("em");
    aliases.add(directional);
  }

  return { symbol, aliases: [...aliases] };
}

function extractFrame(raw) {
  const wholeSorted = Buffer.from(raw);
  wholeSorted.sort();
  const wholeMedian = medianOfSorted(wholeSorted);
  wholeSorted.fill(0);

  const blocks = [];
  for (let blockRow = 0; blockRow < GRID_ROWS; blockRow += 1) {
    for (let blockColumn = 0; blockColumn < GRID_COLUMNS; blockColumn += 1) {
      const block = Buffer.alloc(BLOCK_WIDTH * BLOCK_HEIGHT);
      let blockOffset = 0;
      let horizontalTotal = 0;
      let horizontalCount = 0;
      let verticalTotal = 0;
      let verticalCount = 0;
      const startX = blockColumn * BLOCK_WIDTH;
      const startY = blockRow * BLOCK_HEIGHT;

      for (let localY = 0; localY < BLOCK_HEIGHT; localY += 1) {
        const y = startY + localY;
        for (let localX = 0; localX < BLOCK_WIDTH; localX += 1) {
          const x = startX + localX;
          const value = raw[y * WIDTH + x];
          block[blockOffset] = value;
          blockOffset += 1;

          if (localX + 1 < BLOCK_WIDTH) {
            horizontalTotal += Math.abs(
              value - raw[y * WIDTH + x + 1]
            );
            horizontalCount += 1;
          }
          if (localY + 1 < BLOCK_HEIGHT) {
            verticalTotal += Math.abs(
              value - raw[(y + 1) * WIDTH + x]
            );
            verticalCount += 1;
          }
        }
      }

      block.sort();
      const blockMedian = medianOfSorted(block);
      const spread =
        quantileOfSorted(block, 0.75) - quantileOfSorted(block, 0.25);
      const horizontalGradient = horizontalTotal / horizontalCount;
      const verticalGradient = verticalTotal / verticalCount;
      blocks.push([
        numericCategory(
          blockMedian - wholeMedian,
          TONE_BOUNDARIES,
          "t"
        ),
        numericCategory(spread, SPREAD_BOUNDARIES, "s"),
        edgeCategory(horizontalGradient, verticalGradient)
      ]);
      block.fill(0);
    }
  }
  return blocks;
}

function featureMatches(left, right) {
  return (
    left.aliases.includes(right.symbol) ||
    right.aliases.includes(left.symbol)
  );
}

function trimmedBlockScore(blockScores) {
  const kept = [...blockScores]
    .sort((left, right) => left - right)
    .slice(DROP_LOWEST_BLOCKS);
  return kept.reduce((sum, score) => sum + score, 0) / kept.length;
}

function compareFrames(left, right) {
  const blockScores = [];
  for (let block = 0; block < BLOCK_COUNT; block += 1) {
    let score = 0;
    for (let feature = 0; feature < FEATURES_PER_BLOCK; feature += 1) {
      if (featureMatches(left[block][feature], right[block][feature])) {
        score += FEATURE_WEIGHTS[feature];
      }
    }
    blockScores.push(score);
  }
  return trimmedBlockScore(blockScores);
}

function categoryMessage(enrollmentIdHex, slot, symbol) {
  return [
    SCHEMA,
    "category",
    enrollmentIdHex,
    String(slot),
    symbol
  ].join("\0");
}

function paddingMessage(enrollmentIdHex, slot, ordinal, randomHex) {
  return [
    SCHEMA,
    "padding",
    enrollmentIdHex,
    String(slot),
    String(ordinal),
    randomHex
  ].join("\0");
}

function checkedToken(tokenizer, message) {
  if (typeof tokenizer !== "function") throw tokenInvalid();
  const value = tokenizer(message);
  if (typeof value !== "string" || !TOKEN_PATTERN.test(value)) {
    throw tokenInvalid();
  }
  return value;
}

function checkedRandomBuffer(randomBytes, length) {
  const value = randomBytes(length);
  if (!Buffer.isBuffer(value) || value.length !== length) {
    if (Buffer.isBuffer(value)) value.fill(0);
    throw tokenInvalid();
  }
  return value;
}

function isMostlyDark(raw) {
  let dark = 0;
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] < DARK_PIXEL_THRESHOLD) dark += 1;
  }
  return dark / raw.length >= DARK_FRAME_RATIO;
}

/**
 * Pick three mutually similar frames from a burst. Animated lobbies often
 * make an arbitrary 3–5 sample sequence fail; the densest stable triple wins.
 */
export function selectStableEnrollmentIndices(
  frames,
  minimum = ENROLLMENT_MINIMUM
) {
  if (!Array.isArray(frames) || frames.length < ENROLLMENT_FRAME_MIN) {
    throw frameCountInvalid();
  }

  let best = null;
  let bestScore = -1;
  const count = frames.length;

  for (let i = 0; i < count; i += 1) {
    for (let j = i + 1; j < count; j += 1) {
      for (let k = j + 1; k < count; k += 1) {
        const ab = compareFrames(frames[i], frames[j]);
        const ac = compareFrames(frames[i], frames[k]);
        const bc = compareFrames(frames[j], frames[k]);
        const score = Math.min(ab, ac, bc);
        if (score >= minimum && score > bestScore) {
          bestScore = score;
          best = [i, j, k];
        }
      }
    }
  }

  if (!best) throw enrollmentUnstable();
  return best;
}

export async function enrollLobbyFrames(
  pngFrames,
  tokenizer,
  dependencies = {}
) {
  const rawFrames = [];
  const randomBytes = dependencies.randomBytes ?? nodeRandomBytes;
  let enrollmentRandom;

  try {
    if (
      !Array.isArray(pngFrames) ||
      pngFrames.length < ENROLLMENT_FRAME_MIN ||
      pngFrames.length > ENROLLMENT_FRAME_MAX
    ) {
      throw frameCountInvalid();
    }

    const frames = [];
    for (const png of pngFrames) {
      const raw = await decodePng(png);
      rawFrames.push(raw);
      if (isMostlyDark(raw)) throw frameTooDark();
      frames.push(extractFrame(raw));
    }

    const selectedIndices = selectStableEnrollmentIndices(frames);
    const selectedFrames = selectedIndices.map((index) => frames[index]);

    enrollmentRandom = checkedRandomBuffer(randomBytes, 16);
    const enrollmentIdHex = enrollmentRandom.toString("hex");
    enrollmentRandom.fill(0);
    enrollmentRandom = undefined;

    const slots = [];
    for (let slot = 0; slot < SLOT_COUNT; slot += 1) {
      const block = Math.floor(slot / FEATURES_PER_BLOCK);
      const feature = slot % FEATURES_PER_BLOCK;
      const values = new Set();

      for (const frame of selectedFrames) {
        values.add(
          checkedToken(
            tokenizer,
            categoryMessage(
              enrollmentIdHex,
              slot,
              frame[block][feature].symbol
            )
          )
        );
      }

      let paddingOrdinal = 0;
      while (values.size < 5) {
        if (paddingOrdinal >= MAX_PADDING_ATTEMPTS) throw tokenInvalid();
        const paddingRandom = checkedRandomBuffer(randomBytes, 32);
        let randomHex;
        try {
          randomHex = paddingRandom.toString("hex");
        } finally {
          paddingRandom.fill(0);
        }
        values.add(
          checkedToken(
            tokenizer,
            paddingMessage(
              enrollmentIdHex,
              slot,
              paddingOrdinal,
              randomHex
            )
          )
        );
        paddingOrdinal += 1;
      }

      slots.push([...values].sort());
    }

    return {
      schema: SCHEMA,
      enrollmentIdHex,
      slots
    };
  } finally {
    if (enrollmentRandom) enrollmentRandom.fill(0);
    clearOwnedBuffers(rawFrames);
    clearOwnedBuffers(pngFrames);
  }
}

export async function scoreLobbyFrame(pngFrame, record, tokenizer) {
  let raw;
  try {
    validateFingerprintRecord(record);
    raw = await decodePng(pngFrame);
    const frame = extractFrame(raw);
    const blockScores = [];

    for (let block = 0; block < BLOCK_COUNT; block += 1) {
      let blockScore = 0;
      for (
        let feature = 0;
        feature < FEATURES_PER_BLOCK;
        feature += 1
      ) {
        const slot = block * FEATURES_PER_BLOCK + feature;
        const approved = record.slots[slot];
        const matches = frame[block][feature].aliases.some((symbol) =>
          approved.includes(
            checkedToken(
              tokenizer,
              categoryMessage(record.enrollmentIdHex, slot, symbol)
            )
          )
        );
        if (matches) blockScore += FEATURE_WEIGHTS[feature];
      }
      blockScores.push(blockScore);
    }

    return trimmedBlockScore(blockScores);
  } finally {
    if (raw) raw.fill(0);
    if (Buffer.isBuffer(pngFrame)) pngFrame.fill(0);
  }
}

// Decoded byte buffers are cleared in finally blocks. JavaScript cannot
// guarantee resistance to a process-memory dump or immediate garbage collection
// of short-lived numeric category objects.
