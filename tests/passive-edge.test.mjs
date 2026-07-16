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

function browserFixture({ pages = [pageFixture()] } = {}) {
  const page = pages[0] ?? pageFixture();
  const context = {
    pages: vi.fn(() => pages),
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => {})
  };
  const browser = {
    launchPersistentContext: vi.fn(async () => context)
  };
  return { browser, context, page };
}

describe("PassiveEdge", () => {
  it("launches a persistent Edge context and navigates the first page", async () => {
    const { browser, context, page } = browserFixture();
    const edge = new PassiveEdge({
      profileDir: "dedicated-profile",
      browser
    });

    await expect(edge.open(TARGET)).resolves.toBeUndefined();

    expect(browser.launchPersistentContext).toHaveBeenCalledOnce();
    expect(browser.launchPersistentContext).toHaveBeenCalledWith(
      "dedicated-profile",
      {
        channel: "msedge",
        headless: true,
        viewport: { width: 1440, height: 900 }
      }
    );
    expect(context.pages).toHaveBeenCalledOnce();
    expect(context.newPage).not.toHaveBeenCalled();
    expect(page.goto).toHaveBeenCalledWith(TARGET, {
      waitUntil: "domcontentloaded",
      timeout: 60_000
    });
  });

  it("creates a page when the persistent context has none", async () => {
    const page = pageFixture();
    const context = {
      pages: vi.fn(() => []),
      newPage: vi.fn(async () => page),
      close: vi.fn(async () => {})
    };
    const browser = {
      launchPersistentContext: vi.fn(async () => context)
    };
    const edge = new PassiveEdge({ profileDir: "profile", browser });

    await edge.open(TARGET);

    expect(context.newPage).toHaveBeenCalledOnce();
    expect(page.goto).toHaveBeenCalledOnce();
  });

  it("returns only in-memory metadata and falls back to empty body text", async () => {
    const page = pageFixture();
    page.body.innerText.mockRejectedValueOnce(new Error("body unavailable"));
    const { browser } = browserFixture({ pages: [page] });
    const edge = new PassiveEdge({ profileDir: "profile", browser });
    await edge.open(TARGET);

    await expect(edge.metadata()).resolves.toEqual({
      url: TARGET,
      title: "Mahjong Soul",
      text: ""
    });
    expect(page.locator).toHaveBeenCalledWith("body");
    expect(page.body.innerText).toHaveBeenCalledOnce();
    expect(page.body.innerText).toHaveBeenCalledWith({ timeout: 3_000 });
  });

  it("captures a PNG in memory without a path option", async () => {
    const png = Buffer.from("owned-png");
    const page = pageFixture({ screenshot: vi.fn(async () => png) });
    const { browser } = browserFixture({ pages: [page] });
    const edge = new PassiveEdge({ profileDir: "profile", browser });
    await edge.open(TARGET);

    await expect(edge.frame()).resolves.toBe(png);
    expect(page.screenshot).toHaveBeenCalledWith();
  });

  it("closes an opened context at most once", async () => {
    const { browser, context } = browserFixture();
    const edge = new PassiveEdge({ profileDir: "profile", browser });

    await edge.close();
    await edge.open(TARGET);
    await edge.close();
    await edge.close();

    expect(context.close).toHaveBeenCalledOnce();
  });

  it("exposes exactly four methods and no Playwright handles", async () => {
    const { browser } = browserFixture();
    const edge = new PassiveEdge({ profileDir: "profile", browser });
    await edge.open(TARGET);

    expect(
      Object.getOwnPropertyNames(PassiveEdge.prototype).sort()
    ).toEqual(["close", "constructor", "frame", "metadata", "open"]);
    expect(Reflect.ownKeys(edge)).toEqual([]);
    expect(edge.browser).toBeUndefined();
    expect(edge.context).toBeUndefined();
    expect(edge.page).toBeUndefined();
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
    const { browser } = browserFixture();
    const edge = new PassiveEdge({ profileDir: "profile", browser });

    await expect(edge.open(url)).rejects.toMatchObject({
      code: "BROWSER_TARGET_REJECTED"
    });
    expect(browser.launchPersistentContext).not.toHaveBeenCalled();
  });

  it.each([
    "http://127.0.0.1:4173/login",
    "http://localhost:4173/login?state=ready",
    "http://[::1]:4173/login"
  ])("allows an explicit loopback target only through the test seam: %s", async (
    url
  ) => {
    const { browser, page } = browserFixture();
    const edge = new PassiveEdge({
      profileDir: "profile",
      browser,
      allowLoopback: true
    });

    await edge.open(url);

    expect(page.goto).toHaveBeenCalledWith(url, {
      waitUntil: "domcontentloaded",
      timeout: 60_000
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
    const { browser } = browserFixture();
    const edge = new PassiveEdge({ profileDir: "profile", browser });

    await expect(edge.open(url)).rejects.toMatchObject({
      code: "BROWSER_TARGET_REJECTED"
    });
    expect(browser.launchPersistentContext).not.toHaveBeenCalled();
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,hello",
    "file:///C:/secret.txt",
    "https://localhost:4173/login",
    "http://user:pass@localhost:4173/login",
    "http://localhost.evil.example:4173/login"
  ])("keeps unsafe targets blocked when the loopback seam is enabled: %s", async (
    url
  ) => {
    const { browser } = browserFixture();
    const edge = new PassiveEdge({
      profileDir: "profile",
      browser,
      allowLoopback: true
    });

    await expect(edge.open(url)).rejects.toMatchObject({
      code: "BROWSER_TARGET_REJECTED"
    });
    expect(browser.launchPersistentContext).not.toHaveBeenCalled();
  });
});
