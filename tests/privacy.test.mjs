import { describe, expect, it } from "vitest";
import { scanPrivacy, scanText } from "../scripts/lib/privacy-scan.mjs";

describe("scanText", () => {
  it("allows example.com emails and flags other addresses", () => {
    expect(
      scanText("src/demo.mjs", "contact person@example.com", { strict: true })
    ).toEqual([]);
    expect(
      scanText("src/demo.mjs", "contact me@gmail.com", { strict: true })
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("personal-or-non-example email")
      ])
    );
  });

  it("flags user profile paths and secret material in strict files", () => {
    const text = [
      "path C:\\\\Users\\\\alice\\\\secret",
      "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "Authorization: Bearer super-secret-token",
      "Cookie: session=abc"
    ].join("\n");
    const hits = scanText("src/leak.mjs", text, { strict: true });
    expect(hits.some((h) => h.includes("windows-user-profile"))).toBe(true);
    expect(hits.some((h) => h.includes("github-token"))).toBe(true);
    expect(hits.some((h) => h.includes("auth-or-cookie-header"))).toBe(true);
  });

  it("does not treat policy discussion of cookies as a doc-level leak", () => {
    const hits = scanText(
      "docs/notes.md",
      "Never put Cookie: values or Authorization headers in logs.",
      { strict: false }
    );
    expect(hits).toEqual([]);
  });
});

describe("scanPrivacy", () => {
  it("passes for the current repository tracked tree", async () => {
    const result = await scanPrivacy({ includeUntracked: false });
    expect(result.ok, result.violations.join("\n")).toBe(true);
    expect(result.scanned).toBeGreaterThan(10);
  });
});
