import { createHmac } from "node:crypto";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LOBBY_MATCH_THRESHOLD,
  enrollLobbyFrames,
  scoreLobbyFrame
} from "../src/browser/fingerprint.mjs";

const WIDTH = 192;
const HEIGHT = 120;
const GRID_COLUMNS = 12;
const GRID_ROWS = 6;
const BLOCK_WIDTH = WIDTH / GRID_COLUMNS;
const BLOCK_HEIGHT = HEIGHT / GRID_ROWS;

function deterministicRandom(seed) {
  let call = 0;
  return (length) => {
    const output = Buffer.alloc(length);
    for (let index = 0; index < length; index += 1) {
      output[index] = (seed + call * 29 + index * 17) & 0xff;
    }
    call += 1;
    return output;
  };
}

function tokenizer(keyByte = 0x31) {
  const key = Buffer.alloc(32, keyByte);
  return (message) =>
    createHmac("sha256", key).update(message, "utf8").digest("hex");
}

function blockIndex(x, y) {
  return (
    Math.floor(y / BLOCK_HEIGHT) * GRID_COLUMNS +
    Math.floor(x / BLOCK_WIDTH)
  );
}

async function pngFromPixels(makePixel) {
  const pixels = Buffer.alloc(WIDTH * HEIGHT);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      pixels[y * WIDTH + x] = makePixel(
        x,
        y,
        x % BLOCK_WIDTH,
        y % BLOCK_HEIGHT,
        blockIndex(x, y)
      );
    }
  }
  try {
    return await sharp(pixels, {
      raw: { width: WIDTH, height: HEIGHT, channels: 1 }
    })
      .png()
      .toBuffer();
  } finally {
    pixels.fill(0);
  }
}

async function checkerFrame({
  center = 128,
  spread = 18,
  specialBlocks = new Set()
} = {}) {
  const low = center - Math.floor(spread / 2);
  const high = low + spread;
  return pngFromPixels((_x, _y, localX, localY, index) => {
    if (specialBlocks.has(index)) return center + 72;
    return localX % 2 === 0 && localY % 2 === 0 ? low : high;
  });
}

async function toneBoundaryFrame(distance) {
  return pngFromPixels((_x, _y, _localX, _localY, index) => {
    if (index < 24) return 128 - distance;
    if (index < 48) return 128;
    return 128 + distance;
  });
}

async function edgeBoundaryFrame(horizontalStep, verticalStep) {
  return pngFromPixels((_x, _y, localX, localY) =>
    Math.round(
      128 +
        horizontalStep * (localX - (BLOCK_WIDTH - 1) / 2) +
        verticalStep * (localY - (BLOCK_HEIGHT - 1) / 2)
    )
  );
}

async function layoutFrame(specialBlocks) {
  return checkerFrame({ specialBlocks });
}

async function copies(factory, count = 3) {
  return Promise.all(
    Array.from({ length: count }, async () => Buffer.from(await factory()))
  );
}

async function enroll(factory, options = {}) {
  const count = options.count ?? 3;
  return enrollLobbyFrames(
    await copies(factory, count),
    options.tokenizer ?? tokenizer(),
    {
      randomBytes: options.randomBytes ?? deterministicRandom(7)
    }
  );
}

function tokensOf(record) {
  return new Set(record.slots.flat());
}

