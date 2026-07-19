# Mahjong Soul Windows Daily Opener Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (<code>- [ ]</code>) syntax for tracking.

**Goal:** Build a privacy-conscious Windows utility that passively opens Mahjong Soul once per **local machine day**, never generates mouse or keyboard input, catches up after unlock and connectivity, and sends text-only Gmail alerts on failure.

**Architecture:** Two Windows scheduled tasks call one installed windowless launcher (`primary` / `catchup`). The runner applies a pure schedule policy against the **OS system timezone wall clock**, persists date-scoped state under <code>%LOCALAPPDATA%\MajSoulDaily</code>, launches a dedicated Microsoft Edge profile through a passive Playwright wrapper, and confirms the lobby using non-reversible visual features held in memory. Gmail credentials stay in Windows Credential Manager.

**Tech Stack:** Windows 11, PowerShell 5.1, Node.js 22 or newer, JavaScript ESM, Vitest 4.1.10, playwright-core 1.61.1, sharp 0.35.3, nodemailer 9.0.3, @napi-rs/keyring 1.3.0.

## Amendment (2026-07-19): local wall clock, not Beijing-only

This amendment **supersedes** earlier plan text that required Beijing time (`Asia/Shanghai`) or installer refusal unless the machine used `China Standard Time`.

| Topic | Current rule |
| --- | --- |
| Daily window | Local **10:00–12:30** in the Windows system timezone |
| Catch-up | Local **12:30–23:45**, plus logon/unlock |
| Daily state key | Local calendar `YYYY-MM-DD` from `localClock()` |
| Installer timezone gate | **None** — any system timezone is allowed |
| Module | `src/beijing-time.mjs` still exists for history, but exports `localClock()` (and `beijingClock` as a compatible alias) |

Earlier task checklists that still say “Beijing” should be read as **local wall clock** unless a step is purely historical.

## Global Constraints

- Target URL is <code>https://game.maj-soul.com/1/</code>.
- Use the system Microsoft Edge binary and a dedicated profile under <code>%LOCALAPPDATA%\MajSoulDaily\edge-profile</code>.
- The scheduled runner may start, navigate, observe, capture frames in memory, and close. It may not click, type, fill, press, tap, dispatch input events, or expose Playwright mouse and keyboard objects.
- The user performs every login, confirmation, and repair action in a visible setup session.
- Primary execution occurs once between **local** 10:00 and 12:30 through a 150-minute Windows random delay (system timezone).
- A locked session never launches Edge. A due run records <code>PENDING_DUE</code> and resumes after unlock and connectivity.
- Catch-up checks begin at **local** 12:30 and repeat every 15 minutes through **local** 23:45.
- Do not wake a sleeping computer.
- Success is silent. Failure and manual-action notifications are plain-text Gmail without screenshots.
- Persist no Mahjong Soul email, password, page screenshot, Cookie, Local Storage value, or request body.
- Keep logs for 14 days and redact secrets and browser state.
- Do not add proxies, fingerprint spoofing, CAPTCHA handling, click randomization, or anti-detection behavior.
- Do not refuse install/register solely because the timezone is not China Standard Time.

---

## File Map

| File | Responsibility |
| --- | --- |
| <code>package.json</code> | Exact dependencies and verification scripts |
| <code>src/paths.mjs</code> | Repository-independent local data paths |
| <code>src/beijing-time.mjs</code> | Local wall-clock date and minute-of-day (<code>localClock</code>) |
| <code>src/state-store.mjs</code> | Atomic date-scoped state persistence |
| <code>src/run-lock.mjs</code> | Cross-process single-run lock |
| <code>src/schedule-policy.mjs</code> | Pure primary and catch-up decisions |
| <code>src/session-guard.mjs</code> | Detect the current Windows lock state |
| <code>src/connectivity.mjs</code> | Bounded reachability check for the target |
| <code>src/browser/passive-edge.mjs</code> | Input-free Edge lifecycle and observation |
| <code>src/browser/fingerprint.mjs</code> | Convert transient frames into non-reversible vectors |
| <code>src/browser/lobby-detector.mjs</code> | Passive lobby/manual/timeout classification |
| <code>src/credentials.mjs</code> | Windows Credential Manager access |
| <code>src/notifier.mjs</code> | Text-only Gmail transport and daily deduplication |
| <code>src/daily-run.mjs</code> | Orchestrate gates, browser, state, and notifications |
| <code>src/cli/run.mjs</code> | Scheduled task entry point |
| <code>src/cli/setup-session.mjs</code> | Visible manual login and lobby fingerprint setup |
| <code>src/cli/configure-gmail.mjs</code> | Local Gmail configuration and secret prompt |
| <code>src/cli/repair-session.mjs</code> | Visible manual repair, unblock, and verification |
| <code>scripts/render-task-xml.ps1</code> | Render primary and catch-up Task Scheduler XML |
| <code>scripts/install.ps1</code> | Verify prerequisites and register both tasks |
| <code>scripts/uninstall.ps1</code> | Remove tasks, state, logs, and Gmail secret |
| <code>scripts/check-no-input.mjs</code> | Fail when scheduled code contains an input API |
| <code>tests/</code> | Unit, integration, task XML, privacy, and safety tests |

---

### Task 1: Project foundation, paths, and Beijing time

**Files:**
- Create: <code>package.json</code>
- Create: <code>src/paths.mjs</code>
- Create: <code>src/beijing-time.mjs</code>
- Create: <code>tests/beijing-time.test.mjs</code>
- Modify: <code>.gitignore</code>

**Interfaces:**
- Produces: <code>appPaths(env, homeDir) -&gt; AppPaths</code>
- Produces: <code>beijingClock(date) -&gt; { dateKey, minuteOfDay, iso }</code>
- Produces: <code>minutes(hour, minute) -&gt; number</code>

- [ ] **Step 1: Add the exact package manifest**

~~~json
{
  "name": "majsoul-windows-daily-login",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=22"
  },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "verify": "npm test"
  },
  "dependencies": {
    "@napi-rs/keyring": "1.3.0",
    "nodemailer": "9.0.3",
    "playwright-core": "1.61.1",
    "sharp": "0.35.3"
  },
  "devDependencies": {
    "vitest": "4.1.10"
  }
}
~~~

- [ ] **Step 2: Install locked dependencies**

Run:

~~~powershell
npm install
~~~

Expected: <code>package-lock.json</code> is created and <code>npm audit</code> reports no unresolved install failure.

- [ ] **Step 3: Write the failing Beijing-time tests**

~~~js
import { describe, expect, it } from "vitest";
import { beijingClock, minutes } from "../src/beijing-time.mjs";

describe("beijingClock", () => {
  it("uses Asia/Shanghai across a UTC date boundary", () => {
    const value = beijingClock(new Date("2026-07-16T16:30:00.000Z"));
    expect(value.dateKey).toBe("2026-07-17");
    expect(value.minuteOfDay).toBe(minutes(0, 30));
  });

  it("reports 12:30 as minute 750", () => {
    expect(minutes(12, 30)).toBe(750);
  });
});
~~~

- [ ] **Step 4: Run the focused test and confirm the red state**

Run:

~~~powershell
npx vitest run tests/beijing-time.test.mjs
~~~

Expected: FAIL because <code>src/beijing-time.mjs</code> does not exist.

- [ ] **Step 5: Implement paths and Beijing time**

~~~js
// src/beijing-time.mjs
const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23"
});

export function minutes(hour, minute) {
  return hour * 60 + minute;
}

