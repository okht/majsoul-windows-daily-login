import { describe, expect, it, vi } from "vitest";
import { canReachTarget } from "../src/connectivity.mjs";

describe("canReachTarget", () => {
  it.each([200, 404, 503])(
    "treats a resolved HTTP %s response as reachable",
    async (status) => {
      const fetchFn = vi.fn(async () => ({ status }));

      await expect(canReachTarget("https://example.invalid/target", 1234, fetchFn))
        .resolves.toBe(true);
      expect(fetchFn).toHaveBeenCalledTimes(1);

      const [url, options] = fetchFn.mock.calls[0];
      expect(url).toBe("https://example.invalid/target");
      expect(options).toMatchObject({
        method: "HEAD",
        cache: "no-store"
      });
      expect(options.signal).toBeInstanceOf(AbortSignal);
    }
  );

  it("fails closed when the injected fetch rejects", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("synthetic network failure");
    });

    await expect(canReachTarget("https://example.invalid/target", 100, fetchFn))
      .resolves.toBe(false);
  });

  it("fails closed when the injected fetch aborts", async () => {
    const fetchFn = vi.fn(async () => {
      throw new DOMException("synthetic abort", "AbortError");
    });

    await expect(canReachTarget("https://example.invalid/target", 100, fetchFn))
      .resolves.toBe(false);
  });

  it("aborts an unresolved injected fetch after the requested timeout", async () => {
    let observedSignal;
    const fetchFn = vi.fn((_url, { signal }) => {
      observedSignal = signal;
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });

    await expect(canReachTarget("https://example.invalid/target", 5, fetchFn))
      .resolves.toBe(false);
    expect(observedSignal.aborted).toBe(true);
    expect(observedSignal.reason?.name).toBe("TimeoutError");
  });
});
