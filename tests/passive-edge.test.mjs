import { describe, expect, it, vi } from "vitest";
import { PassiveEdge } from "../src/browser/passive-edge.mjs";

const TARGET = "https://game.maj-soul.com/1/";

function pageFixture(overrides = {}) {
  const body = {
    innerText: vi.fn(async () => "Lobby text")
  };
  return {
    goto: vi.fn(async () => {}),
    url: vi.fn(() => TARGET),
    title: vi.fn(async () => "Mahjong Soul"),
    locator: vi.fn(() => body),
    screenshot: vi.fn(async () => Buffer.from("png")),
    body,
    ...overrides
  };
}

function cdpFixture({ pages = [pageFixture()] } = {}) {
  const page = pages[0] ?? pageFixture();
  const context = {
    pages: vi.fn(() => pages),
    newPage: vi.fn(async () => page)
  };
  const browser = {
    contexts: vi.fn(() => [context]),
    close: vi.fn(async () => {})
  };
  const child = { pid: 4242, killed: false, kill: vi.fn() };
  return {
    page,
    context,
    browser,
    child,
    connectOverCDP: vi.fn(async () => browser),
    spawnProcess: vi.fn(() => child),
    waitForPort: vi.fn(async () => {}),
    findEdgePath: vi.fn(async () => "C:\\Edge\\msedge.exe"),
    killProcess: vi.fn(async () => {}),
    sleep: vi.fn(async () => {})
  };
}

function edgeOptions(fixture, overrides = {}) {
  return {
    profileDir: "dedicated-profile",
    connectOverCDP: fixture.connectOverCDP,
    spawnProcess: fixture.spawnProcess,
    waitForPort: fixture.waitForPort,
    findEdgePath: fixture.findEdgePath,
    killProcess: fixture.killProcess,
    sleep: fixture.sleep,
    ...overrides
  };
}