export function beijingClock(date = new Date()) {
  const parts = Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  return {
    dateKey: parts.year + "-" + parts.month + "-" + parts.day,
    minuteOfDay: minutes(Number(parts.hour), Number(parts.minute)),
    iso: date.toISOString()
  };
}
~~~

~~~js
// src/paths.mjs
import os from "node:os";
import path from "node:path";

export function appPaths(env = process.env, homeDir = os.homedir()) {
  const local = env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local");
  const root = path.join(local, "MajSoulDaily");
  return {
    root,
    profile: path.join(root, "edge-profile"),
    state: path.join(root, "state"),
    logs: path.join(root, "logs"),
    fingerprint: path.join(root, "lobby-fingerprint.json"),
    config: path.join(root, "config.json"),
    lock: path.join(root, "run.lock")
  };
}
~~~

- [ ] **Step 6: Run the test and full verification**

Run:

~~~powershell
npx vitest run tests/beijing-time.test.mjs
npm run verify
~~~

Expected: focused test and verification PASS.

- [ ] **Step 7: Commit the foundation**

~~~powershell
git add package.json package-lock.json .gitignore src/paths.mjs src/beijing-time.mjs tests/beijing-time.test.mjs
git commit -m "build: add local runtime foundation"
~~~

---

### Task 2: Atomic state and cross-process locking

**Files:**
- Create: <code>src/state-store.mjs</code>
- Create: <code>src/run-lock.mjs</code>
- Create: <code>tests/state-store.test.mjs</code>
- Create: <code>tests/run-lock.test.mjs</code>

**Interfaces:**
- Consumes: <code>appPaths()</code>
- Produces: <code>readState(dateKey, paths) -&gt; Promise&lt;DailyState | null&gt;</code>
- Produces: <code>writeState(dateKey, state, paths) -&gt; Promise&lt;void&gt;</code>
- Produces: <code>clearBlockedState(dateKey, paths) -&gt; Promise&lt;void&gt;</code>
- Produces: <code>withRunLock(paths, fn, options) -&gt; Promise&lt;unknown&gt;</code>

- [ ] **Step 1: Write failing state and lock tests**

~~~js
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readState, writeState } from "../src/state-store.mjs";

describe("state-store", () => {
  it("round-trips one Beijing date atomically", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "majsoul-state-"));
    const paths = { state: path.join(root, "state") };
    await writeState("2026-07-16", { status: "SUCCESS" }, paths);
    expect(await readState("2026-07-16", paths)).toMatchObject({ status: "SUCCESS" });
  });

  it("quarantines invalid JSON and returns null", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "majsoul-state-"));
    const paths = { state: path.join(root, "state") };
    await writeState("2026-07-16", { status: "RUNNING" }, paths);
    const file = path.join(paths.state, "2026-07-16.json");
    await import("node:fs/promises").then((fs) => fs.writeFile(file, "{broken", "utf8"));
    expect(await readState("2026-07-16", paths)).toBeNull();
  });
});
~~~

- [ ] **Step 2: Confirm both new test files fail**

Run:

~~~powershell
npx vitest run tests/state-store.test.mjs tests/run-lock.test.mjs
~~~

Expected: FAIL with missing module errors.

- [ ] **Step 3: Implement atomic JSON state**

~~~js
// src/state-store.mjs
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const DAILY_STATUSES = Object.freeze([
  "PENDING_DUE",
  "RUNNING",
  "SUCCESS",
  "FAILED_TRANSIENT",
  "BLOCKED_MANUAL"
]);

function stateFile(dateKey, paths) {
  return path.join(paths.state, dateKey + ".json");
}

export async function readState(dateKey, paths) {
  const file = stateFile(dateKey, paths);
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) {
      await rename(file, file + ".corrupt-" + Date.now());
      return null;
    }
    throw error;
  }
}

export async function writeState(dateKey, state, paths) {
  await mkdir(paths.state, { recursive: true });
  const file = stateFile(dateKey, paths);
  const temporary = file + "." + process.pid + ".tmp";
  const value = { ...state, dateKey, updatedAt: new Date().toISOString() };
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(temporary, file);
}

export async function clearBlockedState(dateKey, paths) {
  const state = await readState(dateKey, paths);
  if (state?.status !== "BLOCKED_MANUAL") return;
  await writeState(dateKey, { status: "FAILED_TRANSIENT", repairedAt: new Date().toISOString() }, paths);
}
~~~

- [ ] **Step 4: Implement a stale-aware exclusive lock**

~~~js
// src/run-lock.mjs
import { open, readFile, rm } from "node:fs/promises";

export async function withRunLock(paths, fn, options = {}) {
  const staleMs = options.staleMs ?? 600000;
  const now = options.now ?? (() => Date.now());
  let handle;
  try {
    handle = await open(paths.lock, "wx");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = JSON.parse(await readFile(paths.lock, "utf8"));
    if (now() - existing.startedAt < staleMs) {
      const active = new Error("A daily run is already active.");
      active.code = "RUN_ALREADY_ACTIVE";
      throw active;
    }
    await rm(paths.lock, { force: true });
    return withRunLock(paths, fn, options);
  }

  await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: now() }));
  try {
    return await fn();
  } finally {
    await handle.close();
    await rm(paths.lock, { force: true });
  }
}
~~~

The test must start two concurrent calls and assert that only one callback executes.

- [ ] **Step 5: Run both suites**

Run:

~~~powershell
npx vitest run tests/state-store.test.mjs tests/run-lock.test.mjs
~~~

Expected: PASS.

- [ ] **Step 6: Commit state safety**

~~~powershell
git add src/state-store.mjs src/run-lock.mjs tests/state-store.test.mjs tests/run-lock.test.mjs
git commit -m "feat: add atomic daily state"
~~~

---

### Task 3: Schedule policy, lock-state gate, and connectivity

**Files:**
- Create: <code>src/schedule-policy.mjs</code>
- Create: <code>src/session-guard.mjs</code>
- Create: <code>src/connectivity.mjs</code>
- Create: <code>tests/schedule-policy.test.mjs</code>
- Create: <code>tests/session-guard.test.mjs</code>

**Interfaces:**
- Consumes: <code>beijingClock()</code>, <code>DailyState</code>
- Produces: <code>decideRun(input) -&gt; RunDecision</code>
- Produces: <code>isSessionUnlocked(execFile?) -&gt; Promise&lt;boolean&gt;</code>
- Produces: <code>canReachTarget(url, timeoutMs) -&gt; Promise&lt;boolean&gt;</code>

- [ ] **Step 1: Write the policy matrix as failing tests**

~~~js
import { describe, expect, it } from "vitest";
import { decideRun } from "../src/schedule-policy.mjs";

const base = { minuteOfDay: 800, state: null, unlocked: true, online: true };

describe("decideRun", () => {
  it("runs a primary trigger inside its selected window", () => {
    expect(decideRun({ ...base, trigger: "primary", minuteOfDay: 665 })).toEqual({ action: "RUN" });
  });

  it("marks a locked primary trigger due", () => {
    expect(decideRun({ ...base, trigger: "primary", unlocked: false })).toEqual({ action: "MARK_DUE" });
  });

  it("skips catch-up before 12:30 without a due marker", () => {
    expect(decideRun({ ...base, trigger: "catchup", minuteOfDay: 700 })).toEqual({ action: "SKIP_BEFORE_WINDOW" });
  });

  it("runs catch-up before 12:30 when primary is due", () => {
    expect(decideRun({
      ...base,
      trigger: "catchup",
      minuteOfDay: 700,
      state: { status: "PENDING_DUE" }
    })).toEqual({ action: "RUN" });
  });

  it("runs catch-up after 12:30", () => {
    expect(decideRun({ ...base, trigger: "catchup", minuteOfDay: 900 })).toEqual({ action: "RUN" });
  });

  it.each(["SUCCESS", "BLOCKED_MANUAL"])("skips terminal state %s", (status) => {
    expect(decideRun({ ...base, trigger: "catchup", state: { status } }).action).toBe("SKIP_TERMINAL");
  });
});
~~~