function intersectionSize(left, right) {
  let size = 0;
  for (const value of left) {
    if (right.has(value)) size += 1;
  }
  return size;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fingerprint enrollment", () => {
  it("exports the fixed detector threshold", () => {
    expect(LOBBY_MATCH_THRESHOLD).toBe(0.88);
  });

  it("accepts only three through twelve owned PNG frames", async () => {
    await expect(
      enroll(() => checkerFrame(), { count: 2 })
    ).rejects.toMatchObject({ code: "FINGERPRINT_FRAME_COUNT_INVALID" });
    await expect(
      enroll(() => checkerFrame(), { count: 13 })
    ).rejects.toMatchObject({ code: "FINGERPRINT_FRAME_COUNT_INVALID" });
  });

  it("is deterministic for the same frames, key, and injected randomness", async () => {
    const first = await enroll(() => checkerFrame(), {
      randomBytes: deterministicRandom(19)
    });
    const second = await enroll(() => checkerFrame(), {
      randomBytes: deterministicRandom(19)
    });

    expect(second).toEqual(first);
  });

  it("persists only the strict HMAC record shape with fixed padding", async () => {
    const consoleMethods = ["log", "info", "warn", "error"].map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {})
    );
    const threeFrames = await enroll(() => checkerFrame(), { count: 3 });
    const fiveFrames = await enroll(() => checkerFrame(), {
      count: 5,
      randomBytes: deterministicRandom(11)
    });

    for (const record of [threeFrames, fiveFrames]) {
      expect(Object.keys(record)).toEqual([
        "schema",
        "enrollmentIdHex",
        "slots"
      ]);
      expect(record.schema).toBe("majsoul-lobby-fingerprint/v1");
      expect(record.enrollmentIdHex).toMatch(/^[0-9a-f]{32}$/);
      expect(record.slots).toHaveLength(216);
      for (const slot of record.slots) {
        expect(slot).toHaveLength(5);
        expect(new Set(slot)).toHaveLength(5);
        expect(slot).toEqual([...slot].sort());
        expect(slot.every((value) => /^[0-9a-f]{64}$/.test(value))).toBe(true);
      }

      const serialized = JSON.stringify(record);
      expect(serialized).not.toMatch(
        /"(?:width|height|grid|threshold|score|feature|rawHash|vector|base64|key)"/i
      );
      expect(serialized).not.toContain("89504e470d0a1a0a");
      expect(serialized).not.toContain("iVBOR");
    }

    expect(threeFrames.slots.map((slot) => slot.length)).toEqual(
      fiveFrames.slots.map((slot) => slot.length)
    );
    expect(consoleMethods.every((spy) => spy.mock.calls.length === 0)).toBe(
      true
    );
  });

  it("produces unrelated tokens when the key or enrollment ID changes", async () => {
    const baseline = await enroll(() => checkerFrame(), {
      tokenizer: tokenizer(0x11),
      randomBytes: deterministicRandom(3)
    });
    const differentKey = await enroll(() => checkerFrame(), {
      tokenizer: tokenizer(0x22),
      randomBytes: deterministicRandom(3)
    });
    const differentEnrollment = await enroll(() => checkerFrame(), {
      tokenizer: tokenizer(0x11),
      randomBytes: deterministicRandom(4)
    });

    expect(
      intersectionSize(tokensOf(baseline), tokensOf(differentKey))
    ).toBe(0);
    expect(
      intersectionSize(tokensOf(baseline), tokensOf(differentEnrollment))
    ).toBe(0);
  });

  it("bounds padding attempts when a tokenizer cannot produce unique tokens", async () => {
    let randomCalls = 0;
    const randomBytes = (length) => {
      randomCalls += 1;
      if (randomCalls > 1000) throw new Error("unbounded-padding-loop");
      return Buffer.alloc(length, randomCalls & 0xff);
    };

    await expect(
      enrollLobbyFrames(
        await copies(() => checkerFrame(), 3),
        () => "a".repeat(64),
        { randomBytes }
      )
    ).rejects.toMatchObject({ code: "FINGERPRINT_TOKEN_INVALID" });

    expect(randomCalls).toBeLessThan(1000);
  });

  it("rejects an unstable enrollment before a caller can persist it", async () => {
    const first = new Set(Array.from({ length: 24 }, (_, index) => index));
    const second = new Set(
      Array.from({ length: 24 }, (_, index) => index + 24)
    );
    let writes = 0;

    await expect(
      enrollLobbyFrames(
        [
          await checkerFrame(),
          await layoutFrame(first),
          await layoutFrame(second)
        ],
        tokenizer(),
        { randomBytes: deterministicRandom(5) }
      ).then((record) => {
        writes += 1;
        return record;
      })
    ).rejects.toMatchObject({ code: "FINGERPRINT_ENROLLMENT_UNSTABLE" });

    expect(writes).toBe(0);
  });

  it("fails closed on damaged or oversized PNG input without a record", async () => {
    const validFrames = await copies(() => checkerFrame(), 2);
    const damaged = Buffer.from("not a png", "utf8");
    const oversized = await sharp({
      create: {
        width: 4096,
        height: 4096,
        channels: 3,
        background: { r: 128, g: 128, b: 128 }
      }
    })
      .png()
      .toBuffer();

    for (const invalid of [damaged, oversized]) {
      let record;
      await expect(
        enrollLobbyFrames(
          [Buffer.from(invalid), ...validFrames.map((frame) => Buffer.from(frame))],
          tokenizer(),
          { randomBytes: deterministicRandom(13) }
        ).then((value) => {
          record = value;
        })
      ).rejects.toMatchObject({ code: "FINGERPRINT_IMAGE_INVALID" });
      expect(record).toBeUndefined();
    }
  });
});

