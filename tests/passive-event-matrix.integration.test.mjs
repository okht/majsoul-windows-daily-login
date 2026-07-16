import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PassiveEdge } from "../src/browser/passive-edge.mjs";
import { enrollLobbyFrames } from "../src/browser/fingerprint.mjs";
import { detectLobby } from "../src/browser/lobby-detector.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EVENT_TYPES = Object.freeze([
  "pointerdown", "pointerup", "pointermove", "pointercancel",
  "gotpointercapture", "lostpointercapture",
  "mousedown", "mouseup", "mousemove", "mouseover", "mouseout",
  "mouseenter", "mouseleave", "click", "dblclick", "auxclick",
  "contextmenu", "keydown", "keypress", "keyup", "touchstart",
  "touchmove", "touchend", "touchcancel", "beforeinput", "input",
  "change", "submit", "reset", "copy", "cut", "paste",
  "compositionstart", "compositionupdate", "compositionend",
  "dragstart", "drag", "dragenter", "dragover", "dragleave", "drop",
  "dragend", "focus", "blur", "focusin", "focusout", "wheel", "scroll"
]);
const integration = process.platform === "win32" ? it : it.skip;
const profiles = [];
let server;
let baseUrl;

function tokenizer() {
  const key = Buffer.alloc(32, 0x41);
  return {
    key,
    tokenize(message) {
      return createHmac("sha256", key).update(message, "utf8").digest("hex");
    }
  };
}

function deterministicRandom(length) {
  return Buffer.alloc(length, 0x27);
}

async function freshEdge() {
  const profileDir = await mkdtemp(path.join(tmpdir(), "majsoul-edge-matrix-"));
  profiles.push(profileDir);
  return new PassiveEdge({
    profileDir,
    headless: true,
    allowLoopback: true
  });
}

function matrixFromText(text) {
  const marker = "EVENT_MATRIX_READY\n";
  const start = text.indexOf(marker);
  if (start === -1) return null;
  const json = text.slice(start + marker.length).split(/\r?\n/u)[0];
  return JSON.parse(json);
}

async function waitForMatrix(edge, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const metadata = await edge.metadata();
    const matrix = matrixFromText(metadata.text);
    if (matrix) return matrix;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("EVENT_MATRIX_NOT_READY");
}

async function waitForEventCount(edge, type, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matrix = matrixFromText((await edge.metadata()).text);
    if (matrix?.[type] > 0) return matrix;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("EVENT_MATRIX_STALE");
}

function expectZeroMatrix(matrix) {
  expect(Object.keys(matrix)).toEqual([...EVENT_TYPES].sort());
  expect(Object.values(matrix).every((count) => count === 0)).toBe(true);
}

beforeAll(async () => {
  const pages = new Map([
    ["/automatic-lobby.html", await readFile(
      path.join(HERE, "fixtures", "automatic-lobby.html"),
      "utf8"
    )],
    ["/manual-action.html", await readFile(
      path.join(HERE, "fixtures", "manual-action.html"),
      "utf8"
    )]
  ]);
  server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const body = pages.get(url.pathname);
    if (body === undefined) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("NOT_FOUND");
      return;
    }
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'",
      "Content-Type": "text/html; charset=utf-8"
    });
    response.end(body);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (typeof address === "string" || address?.address !== "127.0.0.1") {
    throw new Error("LOOPBACK_SERVER_BINDING_INVALID");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
}, 30_000);

afterAll(async () => {
  if (server) {
    await new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    );
  }
  await Promise.all(profiles.splice(0).map((profile) =>
    rm(profile, { recursive: true, force: true })
  ));
}, 30_000);

describe("real Edge passive event matrix", () => {
  it("keeps the doctype as the first fixture character", async () => {
    const automatic = await readFile(
      path.join(HERE, "fixtures", "automatic-lobby.html"),
      "utf8"
    );
    const manual = await readFile(
      path.join(HERE, "fixtures", "manual-action.html"),
      "utf8"
    );
    expect(automatic.startsWith("<!doctype html>")).toBe(true);
    expect(manual.startsWith("<!doctype html>")).toBe(true);
  });

  integration("proves every recorder counter using fixture-owned seed events", async () => {
    const edge = await freshEdge();
    try {
      await edge.open(`${baseUrl}/automatic-lobby.html?seed=all`);
      const matrix = await waitForMatrix(edge);
      expect(Object.keys(matrix)).toEqual([...EVENT_TYPES].sort());
      expect(Object.values(matrix).every((count) => count === 1)).toBe(true);
    } finally {
      await edge.close();
    }
  }, 60_000);

  integration("publishes a fixture-owned event dispatched after READY", async () => {
    const edge = await freshEdge();
    try {
      await edge.open(`${baseUrl}/automatic-lobby.html?lateSeed=pointerdown`);
      expectZeroMatrix(await waitForMatrix(edge));
      const matrix = await waitForEventCount(edge, "pointerdown");
      expect(matrix.pointerdown).toBe(1);
    } finally {
      await edge.close();
    }
  }, 60_000);

  integration("enrolls and proves the automatic lobby with zero input events", async () => {
    const edge = await freshEdge();
    const secret = tokenizer();
    try {
      await edge.open(`${baseUrl}/automatic-lobby.html`);
      expectZeroMatrix(await waitForMatrix(edge));

      const frames = [];
      for (let index = 0; index < 5; index += 1) {
        frames.push(await edge.frame());
      }
      const record = await enrollLobbyFrames(frames, secret.tokenize, {
        randomBytes: deterministicRandom
      });
      await expect(detectLobby(edge, record, secret.tokenize, {
        deadlineMs: 10_000,
        intervalMs: 25
      })).resolves.toEqual({ status: "SUCCESS" });
      expectZeroMatrix(matrixFromText((await edge.metadata()).text));
    } finally {
      secret.key.fill(0);
      await edge.close();
    }
  }, 90_000);

  integration("stops on an accessible login control before any frame or event", async () => {
    const edge = await freshEdge();
    const secret = tokenizer();
    let frameCalls = 0;
    try {
      await edge.open(`${baseUrl}/manual-action.html`);
      expectZeroMatrix(await waitForMatrix(edge));
      const observed = {
        metadata: () => edge.metadata(),
        frame: async () => {
          frameCalls += 1;
          return edge.frame();
        }
      };
      await expect(detectLobby(observed, {}, secret.tokenize, {
        deadlineMs: 2_000,
        intervalMs: 25
      })).resolves.toEqual({
        status: "MANUAL_ACTION_REQUIRED",
        reasonCode: "ACCESSIBLE_MANUAL_MARKER"
      });
      expect(frameCalls).toBe(0);
      expectZeroMatrix(matrixFromText((await edge.metadata()).text));
    } finally {
      secret.key.fill(0);
      await edge.close();
    }
  }, 60_000);

  integration("serves only the two known in-memory fixture routes", async () => {
    const response = await fetch(`${baseUrl}/../package.json`, {
      cache: "no-store"
    });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("NOT_FOUND");
  });

  if (process.platform !== "win32") {
    it("documents the only supported integration skip", () => {
      expect(process.platform).not.toBe("win32");
    });
  }
});