- [ ] **Step 2: Run the policy tests and confirm failure**

Run:

~~~powershell
npx vitest run tests/schedule-policy.test.mjs
~~~

Expected: FAIL because the policy module is absent.

- [ ] **Step 3: Implement the pure policy**

~~~js
// src/schedule-policy.mjs
import { minutes } from "./beijing-time.mjs";

export function decideRun({ trigger, minuteOfDay, state, unlocked, online }) {
  if (state?.status === "SUCCESS" || state?.status === "BLOCKED_MANUAL") {
    return { action: "SKIP_TERMINAL" };
  }
  if (!unlocked) {
    return trigger === "primary" ? { action: "MARK_DUE" } : { action: "SKIP_LOCKED" };
  }
  if (!online) return { action: "SKIP_OFFLINE" };
  if (minuteOfDay < minutes(10, 0)) return { action: "SKIP_BEFORE_WINDOW" };
  if (
    trigger === "catchup" &&
    minuteOfDay < minutes(12, 30) &&
    state?.status !== "PENDING_DUE"
  ) {
    return { action: "SKIP_BEFORE_WINDOW" };
  }
  return { action: "RUN" };
}
~~~

- [ ] **Step 4: Implement session and connectivity adapters**

~~~js
// src/session-guard.mjs
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
const defaultExecFile = promisify(execFileCallback);

export async function isSessionUnlocked(execFile = defaultExecFile) {
  const script = [
    "$sid=(Get-Process -Id $PID).SessionId",
    "$locked=Get-Process -Name LogonUI -ErrorAction SilentlyContinue | Where-Object SessionId -eq $sid",
    "if($locked){'LOCKED'}else{'UNLOCKED'}"
  ].join("; ");
  const result = await execFile("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script
  ], { windowsHide: true, timeout: 5000 });
  return result.stdout.trim() === "UNLOCKED";
}
~~~

~~~js
// src/connectivity.mjs
export async function canReachTarget(url, timeoutMs = 8000, fetchFn = fetch) {
  try {
    await fetchFn(url, {
      method: "HEAD",
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs)
    });
    return true;
  } catch {
    return false;
  }
}
~~~

Tests inject <code>execFile</code> and <code>fetchFn</code>, so no real session change or network request is required.

- [ ] **Step 5: Run policy and adapter tests**

Run:

~~~powershell
npx vitest run tests/schedule-policy.test.mjs tests/session-guard.test.mjs
~~~

Expected: PASS.

- [ ] **Step 6: Commit the gates**

~~~powershell
git add src/schedule-policy.mjs src/session-guard.mjs src/connectivity.mjs tests/schedule-policy.test.mjs tests/session-guard.test.mjs
git commit -m "feat: gate runs by schedule and session"
~~~

---

### Task 4: Passive Edge session, fingerprints, and zero-input enforcement

**Files:**
- Modify: <code>package.json</code>
- Create: <code>src/browser/passive-edge.mjs</code>
- Create: <code>src/browser/fingerprint.mjs</code>
- Create: <code>src/browser/lobby-detector.mjs</code>
- Create: <code>src/cli/setup-session.mjs</code>
- Create: <code>src/cli/verify-session.mjs</code>
- Create: <code>scripts/check-no-input.mjs</code>
- Create: <code>tests/fingerprint.test.mjs</code>
- Create: <code>tests/lobby-detector.test.mjs</code>
- Create: <code>tests/no-input.test.mjs</code>

**Interfaces:**
- Produces: <code>PassiveEdge.open(url) -&gt; Promise&lt;void&gt;</code>
- Produces: <code>PassiveEdge.metadata() -&gt; Promise&lt;PageMetadata&gt;</code>
- Produces: <code>PassiveEdge.frame() -&gt; Promise&lt;Buffer&gt;</code>
- Produces: <code>PassiveEdge.close() -&gt; Promise&lt;void&gt;</code>
- Produces: <code>vectorFromPng(buffer) -&gt; Promise&lt;number[]&gt;</code>
- Produces: <code>medianVector(vectors) -&gt; number[]</code>
- Produces: <code>cosineSimilarity(a, b) -&gt; number</code>
- Produces: <code>detectLobby(session, fingerprint, options) -&gt; Promise&lt;DetectionResult&gt;</code>

- [ ] **Step 1: Write failing fingerprint tests**

~~~js
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { cosineSimilarity, vectorFromPng } from "../src/browser/fingerprint.mjs";

async function image(values) {
  return sharp(Buffer.from(values), {
    raw: { width: 2, height: 2, channels: 1 }
  }).png().toBuffer();
}

describe("fingerprint", () => {
  it("matches the same visual pattern and rejects its inverse", async () => {
    const first = await vectorFromPng(await image([0, 64, 128, 255]));
    const same = await vectorFromPng(await image([0, 64, 128, 255]));
    const inverse = await vectorFromPng(await image([255, 128, 64, 0]));
    expect(cosineSimilarity(first, same)).toBeGreaterThan(0.999);
    expect(cosineSimilarity(first, inverse)).toBeLessThan(0.2);
  });
});
~~~

Add a second test that serializes <code>{ version: 1, width: 32, height: 18, vector }</code> and asserts no PNG signature or base64 field exists.

- [ ] **Step 2: Implement non-reversible frame vectors**

~~~js
// src/browser/fingerprint.mjs
import sharp from "sharp";

