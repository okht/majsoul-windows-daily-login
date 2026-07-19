import { execFile, spawn as nodeSpawn } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { chromium } from "playwright-core";

const execFileAsync = promisify(execFile);

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

function edgeMissing() {
  const error = new Error("Microsoft Edge executable was not found.");
  error.code = "EDGE_NOT_FOUND";
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

async function defaultFindEdgePath() {
  const candidates = [
    process.env.MAJSOUL_EDGE_PATH,
    process.env["ProgramFiles(x86)"]
      ? path.join(
          process.env["ProgramFiles(x86)"],
          "Microsoft",
          "Edge",
          "Application",
          "msedge.exe"
        )
      : null,
    process.env.ProgramFiles
      ? path.join(
          process.env.ProgramFiles,
          "Microsoft",
          "Edge",
          "Application",
          "msedge.exe"
        )
      : null
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // try next
    }
  }
  throw edgeMissing();
}

function defaultWaitForPort(port, host = "127.0.0.1", timeoutMs = 45_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ port, host }, () => {
        socket.end();
        resolve();
      });
      socket.on("error", () => {
        socket.destroy();
        if (Date.now() - started >= timeoutMs) {
          reject(new Error("Timed out waiting for Edge debugging port."));
          return;
        }
        setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
    server.on("error", reject);
  });
}

/**
 * Passive Edge session.
 *
 * Important: Mahjong Soul's canvas stays black under Playwright's
 * launchPersistentContext. We therefore spawn system Edge and attach via CDP
 * for both setup (visible) and scheduled (off-screen) runs.
 */
export class PassiveEdge {
  #profileDir;
  #headless;
  #allowLoopback;
  #edgePath;
  #spawn;
  #connectOverCDP;
  #waitForPort;
  #findEdgePath;
  #child;
  #browser;
  #context;
  #page;

  constructor({
    profileDir,
    headless = true,
    allowLoopback = false,
    edgePath,
    spawnProcess = nodeSpawn,
    connectOverCDP = (endpoint) => chromium.connectOverCDP(endpoint),
    waitForPort = defaultWaitForPort,
    findEdgePath = defaultFindEdgePath
  } = {}) {
    this.#profileDir = profileDir;
    this.#headless = headless;
    this.#allowLoopback = allowLoopback;
    this.#edgePath = edgePath;
    this.#spawn = spawnProcess;
    this.#connectOverCDP = connectOverCDP;
    this.#waitForPort = waitForPort;
    this.#findEdgePath = findEdgePath;
  }

  async open(url) {
    if (this.#context || this.#page || this.#browser || this.#child) {
      throw sessionAlreadyOpen();
    }
    if (
      url !== TARGET &&
      !(this.#allowLoopback && isSafeLoopbackTarget(url))
    ) {
      throw targetRejected();
    }

    await mkdir(this.#profileDir, { recursive: true });
    const edgePath = this.#edgePath ?? (await this.#findEdgePath());
    const port = await pickFreePort();

    const args = [
      "--user-data-dir=" + this.#profileDir,
      "--remote-debugging-port=" + String(port),
      "--remote-allow-origins=*",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--disable-features=CalculateNativeWinOcclusion,TranslateUI",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--ignore-gpu-blocklist",
      "--enable-webgl",
      "--use-angle=d3d11",
      "--disable-gpu-sandbox"
    ];

    if (this.#headless) {
      // Off-screen real window preserves WebGL better than --headless=new.
      args.push(
        "--window-position=-32000,-32000",
        "--window-size=" + VIEWPORT.width + "," + VIEWPORT.height
      );
    } else {
      args.push("--new-window");
    }
    args.push(url);

    this.#child = this.#spawn(edgePath, args, {
      stdio: "ignore",
      windowsHide: this.#headless === true
    });

    try {
      await this.#waitForPort(port);
      this.#browser = await this.#connectOverCDP(
        "http://127.0.0.1:" + String(port)
      );
      this.#context = this.#browser.contexts()[0];
      if (!this.#context) {
        throw new Error("Edge CDP context is missing.");
      }

      const pages = this.#context.pages();
      this.#page =
        pages.find((page) => {
          try {
            return page.url().includes("maj-soul") || page.url() === url;
          } catch {
            return false;
          }
        }) ??
        pages[0] ??
        (await this.#context.newPage());

      const current = (() => {
        try {
          return this.#page.url();
        } catch {
          return "";
        }
      })();
      if (current !== url && !String(current).includes("maj-soul.com")) {
        await this.#page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 120_000
        });
      }

      // Give the real Mahjong Soul shell time to paint. Skip for loopback
      // fixtures so timed seed events in tests remain observable.
      if (url === TARGET) {
        await sleep(this.#headless ? 2_000 : 1_500);
      }
    } catch (error) {
      await this.close().catch(() => undefined);
      throw error;
    }
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
    const browser = this.#browser;
    const child = this.#child;
    this.#browser = undefined;
    this.#context = undefined;
    this.#page = undefined;
    this.#child = undefined;

    try {
      if (browser) await browser.close();
    } catch {
      // ignore
    }

    if (child && child.pid && !child.killed) {
      try {
        if (process.platform === "win32") {
          await execFileAsync(
            "taskkill",
            ["/pid", String(child.pid), "/T", "/F"],
            { windowsHide: true }
          );
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        // ignore already-exited processes
      }
    }
  }
}