describe("fingerprint scoring", () => {
  it("keeps the same frame and a global brightness shift above threshold", async () => {
    const record = await enroll(() => checkerFrame({ center: 118 }));

    const sameScore = await scoreLobbyFrame(
      await checkerFrame({ center: 118 }),
      record,
      tokenizer()
    );
    const shiftedScore = await scoreLobbyFrame(
      await checkerFrame({ center: 140 }),
      record,
      tokenizer()
    );

    expect(sameScore).toBeGreaterThanOrEqual(LOBBY_MATCH_THRESHOLD);
    expect(shiftedScore).toBeGreaterThanOrEqual(LOBBY_MATCH_THRESHOLD);
  });

  it("aliases tone, spread, and edge values on their tolerance boundaries", async () => {
    const toneRecord = await enroll(() => toneBoundaryFrame(6));
    const spreadRecord = await enroll(() => checkerFrame({ spread: 18 }));
    const edgeRecord = await enroll(() => edgeBoundaryFrame(8, 5));

    const toneScore = await scoreLobbyFrame(
      await toneBoundaryFrame(10),
      toneRecord,
      tokenizer()
    );
    const spreadScore = await scoreLobbyFrame(
      await checkerFrame({ spread: 22 }),
      spreadRecord,
      tokenizer()
    );
    const edgeScore = await scoreLobbyFrame(
      await edgeBoundaryFrame(7, 5),
      edgeRecord,
      tokenizer()
    );

    expect(toneScore).toBeGreaterThanOrEqual(LOBBY_MATCH_THRESHOLD);
    expect(spreadScore).toBeGreaterThanOrEqual(LOBBY_MATCH_THRESHOLD);
    expect(edgeScore).toBeGreaterThanOrEqual(LOBBY_MATCH_THRESHOLD);
  });

  it.each([0, 1, 2])(
    "tolerates %i animated blocks",
    async (changedBlockCount) => {
      const record = await enroll(() => checkerFrame());
      const changed = new Set(
        Array.from({ length: changedBlockCount }, (_, index) => index)
      );

      const score = await scoreLobbyFrame(
        await checkerFrame({ specialBlocks: changed }),
        record,
        tokenizer()
      );

      expect(score).toBeGreaterThanOrEqual(LOBBY_MATCH_THRESHOLD);
    }
  );

  it("allows 12 changed blocks after trimming but rejects 24", async () => {
    const record = await enroll(() => checkerFrame());
    const twelve = new Set(Array.from({ length: 12 }, (_, index) => index));
    const twentyFour = new Set(
      Array.from({ length: 24 }, (_, index) => index)
    );

    const twelveScore = await scoreLobbyFrame(
      await checkerFrame({ specialBlocks: twelve }),
      record,
      tokenizer()
    );
    const twentyFourScore = await scoreLobbyFrame(
      await checkerFrame({ specialBlocks: twentyFour }),
      record,
      tokenizer()
    );

    expect(twelveScore).toBeGreaterThanOrEqual(LOBBY_MATCH_THRESHOLD);
    expect(twentyFourScore).toBeLessThan(LOBBY_MATCH_THRESHOLD);
  });

  it("rejects a reordered layout with at least 24 changed blocks", async () => {
    const first = new Set(Array.from({ length: 24 }, (_, index) => index));
    const moved = new Set(
      Array.from({ length: 24 }, (_, index) => index + 24)
    );
    const record = await enroll(() => layoutFrame(first));

    const score = await scoreLobbyFrame(
      await layoutFrame(moved),
      record,
      tokenizer()
    );

    expect(score).toBeLessThan(LOBBY_MATCH_THRESHOLD);
  });

  it("zeroes the owned PNG when record validation fails", async () => {
    const record = await enroll(() => checkerFrame());
    const invalidRecord = { ...record, score: 1 };
    const png = await checkerFrame();

    await expect(
      scoreLobbyFrame(png, invalidRecord, tokenizer())
    ).rejects.toMatchObject({ code: "FINGERPRINT_RECORD_INVALID" });

    expect(png.equals(Buffer.alloc(png.length))).toBe(true);
  });
});