export async function vectorFromPng(buffer) {
  const pixels = await sharp(buffer)
    .resize(32, 18, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer();
  const mean = pixels.reduce((sum, value) => sum + value, 0) / pixels.length;
  return [...pixels].map((value) => (value - mean) / 255);
}

export function medianVector(vectors) {
  return vectors[0].map((_, index) => {
    const values = vectors.map((vector) => vector[index]).sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
  });
}

export function cosineSimilarity(left, right) {
  const dot = left.reduce((sum, value, index) => sum + value * right[index], 0);
  const leftNorm = Math.sqrt(left.reduce((sum, value) => sum + value * value, 0));
  const rightNorm = Math.sqrt(right.reduce((sum, value) => sum + value * value, 0));
  return leftNorm && rightNorm ? dot / (leftNorm * rightNorm) : 0;
}
~~~

Build the setup fingerprint from the per-position median of three frames. Store no PNG or base64 image.

- [ ] **Step 3: Write failing passive-detection tests**

Use a fake session exposing only <code>metadata()</code> and <code>frame()</code>:

~~~js
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { detectLobby } from "../src/browser/lobby-detector.mjs";
import { vectorFromPng } from "../src/browser/fingerprint.mjs";

describe("detectLobby", () => {
  it("stops immediately for an accessible login marker", async () => {
    const session = {
      metadata: async () => ({ title: "雀魂", text: "登录" }),
      frame: async () => { throw new Error("frame must not be read"); }
    };
    await expect(detectLobby(session, { vector: [] })).resolves.toEqual({
      status: "MANUAL_ACTION_REQUIRED"
    });
  });

  it("requires three consecutive lobby matches", async () => {
    const png = await sharp(Buffer.from([0, 64, 128, 255]), {
      raw: { width: 2, height: 2, channels: 1 }
    }).png().toBuffer();
    const vector = await vectorFromPng(png);
    let time = 0;
    const session = {
      metadata: async () => ({ title: "雀魂", text: "" }),
      frame: async () => png
    };
    const result = await detectLobby(session, { vector }, {
      now: () => time,
      sleep: async (ms) => { time += ms; },
      intervalMs: 1,
      timeoutMs: 10000
    });
    expect(result.status).toBe("SUCCESS");
  });
});
~~~

Also cover:

- three consecutive similarities at or above 0.92 return <code>{ status: "SUCCESS" }</code>;
- accessible text matching login, verification, confirm, or captcha markers returns <code>{ status: "MANUAL_ACTION_REQUIRED" }</code>;
- no match before the injected deadline returns <code>{ status: "LOBBY_TIMEOUT" }</code>;
- the detector never calls a property named click, keyboard, mouse, fill, press, type, tap, or dispatchEvent.

- [ ] **Step 4: Implement the passive Edge wrapper**

~~~js
// src/browser/passive-edge.mjs
import { chromium } from "playwright-core";

export class PassiveEdge {
  #context;
  #page;

  constructor({ profileDir, headless = true, browser = chromium }) {
    this.profileDir = profileDir;
    this.headless = headless;
    this.browser = browser;
  }

  async open(url) {
    this.#context = await this.browser.launchPersistentContext(this.profileDir, {
      channel: "msedge",
      headless: this.headless,
      viewport: { width: 1440, height: 900 }
    });
    this.#page = this.#context.pages()[0] || await this.#context.newPage();
    await this.#page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  }

  async metadata() {
    return {
      url: this.#page.url(),
      title: await this.#page.title(),
      text: await this.#page.locator("body").innerText({ timeout: 3000 }).catch(() => "")
    };
  }

  async frame() {
    return this.#page.screenshot({ type: "png" });
  }

  async close() {
    await this.#context?.close();
  }
}
~~~

~~~js
// src/browser/lobby-detector.mjs
import { cosineSimilarity, medianVector, vectorFromPng } from "./fingerprint.mjs";

const manualPattern = /(登录|登入|驗證|验证|確認|确认|captcha|sign in)/i;

export async function detectLobby(session, fingerprint, options = {}) {
  const timeoutMs = options.timeoutMs ?? 180000;
  const intervalMs = options.intervalMs ?? 5000;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const startedAt = now();
  let consecutive = 0;

  while (now() - startedAt < timeoutMs) {
    const metadata = await session.metadata();
    if (manualPattern.test(metadata.title + "\n" + metadata.text)) {
      return { status: "MANUAL_ACTION_REQUIRED" };
    }
    const frames = [];
    for (let index = 0; index < 3; index += 1) {
      frames.push(await vectorFromPng(await session.frame()));
      if (index < 2) await sleep(500);
    }
    const similarity = cosineSimilarity(medianVector(frames), fingerprint.vector);
    consecutive = similarity >= 0.92 ? consecutive + 1 : 0;
    if (consecutive >= 3) return { status: "SUCCESS", similarity };
    await sleep(intervalMs);
  }
  return { status: "LOBBY_TIMEOUT" };
}
~~~

- [ ] **Step 5: Add a repository-level input API guard**

~~~js
// scripts/check-no-input.mjs
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const forbidden = [
  /\.(click|dblclick|tap|press|type|fill|dispatchEvent)\s*\(/,
  /\.(mouse|keyboard|touchscreen)\b/
];

async function files(root) {
  const output = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...await files(full));
    if (entry.isFile() && entry.name.endsWith(".mjs")) output.push(full);
  }
  return output;
}

const violations = [];
for (const file of await files("src")) {
  const content = await readFile(file, "utf8");
  for (const pattern of forbidden) {
    if (pattern.test(content)) violations.push(file + " matches " + pattern);
  }
}
if (violations.length) {
  console.error(violations.join("\n"));
  process.exit(1);
}
console.log("No synthetic input APIs found.");
~~~

Update <code>package.json</code> scripts to add <code>check:no-input</code> and change <code>verify</code> to <code>npm test &amp;&amp; npm run check:no-input</code>.

- [ ] **Step 6: Implement visible setup without automated interaction**

~~~js
// central flow in src/cli/setup-session.mjs
const session = new PassiveEdge({ profileDir: paths.profile, headless: false });
await session.open(TARGET_URL);
await question("请手动完成登录并进入大厅，确认后回到终端按 Enter。");
const vectors = [];
for (let index = 0; index < 3; index += 1) {
  vectors.push(await vectorFromPng(await session.frame()));
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
await writeFile(paths.fingerprint, JSON.stringify({
  version: 1,
  width: 32,
  height: 18,
  vector: medianVector(vectors)
}) + "\n", "utf8");
await session.close();
~~~

Then invoke <code>verify-session.mjs</code>. That CLI launches a fresh <code>PassiveEdge</code> with <code>headless: true</code>, loads the stored fingerprint, runs <code>detectLobby()</code>, prints only the final status and similarity, and exits 0 only for <code>SUCCESS</code>. The setup file imports <code>question</code> from <code>readline/promises</code>, <code>writeFile</code> from <code>node:fs/promises</code>, and the exact modules defined earlier. Neither CLI may call an input API.

- [ ] **Step 7: Run browser unit tests and the input guard**

Run:

~~~powershell
npx vitest run tests/fingerprint.test.mjs tests/lobby-detector.test.mjs tests/no-input.test.mjs
npm run check:no-input
~~~

Expected: all tests PASS and output contains <code>No synthetic input APIs found.</code>

- [ ] **Step 8: Commit passive browsing**

~~~powershell
git add package.json src/browser src/cli/setup-session.mjs src/cli/verify-session.mjs scripts/check-no-input.mjs tests/fingerprint.test.mjs tests/lobby-detector.test.mjs tests/no-input.test.mjs
git commit -m "feat: add passive Edge lobby detection"
~~~

---

### Task 5: Windows Credential Manager and text-only Gmail

**Files:**
- Create: <code>src/credentials.mjs</code>
- Create: <code>src/notifier.mjs</code>
- Create: <code>src/cli/configure-gmail.mjs</code>
- Create: <code>tests/credentials.test.mjs</code>
- Create: <code>tests/notifier.test.mjs</code>

**Interfaces:**
- Produces: <code>credentialStore(EntryType?) -&gt; { set(account, password), get(account), delete(account) }</code>
- Produces: <code>sendFailureMail(config, failure, dependencies) -&gt; Promise&lt;void&gt;</code>

- [ ] **Step 1: Write failing credential adapter tests**

~~~js
import { describe, expect, it, vi } from "vitest";
import { credentialStore } from "../src/credentials.mjs";

describe("credentialStore", () => {
  it("uses the fixed service and supplied Gmail account", () => {
    const calls = [];
    class FakeEntry {
      constructor(service, account) { calls.push(["construct", service, account]); }
      setPassword(value) { calls.push(["set", value]); }
      getPassword() { return "app-secret"; }
      deletePassword() { calls.push(["delete"]); }
    }
    const store = credentialStore(FakeEntry);
    store.set("person@example.com", "app-secret");
    expect(store.get("person@example.com")).toBe("app-secret");
    store.delete("person@example.com");
    expect(calls[0]).toEqual(["construct", "MajSoulDaily.Gmail", "person@example.com"]);
  });
});
~~~

Spy on <code>console.log</code> and <code>console.error</code> and assert neither receives <code>app-secret</code>.

- [ ] **Step 2: Implement the keyring adapter**

~~~js
// src/credentials.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { Entry } = require("@napi-rs/keyring");
const SERVICE = "MajSoulDaily.Gmail";

export function credentialStore(EntryType = Entry) {
  return {
    set(account, password) {
      new EntryType(SERVICE, account).setPassword(password);
    },
    get(account) {
      return new EntryType(SERVICE, account).getPassword();
    },
    delete(account) {
      return new EntryType(SERVICE, account).deletePassword();
    }
  };
}
~~~

- [ ] **Step 3: Write failing notifier tests**

~~~js
import { describe, expect, it, vi } from "vitest";
import { sendFailureMail } from "../src/notifier.mjs";

describe("sendFailureMail", () => {
  it("sends one plain-text Gmail message without attachments", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "test" });
    const createTransport = vi.fn(() => ({ sendMail }));
    await sendFailureMail(
      { sender: "sender@example.com", recipient: "recipient@example.com" },
      {
        dateKey: "2026-07-16",
        time: "2026-07-16T04:30:00.000Z",
        kind: "LOBBY_TIMEOUT",
        phase: "lobby-detection",
        attempts: 2,
        action: "请手动检查登录状态",
        logPath: "%LOCALAPPDATA%\\MajSoulDaily\\logs"
      },
      { createTransport, store: { get: () => "app-secret" } }
    );
    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({
      host: "smtp.gmail.com",
      port: 465,
      secure: true
    }));
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("LOBBY_TIMEOUT")
    }));
    expect(sendMail.mock.calls[0][0]).not.toHaveProperty("html");
    expect(sendMail.mock.calls[0][0]).not.toHaveProperty("attachments");
  });
});
~~~

