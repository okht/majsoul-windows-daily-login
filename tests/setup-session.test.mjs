import { describe, expect, it, vi } from "vitest";
import { runVisibleSetup } from "../src/cli/setup-session.mjs";

const TARGET = "https://game.maj-soul.com/1/";

function makeSession(label, frames) {
  let frameIndex = 0;
  const open = vi.fn(async () => {});
  const frame = vi.fn(async () => {
    // Non-black-ish PNG-like buffer; sharp decode may fail in enroll mock.
    const value = frames[frameIndex % frames.length];
    frameIndex += 1;
    return value;
  });
  const close = vi.fn(async () => {});
  const session = new Proxy(Object.create(null), {
    get(_target, property) {
      if (property === "open") return open;
      if (property === "frame") return frame;
      if (property === "close") return close;
      throw new Error("forbidden-browser-input:" + String(property));
    }
  });
  return { label, open, frame, close, session };
}

function fixture(overrides = {}) {
  const headedFrames = Array.from({ length: 3 }, (_, index) =>
    Buffer.from("headed-" + index)
  );
  const headlessFrames = Array.from({ length: 8 }, (_, index) =>
    Buffer.from("headless-" + index)
  );
  const headed = makeSession("headed", headedFrames);
  const headless = makeSession("headless", headlessFrames);
  const sessions = [headed, headless];
  let sessionIndex = 0;

  // Minimal valid-looking PNG is not required: enroll is mocked.
  // darkRatio uses sharp — inject painted frames via real tiny PNG.
  // For unit tests enroll/write are mocked; waitForPaintedFrame needs low dark ratio.
  // Provide a light-gray PNG via sharp if available.
  const prompt = {
    question: vi.fn(async () => ""),
    close: vi.fn()
  };
  const record = { strict: "record" };
  const tokenizer = vi.fn(() => "a".repeat(64));

  const dependencies = {
    paths: { profile: "private-profile", fingerprint: "strict-record" },
    input: { terminal: "input" },
    output: { write: vi.fn() },
    createSession: vi.fn(() => {
      const current = sessions[sessionIndex];
      sessionIndex += 1;
      return current.session;
    }),
    createInterface: vi.fn(() => prompt),
    sleep: vi.fn(async () => {}),
    withFingerprintTokenizer: vi.fn(async (callback) => callback(tokenizer)),
    enrollLobbyFrames: vi.fn(async () => record),
    writeFingerprintRecord: vi.fn(async () => {}),
    ...overrides
  };

  return {
    headed,
    headless,
    prompt,
    record,
    tokenizer,
    dependencies
  };
}

async function lightPng() {
  const sharp = (await import("sharp")).default;
  return sharp({
    create: {
      width: 64,
      height: 64,
      channels: 3,
      background: { r: 180, g: 160, b: 120 }
    }
  })
    .png()
    .toBuffer();
}

describe("runVisibleSetup", () => {
  it("logs in headed, then enrolls from a headless session", async () => {
    const painted = await lightPng();
    const value = fixture();
    // Headless frames must pass darkRatio gate.
    let n = 0;
    value.headless.frame.mockImplementation(async () => {
      n += 1;
      return Buffer.from(painted);
    });

    await runVisibleSetup(value.dependencies);

    expect(value.dependencies.createSession).toHaveBeenNthCalledWith(1, {
      profileDir: "private-profile",
      headless: false
    });
    expect(value.dependencies.createSession).toHaveBeenNthCalledWith(2, {
      profileDir: "private-profile",
      headless: true
    });
    expect(value.headed.open).toHaveBeenCalledWith(TARGET);
    expect(value.headless.open).toHaveBeenCalledWith(TARGET);
    expect(value.prompt.question).toHaveBeenCalledTimes(1);
    expect(value.dependencies.enrollLobbyFrames).toHaveBeenCalledOnce();
    expect(value.dependencies.writeFingerprintRecord).toHaveBeenCalledWith(
      value.dependencies.paths,
      value.record
    );
    expect(value.headed.close).toHaveBeenCalledOnce();
    expect(value.headless.close).toHaveBeenCalledOnce();
    expect(n).toBeGreaterThanOrEqual(8);
  });

  it("closes both sessions when enrollment fails", async () => {
    const painted = await lightPng();
    const enrollmentError = Object.assign(new Error("boom"), {
      code: "FINGERPRINT_ENROLLMENT_UNSTABLE"
    });
    const value = fixture({
      enrollLobbyFrames: vi.fn(async () => {
        throw enrollmentError;
      })
    });
    value.headless.frame.mockImplementation(async () => Buffer.from(painted));

    await expect(runVisibleSetup(value.dependencies)).rejects.toBe(
      enrollmentError
    );
    expect(value.headed.close).toHaveBeenCalledOnce();
    expect(value.headless.close).toHaveBeenCalledOnce();
    expect(value.dependencies.writeFingerprintRecord).not.toHaveBeenCalled();
  });
});
