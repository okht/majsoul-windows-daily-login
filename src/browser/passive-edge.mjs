import { chromium } from "playwright-core";

const TARGET = "https://game.maj-soul.com/1/";
const VIEWPORT = Object.freeze({ width: 1440, height: 900 });
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function targetRejected() {
  const error = new Error("The browser target is not allowed.");
  error.code = "BROWSER_TARGET_REJECTED";
  return error;
}

function sessionNotOpen() {
  const error = new Error("The passive browser session is not open.");
  error.code = "BROWSER_SESSION_NOT_OPEN";
  return error;
}

function sessionAlreadyOpen() {
  const error = new Error("The passive browser session is already open.");
  error.code = "BROWSER_SESSION_ALREADY_OPEN";
  return error;
}

function isSafeLoopbackTarget(value) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return false;
  }

  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      url.username === "" &&
      url.password === "" &&
      url.port !== "" &&
      LOOPBACK_HOSTS.has(url.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

export class PassiveEdge {
  #profileDir;
  #headless;
  #allowLoopback;
  #browser;
  #context;
  #page;

  constructor({
    profileDir,
    headless = true,
    browser = chromium,
    allowLoopback = false
  }) {
    this.#profileDir = profileDir;
    this.#headless = headless;
    this.#allowLoopback = allowLoopback;
    this.#browser = browser;
  }

  async open(url) {
    if (this.#context || this.#page) throw sessionAlreadyOpen();
    if (
      url !== TARGET &&
      !(this.#allowLoopback && isSafeLoopbackTarget(url))
    ) {
      throw targetRejected();
    }

    this.#context = await this.#browser.launchPersistentContext(
      this.#profileDir,
      {
        channel: "msedge",
        headless: this.#headless,
        viewport: VIEWPORT
      }
    );
    this.#page = this.#context.pages()[0] ?? await this.#context.newPage();
    await this.#page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 60_000
    });
  }

  async metadata() {
    if (!this.#page) throw sessionNotOpen();

    const [title, text] = await Promise.all([
      this.#page.title(),
      this.#page
        .locator("body")
        .innerText({ timeout: 3_000 })
        .catch(() => "")
    ]);
    return {
      url: this.#page.url(),
      title,
      text
    };
  }

  async frame() {
    if (!this.#page) throw sessionNotOpen();
    return this.#page.screenshot();
  }

  async close() {
    const context = this.#context;
    this.#context = undefined;
    this.#page = undefined;
    if (context) await context.close();
  }
}