Add assertions that:

- SMTP host is <code>smtp.gmail.com</code>, port 465, secure true;
- subject contains the local date key and failure class;
- body contains time, machine, phase, attempts, action, and local log path;
- body contains no screenshot, Cookie, Local Storage, secret, or page HTML;
- identical <code>failureFingerprint</code> is deduplicated per local day by the Task 6 outbox (sender itself is one-shot).

- [ ] **Step 4: Implement text-only Gmail**

~~~js
// src/notifier.mjs
import os from "node:os";
import nodemailer from "nodemailer";
import { credentialStore } from "./credentials.mjs";

export async function sendFailureMail(config, failure, dependencies = {}) {
  const store = dependencies.store ?? credentialStore();
  const createTransport = dependencies.createTransport ?? nodemailer.createTransport;
  const password = store.get(config.sender);
  if (!password) {
    const error = new Error("Gmail credential is missing.");
    error.code = "GMAIL_CREDENTIAL_MISSING";
    throw error;
  }
  const transport = createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: config.sender, pass: password }
  });
  const text = [
    "发生时间：" + failure.time,
    "设备名称：" + os.hostname(),
    "失败类型：" + failure.kind,
    "当前阶段：" + failure.phase,
    "执行次数：" + failure.attempts,
    "建议操作：" + failure.action,
    "本地日志：" + failure.logPath
  ].join("\n");
  await transport.sendMail({
    from: config.sender,
    to: config.recipient,
    subject: "MajSoulDaily " + failure.dateKey + " " + failure.kind,
    text
  });
}
~~~

Read the Gmail app password only inside this function. Build no <code>html</code> or <code>attachments</code>. The orchestrator updates <code>notificationFingerprints</code> in the daily state only after <code>sendFailureMail()</code> resolves.

- [ ] **Step 5: Add the local configuration CLI**

~~~js
// central flow in src/cli/configure-gmail.mjs
const sender = (await rl.question("Gmail 发件地址：")).trim();
const recipient = (await rl.question("失败通知收件地址：")).trim();
const password = await readMaskedSecret("Gmail 应用专用密码：");
credentialStore().set(sender, password);
await mkdir(paths.root, { recursive: true });
await writeFile(paths.config, JSON.stringify({ sender, recipient }, null, 2) + "\n", "utf8");
await sendFailureMail({ sender, recipient }, {
  dateKey: beijingClock().dateKey,
  time: beijingClock().iso,
  kind: "CONFIG_TEST",
  phase: "gmail-setup",
  attempts: 1,
  action: "无需操作",
  logPath: paths.logs
});
~~~

Implement <code>readMaskedSecret()</code> with raw terminal mode: accept printable characters, remove the previous character on backspace, resolve on Enter, restore the original terminal mode in <code>finally</code>, and never echo the password. The test injects keypresses rather than reading the real terminal.

- [ ] **Step 6: Run credential and mail tests**

Run:

~~~powershell
npx vitest run tests/credentials.test.mjs tests/notifier.test.mjs
~~~

Expected: PASS.

- [ ] **Step 7: Commit notification support**

~~~powershell
git add src/credentials.mjs src/notifier.mjs src/cli/configure-gmail.mjs tests/credentials.test.mjs tests/notifier.test.mjs
git commit -m "feat: add private Gmail failure alerts"
~~~

---

### Task 6: Daily orchestration and repair flow

**Files:**
- Create: <code>src/daily-run.mjs</code>
- Create: <code>src/production-dependencies.mjs</code>
- Create: <code>src/cli/run.mjs</code>
- Create: <code>src/cli/repair-session.mjs</code>
- Create: <code>src/logger.mjs</code>
- Create: <code>tests/daily-run.test.mjs</code>
- Create: <code>tests/logger.test.mjs</code>

**Interfaces:**
- Consumes: all prior adapters
- Produces: <code>runDaily({ trigger, now, dependencies }) -&gt; Promise&lt;RunResult&gt;</code>
- Produces: CLI exit codes 0 for success/intentional skip, 2 for transient failure, 3 for manual block

- [ ] **Step 1: Write the orchestration tests before implementation**

Start with this dependency factory:

~~~js
import { expect, it, vi } from "vitest";
import { runDaily } from "../src/daily-run.mjs";

function makeDependencies(overrides = {}) {
  const stateWrites = [];
  const session = {
    open: vi.fn(),
    close: vi.fn(),
    metadata: vi.fn(),
    frame: vi.fn()
  };
  return {
    stateWrites,
    session,
    value: {
      targetUrl: "https://game.maj-soul.com/1/",
      clock: () => ({ dateKey: "2026-07-16", minuteOfDay: 800, iso: "2026-07-16T04:30:00.000Z" }),
      readState: vi.fn().mockResolvedValue(null),
      writeState: vi.fn(async (_date, state) => stateWrites.push(state)),
      isSessionUnlocked: vi.fn().mockResolvedValue(true),
      canReachTarget: vi.fn().mockResolvedValue(true),
      decideRun: vi.fn().mockReturnValue({ action: "RUN" }),
      withRunLock: async (callback) => callback(),
      createSession: () => session,
      detectLobby: vi.fn().mockResolvedValue({ status: "SUCCESS" }),
      notifyOnce: vi.fn(),
      ...overrides
    }
  };
}

it("writes SUCCESS and sends no email", async () => {
  const deps = makeDependencies();
  await expect(runDaily({ trigger: "primary", dependencies: deps.value }))
    .resolves.toEqual({ status: "SUCCESS" });
  expect(deps.stateWrites.at(-1).status).toBe("SUCCESS");
  expect(deps.value.notifyOnce).not.toHaveBeenCalled();
  expect(deps.session.close).toHaveBeenCalledOnce();
});
~~~