describe("PassiveEdge", () => {
  it("spawns system Edge and attaches over CDP", async () => {
    const fixture = cdpFixture();
    const edge = new PassiveEdge(edgeOptions(fixture, { headless: true }));

    await expect(edge.open(TARGET)).resolves.toBeUndefined();

    expect(fixture.spawnProcess).toHaveBeenCalledOnce();
    const [edgePath, args, options] = fixture.spawnProcess.mock.calls[0];
    expect(edgePath).toBe("C:\\Edge\\msedge.exe");
    expect(args).toEqual(
      expect.arrayContaining([
        "--user-data-dir=dedicated-profile",
        expect.stringMatching(/^--remote-debugging-port=\d+$/),
        "--disable-features=CalculateNativeWinOcclusion,TranslateUI",
        "--window-position=-32000,-32000",
        TARGET
      ])
    );
    expect(args).not.toContain("--headless=new");
    expect(options).toMatchObject({ windowsHide: true, stdio: "ignore" });
    expect(fixture.waitForPort).toHaveBeenCalledOnce();
    expect(fixture.connectOverCDP).toHaveBeenCalledWith(
      expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/)
    );
    expect(fixture.page.goto).not.toHaveBeenCalled();
  });

  it("uses a visible new window for headed setup sessions", async () => {
    const fixture = cdpFixture();
    const edge = new PassiveEdge(edgeOptions(fixture, { headless: false }));

    await edge.open(TARGET);
    const args = fixture.spawnProcess.mock.calls[0][1];
    expect(args).toContain("--new-window");
    expect(args).not.toContain("--window-position=-32000,-32000");
    expect(fixture.spawnProcess.mock.calls[0][2]).toMatchObject({
      windowsHide: false
    });
  });

  it("creates a page when the CDP context has none", async () => {
    const page = pageFixture({ url: vi.fn(() => "about:blank") });
    const context = {
      pages: vi.fn(() => []),
      newPage: vi.fn(async () => page)
    };
    const browser = {
      contexts: vi.fn(() => [context]),
      close: vi.fn(async () => {})
    };
    const edge = new PassiveEdge({
      profileDir: "profile",
      connectOverCDP: async () => browser,
      spawnProcess: () => ({ pid: 1, killed: false }),
      waitForPort: async () => {},
      findEdgePath: async () => "edge",
      killProcess: async () => {},
      sleep: async () => {}
    });

    await edge.open(TARGET);
    expect(context.newPage).toHaveBeenCalledOnce();
    expect(page.goto).toHaveBeenCalledWith(TARGET, {
      waitUntil: "domcontentloaded",
      timeout: 120_000
    });
  });

  it("returns only in-memory metadata and falls back to empty body text", async () => {
    const page = pageFixture({
      title: vi.fn(async () => "T"),
      locator: vi.fn(() => ({
        innerText: vi.fn(async () => {
          throw new Error("timeout");
        })
      }))
    });
    const fixture = cdpFixture({ pages: [page] });
    const edge = new PassiveEdge(edgeOptions(fixture, { profileDir: "p" }));
    await edge.open(TARGET);
    await expect(edge.metadata()).resolves.toEqual({
      url: TARGET,
      title: "T",
      text: ""
    });
  });

  it("captures a PNG in memory without a path option", async () => {
    const fixture = cdpFixture();
    const edge = new PassiveEdge(edgeOptions(fixture, { profileDir: "p" }));
    await edge.open(TARGET);
    await expect(edge.frame()).resolves.toEqual(Buffer.from("png"));
    expect(fixture.page.screenshot).toHaveBeenCalledWith();
  });

  it("closes an opened context at most once", async () => {
    const fixture = cdpFixture();
    const edge = new PassiveEdge(edgeOptions(fixture, { profileDir: "p" }));
    await edge.open(TARGET);
    await edge.close();
    await edge.close();
    expect(fixture.browser.close).toHaveBeenCalledOnce();
    expect(fixture.killProcess).toHaveBeenCalledOnce();
  });

  it("rejects a repeated open before launching and preserves the first context", async () => {
    const fixture = cdpFixture();
    const edge = new PassiveEdge(edgeOptions(fixture, { profileDir: "p" }));
    await edge.open(TARGET);
    await expect(edge.open(TARGET)).rejects.toMatchObject({
      code: "BROWSER_SESSION_ALREADY_OPEN"
    });
    expect(fixture.spawnProcess).toHaveBeenCalledOnce();
  });

  it("exposes exactly four methods and no Playwright handles", () => {
    const edge = new PassiveEdge({ profileDir: "p" });
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(edge)).sort()).toEqual(
      ["close", "constructor", "frame", "metadata", "open"].sort()
    );
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,hello",
    "file:///C:/secret.txt",
    "http://game.maj-soul.com/1/",
    "https://example.com/1/",
    "https://game.maj-soul.com/1/?next=javascript:alert(1)",
    "https://game.maj-soul.com/1/#fragment"
  ])("rejects an unsafe or non-production target: %s", async (url) => {
    const edge = new PassiveEdge({ profileDir: "p" });
    await expect(edge.open(url)).rejects.toMatchObject({
      code: "BROWSER_TARGET_REJECTED"
    });
  });

  it.each([
    "http://127.0.0.1:4173/login",
    "http://localhost:4173/login?state=ready",
    "http://[::1]:4173/login"
  ])("allows an explicit loopback target only through the test seam: %s", async (url) => {
    const page = pageFixture({ url: vi.fn(() => "about:blank") });
    const fixture = cdpFixture({ pages: [page] });
    const edge = new PassiveEdge(
      edgeOptions(fixture, { profileDir: "p", allowLoopback: true })
    );
    await edge.open(url);
    expect(page.goto).toHaveBeenCalledWith(url, {
      waitUntil: "domcontentloaded",
      timeout: 120_000
    });
  });

  it.each([
    "http://127.0.0.1:4173/login",
    "http://localhost:4173/login",
    "http://[::1]:4173/login",
    "http://user:pass@localhost:4173/login",
    "https://localhost:4173/login",
    "http://localhost.evil.example:4173/login"
  ])("rejects loopback-like targets unless safely enabled: %s", async (url) => {
    const edge = new PassiveEdge({ profileDir: "p", allowLoopback: false });
    await expect(edge.open(url)).rejects.toMatchObject({
      code: "BROWSER_TARGET_REJECTED"
    });
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,hello",
    "file:///C:/secret.txt",
    "https://localhost:4173/login",
    "http://user:pass@localhost:4173/login",
    "http://localhost.evil.example:4173/login"
  ])("keeps unsafe targets blocked when the loopback seam is enabled: %s", async (url) => {
    const edge = new PassiveEdge({ profileDir: "p", allowLoopback: true });
    await expect(edge.open(url)).rejects.toMatchObject({
      code: "BROWSER_TARGET_REJECTED"
    });
  });
});
