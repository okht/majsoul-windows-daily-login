import { describe, expect, it, vi } from "vitest";
import { runVisibleSetup } from "../src/cli/setup-session.mjs";

const TARGET = "https://game.maj-soul.com/1/";

function fixture(overrides = {}) {
  const frames = Array.from({ length: 8 }, (_, index) =>
    Buffer.from("frame-" + index)
  );
  let frameIndex = 0;
  const open = vi.fn(async () => {});
  const frame = vi.fn(async () => {
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
    createSession: vi.fn(() => session),
    createInterface: vi.fn(() => prompt),
    sleep: vi.fn(async () => {}),
    withFingerprintTokenizer: vi.fn(async (callback) => callback(tokenizer)),
    enrollLobbyFrames: vi.fn(async () => record),
    writeFingerprintRecord: vi.fn(async () => {}),
    ...overrides
  };
  return {
    frames,
    open,
    frame,
    close,
    session,
    prompt,
    record,
    tokenizer,
    dependencies
  };
}

describe("runVisibleSetup", () => {
  it("prompts once, samples a burst of frames, and stores one record", async () => {
    const value = fixture();

    await runVisibleSetup(value.dependencies);

    expect(value.dependencies.createSession).toHaveBeenCalledWith({
      profileDir: "private-profile",
      headless: false
    });
    expect(value.open).toHaveBeenCalledWith(TARGET);
    expect(value.dependencies.createInterface).toHaveBeenCalledWith({
      input: value.dependencies.input,
      output: value.dependencies.output
    });
    expect(value.prompt.question).toHaveBeenCalledTimes(1);
    expect(value.frame).toHaveBeenCalledTimes(8);
    expect(value.dependencies.sleep).toHaveBeenCalledWith(1_500);
    expect(value.dependencies.sleep).toHaveBeenCalledWith(400);

    const [ownedFrames, usedTokenizer] =
      value.dependencies.enrollLobbyFrames.mock.calls[0];
    expect(ownedFrames).toHaveLength(8);
    expect(usedTokenizer).toBe(value.tokenizer);
    expect(value.dependencies.writeFingerprintRecord).toHaveBeenCalledOnce();
    expect(value.dependencies.writeFingerprintRecord).toHaveBeenCalledWith(
      value.dependencies.paths,
      value.record
    );
    expect(value.prompt.close).toHaveBeenCalledOnce();
    expect(value.close).toHaveBeenCalledOnce();
  });

  it("retries unstable enrollment before giving up", async () => {
    const unstable = Object.assign(new Error("unstable"), {
      code: "FINGERPRINT_ENROLLMENT_UNSTABLE"
    });
    const value = fixture({
      enrollLobbyFrames: vi
        .fn()
        .mockRejectedValueOnce(unstable)
        .mockRejectedValueOnce(unstable)
        .mockResolvedValueOnce({ ok: true })
    });

    await runVisibleSetup(value.dependencies);

    expect(value.dependencies.enrollLobbyFrames).toHaveBeenCalledTimes(3);
    expect(value.frame).toHaveBeenCalledTimes(24);
    expect(value.dependencies.writeFingerprintRecord).toHaveBeenCalledOnce();
  });

  it("preserves an existing record when enrollment fails", async () => {
    let persisted = { id: "existing" };
    const enrollmentError = new Error("unstable enrollment");
    const value = fixture({
      enrollLobbyFrames: vi.fn(async () => {
        throw enrollmentError;
      }),
      writeFingerprintRecord: vi.fn(async (_paths, record) => {
        persisted = record;
      })
    });

    await expect(runVisibleSetup(value.dependencies)).rejects.toBe(
      enrollmentError
    );

    expect(persisted).toEqual({ id: "existing" });
    expect(value.dependencies.writeFingerprintRecord).not.toHaveBeenCalled();
    expect(value.prompt.close).toHaveBeenCalledOnce();
    expect(value.close).toHaveBeenCalledOnce();
  });

  it.each(["question", "frame", "enroll", "write"])(
    "closes terminal and Edge when %s fails",
    async (stage) => {
      const failure = new Error(stage + " failed");
      const value = fixture();
      if (stage === "question") {
        value.prompt.question.mockRejectedValueOnce(failure);
      } else if (stage === "frame") {
        value.frame.mockRejectedValueOnce(failure);
      } else if (stage === "enroll") {
        value.dependencies.enrollLobbyFrames.mockRejectedValueOnce(failure);
      } else {
        value.dependencies.writeFingerprintRecord.mockRejectedValueOnce(failure);
      }

      await expect(runVisibleSetup(value.dependencies)).rejects.toBe(failure);

      expect(value.prompt.close).toHaveBeenCalledOnce();
      expect(value.close).toHaveBeenCalledOnce();
    }
  );
});