Use the same factory to cover these exact scenarios:

1. <code>SUCCESS</code> state never launches Edge.
2. Locked primary writes <code>PENDING_DUE</code> and exits.
3. Catch-up before 12:30 runs only when state is <code>PENDING_DUE</code>.
4. Browser success writes <code>SUCCESS</code>, closes Edge, and sends no email.
5. Manual-action detection writes <code>BLOCKED_MANUAL</code>, closes Edge, and sends one text email.
6. Edge crash retries once in the same process, then writes <code>FAILED_TRANSIENT</code>.
7. Every path closes Edge and releases the run lock in <code>finally</code>.
8. Logs redact values matching email addresses, Cookie headers, authorization headers, and keyring values.

- [ ] **Step 2: Run the focused suite and confirm failure**

Run:

~~~powershell
npx vitest run tests/daily-run.test.mjs tests/logger.test.mjs
~~~

Expected: FAIL with missing modules.

- [ ] **Step 3: Implement the orchestrator in one direction**

The function order must be:

~~~text
clock
  -> read state
  -> session and connectivity gates
  -> acquire lock
  -> write RUNNING
  -> open passive Edge
  -> detect lobby
  -> write SUCCESS, FAILED_TRANSIENT, or BLOCKED_MANUAL
  -> optionally send one Gmail
  -> close Edge
  -> release lock
~~~

~~~js
// core shape in src/daily-run.mjs
export async function runDaily({ trigger, now = new Date(), dependencies }) {
  const clock = dependencies.clock(now);
  const state = await dependencies.readState(clock.dateKey);
  const unlocked = await dependencies.isSessionUnlocked();
  const online = await dependencies.canReachTarget();
  const decision = dependencies.decideRun({
    trigger,
    minuteOfDay: clock.minuteOfDay,
    state,
    unlocked,
    online
  });

  if (decision.action === "MARK_DUE") {
    await dependencies.writeState(clock.dateKey, { status: "PENDING_DUE" });
    return { status: "PENDING_DUE" };
  }
  if (decision.action !== "RUN") return { status: decision.action };

  return dependencies.withRunLock(async () => {
    await dependencies.writeState(clock.dateKey, { status: "RUNNING", attempts: 0 });
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const session = dependencies.createSession();
      try {
        await session.open(dependencies.targetUrl);
        const result = await dependencies.detectLobby(session);
        if (result.status === "SUCCESS") {
          await dependencies.writeState(clock.dateKey, { status: "SUCCESS", attempts: attempt });
          return { status: "SUCCESS" };
        }
        if (result.status === "MANUAL_ACTION_REQUIRED") {
          const blocked = { status: "BLOCKED_MANUAL", attempts: attempt, failure: result.status };
          await dependencies.writeState(clock.dateKey, blocked);
          await dependencies.notifyOnce(clock, blocked);
          return { status: "BLOCKED_MANUAL" };
        }
        lastError = new Error(result.status);
        lastError.code = result.status;
      } catch (error) {
        lastError = error;
      } finally {
        await session.close().catch(() => undefined);
      }
    }
    const failed = {
      status: "FAILED_TRANSIENT",
      attempts: 2,
      failure: lastError?.code || "EDGE_FAILURE"
    };
    await dependencies.writeState(clock.dateKey, failed);
    await dependencies.notifyOnce(clock, failed);
    return { status: "FAILED_TRANSIENT" };
  });
}
~~~

The production dependency builder binds <code>readState</code>, <code>writeState</code>, <code>withRunLock</code>, <code>PassiveEdge</code>, <code>detectLobby</code>, and <code>sendFailureMail</code> to the paths and config defined earlier. Do not pass the raw Playwright page outside <code>PassiveEdge</code>. Do not log metadata text or frame buffers.

- [ ] **Step 4: Implement the scheduled CLI**

~~~js
// src/cli/run.mjs
import { runDaily } from "../daily-run.mjs";
import { productionDependencies } from "../production-dependencies.mjs";

const index = process.argv.indexOf("--trigger");
const trigger = index >= 0 ? process.argv[index + 1] : "";
if (!["primary", "catchup"].includes(trigger)) {
  console.error("Expected --trigger primary or --trigger catchup.");
  process.exit(64);
}
const result = await runDaily({ trigger, dependencies: productionDependencies() });
if (result.status === "BLOCKED_MANUAL") process.exitCode = 3;
else if (result.status === "FAILED_TRANSIENT") process.exitCode = 2;
else process.exitCode = 0;
~~~

Add <code>src/production-dependencies.mjs</code> to this task's file list. It must construct adapters without printing configuration or credential objects.

- [ ] **Step 5: Implement manual repair**

~~~js
// central state transition in src/cli/repair-session.mjs
const clock = beijingClock();
const previous = await readState(clock.dateKey, paths);
await runVisibleSetup();
await clearBlockedState(clock.dateKey, paths);
const result = await runDaily({
  trigger: "catchup",
  dependencies: productionDependencies()
});
if (result.status !== "SUCCESS") {
  await writeState(clock.dateKey, {
    status: "BLOCKED_MANUAL",
    repairFailedAt: new Date().toISOString(),
    previousStatus: previous?.status || null
  }, paths);
  process.exitCode = 3;
}
~~~

- [ ] **Step 6: Add 14-day log retention**

~~~js
// retention core in src/logger.mjs
export async function pruneLogs(paths, keepDateKeys) {
  await mkdir(paths.logs, { recursive: true });
  const root = path.resolve(paths.logs) + path.sep;
  for (const name of await readdir(paths.logs)) {
    const match = /^(\d{4}-\d{2}-\d{2})\.log$/.exec(name);
    if (!match || keepDateKeys.has(match[1])) continue;
    const target = path.resolve(paths.logs, name);
    if (!target.startsWith(root)) throw new Error("Refusing to delete outside logs.");
    await rm(target, { force: true });
  }
}
~~~

On every CLI start, compute the latest 14 local date keys and pass them as <code>keepDateKeys</code>. The logger writes one JSON object per line after redacting email addresses, authorization values, Cookie values, and known keyring secrets.

- [ ] **Step 7: Run orchestration and full tests**

Run:

~~~powershell
npx vitest run tests/daily-run.test.mjs tests/logger.test.mjs
npm test
npm run check:no-input
~~~

Expected: PASS.

- [ ] **Step 8: Commit the runnable core**

~~~powershell
git add src/daily-run.mjs src/production-dependencies.mjs src/logger.mjs src/cli/run.mjs src/cli/repair-session.mjs tests/daily-run.test.mjs tests/logger.test.mjs
git commit -m "feat: orchestrate silent daily runs"
~~~

---

### Task 7: Windows Task Scheduler installation and removal

**Files:**
- Create: <code>scripts/render-task-xml.ps1</code>
- Create: <code>scripts/install.ps1</code>
- Create: <code>scripts/uninstall.ps1</code>
- Create: <code>src/cli/delete-gmail-secret.mjs</code>
- Create: <code>tests/task-xml.test.mjs</code>

**Interfaces:**
- Produces: task <code>MajSoulDaily-Primary</code>
- Produces: task <code>MajSoulDaily-Catchup</code>
- Produces: <code>render-task-xml.ps1 -Mode Primary|Catchup -NodePath ... -RunnerPath ... -UserId ...</code>

- [ ] **Step 1: Write XML contract tests**

