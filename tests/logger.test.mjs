import { mkdtemp, readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendLogLine,
  keepBeijingDateKeys,
  pruneLogs,
  redactText
} from "../src/logger.mjs";

describe("redactText", () => {
  it("redacts email addresses, cookies, authorization headers, and secrets", () => {
    const input = [
      "user person@example.com failed",
      "Cookie: session=abc123; Path=/",
      "Authorization: Bearer super-token-value",
      "password=app-secret-value",
      "safe phase lobby-detection"
    ].join("\n");

    const redacted = redactText(input);
    expect(redacted).not.toContain("person@example.com");
    expect(redacted).not.toContain("abc123");
    expect(redacted).not.toContain("super-token-value");
    expect(redacted).not.toContain("app-secret-value");
    expect(redacted).toContain("safe phase lobby-detection");
    expect(redacted).toMatch(/\[REDACTED_EMAIL\]/);
    expect(redacted).toMatch(/\[REDACTED\]/);
  });
});

describe("keepBeijingDateKeys", () => {
  it("keeps the latest 14 inclusive Beijing date keys ending at the given day", () => {
    const keys = keepBeijingDateKeys("2026-07-16", 14);
    expect(keys).toHaveLength(14);
    expect(keys[0]).toBe("2026-07-03");
    expect(keys[13]).toBe("2026-07-16");
  });
});

describe("pruneLogs", () => {
  it("deletes only aged YYYY-MM-DD.log files under the logs root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "majsoul-logs-"));
    const logs = path.join(root, "logs");
    await mkdir(logs, { recursive: true });
    await writeFile(path.join(logs, "2026-07-01.log"), "old\n", "utf8");
    await writeFile(path.join(logs, "2026-07-16.log"), "keep\n", "utf8");
    await writeFile(path.join(logs, "notes.txt"), "ignore\n", "utf8");

    await pruneLogs(
      { logs },
      new Set(keepBeijingDateKeys("2026-07-16", 14))
    );

    const names = new Set(await readdir(logs));
    expect(names.has("2026-07-01.log")).toBe(false);
    expect(names.has("2026-07-16.log")).toBe(true);
    expect(names.has("notes.txt")).toBe(true);
  });
});

describe("appendLogLine", () => {
  it("writes one redacted JSON object per line", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "majsoul-logline-"));
    const logs = path.join(root, "logs");
    const paths = { logs };

    await appendLogLine(paths, "2026-07-16", {
      level: "info",
      message: "contact person@example.com",
      cookie: "Cookie: a=1"
    });

    const body = await readFile(path.join(logs, "2026-07-16.log"), "utf8");
    const line = JSON.parse(body.trim());
    expect(line.level).toBe("info");
    expect(line.message).toContain("[REDACTED_EMAIL]");
    expect(line.cookie).toMatch(/\[REDACTED\]/);
    expect(body).not.toContain("person@example.com");
    expect(body).not.toContain("a=1");
  });
});