~~~js
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function render(mode) {
  return execFileSync("powershell.exe", [
    "-NoProfile",
    "-File",
    "scripts/render-task-xml.ps1",
    "-Mode", mode,
    "-NodePath", "C:\\Program Files\\nodejs\\node.exe",
    "-RunnerPath", "D:\\repo\\src\\cli\\run.mjs",
    "-UserId", "TEST\\user"
  ], { encoding: "utf8" });
}

describe("task XML", () => {
  it("renders the random primary trigger", () => {
    const xml = render("Primary");
    expect(xml).toContain("<RandomDelay>PT2H30M</RandomDelay>");
    expect(xml).toContain("--trigger primary");
    expect(xml).toContain("<WakeToRun>false</WakeToRun>");
  });

  it("renders unlock and repeated catch-up triggers", () => {
    const xml = render("Catchup");
    expect(xml).toContain("<StateChange>SessionUnlock</StateChange>");
    expect(xml).toContain("<Interval>PT15M</Interval>");
    expect(xml).toContain("<Duration>PT11H15M</Duration>");
    expect(xml).toContain("--trigger catchup");
  });
});
~~~

Extend the assertions to confirm:

- Primary XML contains a daily 10:00 calendar trigger and <code>PT2H30M</code> random delay.
- Primary action contains <code>--trigger primary</code>.
- Catch-up XML contains logon, session unlock, and daily 12:30 triggers.
- Catch-up repetition is <code>PT15M</code> for <code>PT11H15M</code>.
- Catch-up action contains <code>--trigger catchup</code>.
- Both contain <code>StartWhenAvailable=true</code>, <code>RunOnlyIfNetworkAvailable=true</code>, <code>WakeToRun=false</code>, <code>Priority=8</code>, <code>IgnoreNew</code>, <code>ExecutionTimeLimit=PT10M</code>, <code>Hidden=true</code>, and <code>InteractiveToken</code>.

- [ ] **Step 2: Run the XML tests and confirm failure**

Run:

~~~powershell
npx vitest run tests/task-xml.test.mjs
~~~

Expected: FAIL because the renderer is absent.

- [ ] **Step 3: Implement deterministic task XML**

~~~powershell
# scripts/render-task-xml.ps1
param(
  [Parameter(Mandatory=$true)][ValidateSet("Primary","Catchup")][string]$Mode,
  [Parameter(Mandatory=$true)][string]$NodePath,
  [Parameter(Mandatory=$true)][string]$RunnerPath,
  [Parameter(Mandatory=$true)][string]$UserId
)
$esc = [System.Security.SecurityElement]
$user = $esc::Escape($UserId)
$command = $esc::Escape($NodePath)
$triggerName = $Mode.ToLowerInvariant()
$arguments = $esc::Escape(('"' + $RunnerPath + '" --trigger ' + $triggerName))
$triggers = if ($Mode -eq "Primary") {
@"
<CalendarTrigger>
  <StartBoundary>2026-01-01T10:00:00</StartBoundary>
  <Enabled>true</Enabled>
  <RandomDelay>PT2H30M</RandomDelay>
  <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>
</CalendarTrigger>
"@
} else {
@"
<LogonTrigger><Enabled>true</Enabled><UserId>$user</UserId></LogonTrigger>
<SessionStateChangeTrigger>
  <Enabled>true</Enabled><UserId>$user</UserId><StateChange>SessionUnlock</StateChange>
</SessionStateChangeTrigger>
<CalendarTrigger>
  <StartBoundary>2026-01-01T12:30:00</StartBoundary>
  <Enabled>true</Enabled>
  <Repetition><Interval>PT15M</Interval><Duration>PT11H15M</Duration><StopAtDurationEnd>true</StopAtDurationEnd></Repetition>
  <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>
</CalendarTrigger>
"@
}
@"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>$triggers</Triggers>
  <Principals><Principal id="Author"><UserId>$user</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>
    <Priority>8</Priority>
  </Settings>
  <Actions Context="Author"><Exec><Command>$command</Command><Arguments>$arguments</Arguments></Exec></Actions>
</Task>
"@
~~~

This uses Task Scheduler schema 1.4. Personal paths exist only in the locally registered task XML and never in a tracked generated file.

- [ ] **Step 4: Implement install.ps1**

The installer must:

1. Require Windows and PowerShell 5.1 or newer.
2. Resolve <code>node.exe</code>, <code>msedge.exe</code>, and the repository root.
3. Run <code>npm ci</code>, <code>npm run verify</code>, and a visible setup-session compatibility check.
4. Refuse registration unless three headless lobby checks pass.
5. Render XML using the current Windows identity.
6. Register both tasks with <code>Register-ScheduledTask -Force</code>.
7. Read both registered definitions back and verify all XML contract values.
8. Print task names and the next primary run time without printing user paths or email addresses.

~~~powershell
# central flow in scripts/install.ps1
param([switch]$DryRun)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node.exe -ErrorAction Stop).Source
$runner = Join-Path $root "src\cli\run.mjs"
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
Push-Location $root
try {
& npm ci
if ($LASTEXITCODE) { throw "npm ci failed." }
& npm run verify
if ($LASTEXITCODE) { throw "Verification failed." }
& $node (Join-Path $root "src\cli\configure-gmail.mjs")
if ($LASTEXITCODE) { throw "Gmail configuration failed." }
& $node (Join-Path $root "src\cli\setup-session.mjs")
if ($LASTEXITCODE) { throw "Visible session setup failed." }
1..3 | ForEach-Object {
  & $node (Join-Path $root "src\cli\verify-session.mjs")
  if ($LASTEXITCODE) { throw "Headless lobby verification failed." }
}
$primary = & (Join-Path $PSScriptRoot "render-task-xml.ps1") -Mode Primary -NodePath $node -RunnerPath $runner -UserId $user
$catchup = & (Join-Path $PSScriptRoot "render-task-xml.ps1") -Mode Catchup -NodePath $node -RunnerPath $runner -UserId $user
if (-not $DryRun) {
  Register-ScheduledTask -TaskName "MajSoulDaily-Primary" -Xml $primary -Force | Out-Null
  Register-ScheduledTask -TaskName "MajSoulDaily-Catchup" -Xml $catchup -Force | Out-Null
}
Write-Host "Validated tasks: MajSoulDaily-Primary, MajSoulDaily-Catchup"
} finally {
  Pop-Location
}
~~~

After registration, export both tasks with <code>Export-ScheduledTask</code> and assert the same XML values used by <code>tests/task-xml.test.mjs</code>.

- [ ] **Step 5: Implement uninstall.ps1**

~~~powershell
param([switch]$DeleteProfile)
$ErrorActionPreference = "Stop"
"MajSoulDaily-Primary","MajSoulDaily-Catchup" | ForEach-Object {
  Unregister-ScheduledTask -TaskName $_ -Confirm:$false -ErrorAction SilentlyContinue
}
& node (Join-Path $PSScriptRoot "..\src\cli\delete-gmail-secret.mjs")
$root = Join-Path $env:LOCALAPPDATA "MajSoulDaily"
$allowedRoot = [IO.Path]::GetFullPath($root).TrimEnd("\") + "\"
function Remove-AppDirectory([string]$Path) {
  $resolved = [IO.Path]::GetFullPath($Path)
  if (-not $resolved.StartsWith($allowedRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to delete outside MajSoulDaily."
  }
  Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
}
Remove-AppDirectory (Join-Path $root "state")
Remove-AppDirectory (Join-Path $root "logs")
if ($DeleteProfile) {
  Remove-AppDirectory (Join-Path $root "edge-profile")
}
~~~

Add <code>src/cli/delete-gmail-secret.mjs</code> to this task. Without <code>-DeleteProfile</code>, prompt the user once and preserve the profile unless they answer yes.

- [ ] **Step 6: Run XML tests and a non-registering dry run**

Run:

~~~powershell
npx vitest run tests/task-xml.test.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install.ps1 -DryRun
~~~

Expected: tests PASS; dry run prints both task names and reports that no task was registered.

- [ ] **Step 7: Commit scheduler integration**

~~~powershell
git add scripts/render-task-xml.ps1 scripts/install.ps1 scripts/uninstall.ps1 src/cli/delete-gmail-secret.mjs tests/task-xml.test.mjs
git commit -m "feat: register safe Windows schedules"
~~~

---

### Task 8: Privacy validation, documentation, and live acceptance gate

**Files:**
- Modify: <code>package.json</code>
- Create: <code>scripts/check-privacy.mjs</code>
- Create: <code>tests/fixtures/automatic-lobby.html</code>
- Create: <code>tests/fixtures/manual-action.html</code>
- Create: <code>tests/privacy.test.mjs</code>
- Modify: <code>README.md</code>
- Modify: <code>docs/superpowers/specs/2026-07-16-majsoul-windows-daily-login-design.md</code>

**Interfaces:**
- Produces: <code>npm run verify</code> as the single deterministic pre-commit check
- Produces: an explicit compatibility report under <code>%LOCALAPPDATA%\MajSoulDaily\logs</code>, never in Git

- [ ] **Step 1: Add a privacy scanner test**

Add <code>check:privacy</code> to <code>package.json</code> and change <code>verify</code> to run tests, the input guard, and the privacy scanner. Scan tracked source and documentation while excluding <code>.git</code>, <code>node_modules</code>, and the scanner's own pattern table. Fail on:

- absolute Windows, macOS, or Linux user-profile paths;
- personal email addresses outside test fixtures using <code>example.com</code>;
- GitHub tokens, AWS keys, private-key headers, authorization headers, Cookie assignments, and non-example passwords;
- browser profile files such as Cookies, Login Data, Local State, Web Data, and History;
- PNG, JPG, JPEG, WEBP, or screenshot artifacts.

~~~js
// central checks in scripts/check-privacy.mjs
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean)
  .filter((file) => file !== "scripts/check-privacy.mjs");
const contentPatterns = [
  /[A-Za-z]:[\\/]+Users[\\/]+[^%<\s]+/i,
  /\/(?:Users|home)\/[^/<\s]+/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bAKIA[A-Z0-9]{16}\b/,
  /BEGIN [A-Z ]*PRIVATE KEY/,
  /(?:authorization|cookie)\s*[:=]\s*\S+/i
];
const forbiddenNames = /(?:Cookies|Login Data|Local State|Web Data|History|screenshot|\.(?:png|jpe?g|webp))$/i;
const violations = [];
for (const file of tracked) {
  if (forbiddenNames.test(file)) violations.push(file + ": forbidden tracked artifact");
  const text = await readFile(file, "utf8").catch(() => "");
  const emails = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  for (const email of emails) {
    if (!email.toLowerCase().endsWith("@example.com")) {
      violations.push(file + ": personal email address");
    }
  }
  for (const pattern of contentPatterns) {
    if (pattern.test(text)) violations.push(file + ": matches " + pattern);
  }
}
if (violations.length) {
  console.error(violations.join("\n"));
  process.exit(1);
}
console.log("Privacy scan passed.");
~~~

- [ ] **Step 2: Add local fixture integration tests**

The automatic fixture must include counters without external assets:

~~~html
<!doctype html>
<meta charset="utf-8">
<title>雀魂大厅测试</title>
<body>
  <main id="lobby">大厅</main>
  <output id="events">0</output>
  <script>
    let events = 0;
    for (const name of ["click", "keydown", "pointerdown", "input", "submit"]) {
      addEventListener(name, () => {
        events += 1;
        document.querySelector("#events").textContent = String(events);
      }, true);
    }
  </script>
</body>
~~~

The manual fixture replaces the main element with <code>&lt;button&gt;登录&lt;/button&gt;</code>. Serve both with a Node <code>http.createServer()</code> in the test. Verify the passive browser class reaches <code>SUCCESS</code> for the automatic fixture and <code>MANUAL_ACTION_REQUIRED</code> for the manual fixture, then read metadata and assert the event counter remains <code>0</code>.

- [ ] **Step 3: Run deterministic verification**

Run:

~~~powershell
npm run verify
git diff --check
git status --short
~~~

Expected: all tests and both safety scanners PASS; only task-owned documentation changes remain before commit.

- [ ] **Step 4: Run the live compatibility gate manually**

Run:

~~~powershell
node src/cli/setup-session.mjs
node src/cli/configure-gmail.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install.ps1 -DryRun
~~~

Expected:

- the user manually logs in and confirms the lobby;
- no scheduled code generates input;
- three headless checks identify the lobby;
- the Gmail test message arrives;
- the installer dry run verifies both task definitions.

If any item fails, stop before task registration and record the exact blocker in the local log.

- [ ] **Step 5: Register and test the real tasks**

Run:

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install.ps1
Start-ScheduledTask -TaskName MajSoulDaily-Primary
Get-ScheduledTaskInfo -TaskName MajSoulDaily-Primary
~~~

Expected: task is registered, a manual task invocation completes within ten minutes, today becomes <code>SUCCESS</code>, and a second invocation exits without opening Edge.

- [ ] **Step 6: Exercise lock, offline, and manual-action acceptance**

1. Lock Windows before a primary test and confirm state becomes <code>PENDING_DUE</code> with no Edge process.
2. Unlock while online and confirm catch-up runs.
3. Disable networking, trigger catch-up, re-enable networking, and confirm a later catch-up runs.
4. Replace the target only in a test configuration with the manual fixture and confirm one text-only Gmail arrives.
5. Inspect Task Scheduler History, local state, logs, and Gmail for credentials or screenshots; none may appear.

- [ ] **Step 7: Update README only with verified commands**

Change the status badge from <code>Pre-implementation</code> only after the full acceptance gate passes. Add the exact install, repair, status, and uninstall commands actually executed. Keep unverified fallback behavior out of the README.

- [ ] **Step 8: Final verification and commit**

Run:

~~~powershell
npm run verify
python "$env:CODEX_HOME\skills\readme-craft\scripts\validate_readme.py" .
git diff --check
git status --short
~~~

Expected: all checks PASS and the worktree contains only intended files.

Commit:

~~~powershell
git add package.json README.md docs/superpowers/specs scripts/check-privacy.mjs tests
git commit -m "docs: verify Windows daily opener"
~~~

---

## Plan Self-Review Checklist

- [x] Every design requirement maps to at least one task and one test.
- [x] Scheduled source has a static ban on input APIs.
- [x] Primary and catch-up triggers are separate, so pre-12:30 logon cannot bypass the random primary time.
- [x] Locked primary execution records <code>PENDING_DUE</code>.
- [x] Manual repair is the only path that clears <code>BLOCKED_MANUAL</code>.
- [x] No raw page frame reaches disk, logs, state, or email.
- [x] Gmail secret stays in Windows Credential Manager.
- [x] Public-repository privacy scan passes before every push.
- [x] Task registration remains behind the three-run live compatibility gate.
- [x] No placeholder, unverified installation claim, or hidden fallback remains.
