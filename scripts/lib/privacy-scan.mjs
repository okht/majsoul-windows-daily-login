import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

const SELF_FILES = new Set([
  "scripts/check-privacy.mjs",
  "scripts/lib/privacy-scan.mjs",
  "tests/privacy.test.mjs"
]);

const STRICT_GLOBS = [
  /^src\//,
  /^scripts\//,
  /^tools\//,
  /^README\.md$/i,
  /^package\.json$/
];

const CONTENT_PATTERNS = [
  {
    id: "windows-user-profile",
    re: /[A-Za-z]:[\\/]+Users[\\/]+(?!Public\b|Default\b|All Users\b)[^%<\s"'`]+/i
  },
  {
    id: "unix-user-profile",
    re: /\/(?:Users|home)\/(?!Shared\b|Public\b)[^/<\s"'`]+/
  },
  { id: "github-token", re: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/ },
  { id: "github-pat", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { id: "aws-access-key", re: /\bAKIA[A-Z0-9]{16}\b/ },
  { id: "private-key", re: /BEGIN [A-Z ]*PRIVATE KEY/ },
  {
    id: "auth-or-cookie-header",
    re: /(?:authorization|cookie)\s*[:=]\s*(?!\[REDACTED\])\S+/i
  }
];

const FORBIDDEN_NAME =
  /(?:^|\/)(?:Cookies|Login Data|Local State|Web Data|History)$|(?:screenshot|\.(?:png|jpe?g|webp))$/i;

function normalize(file) {
  return String(file).replaceAll("\\", "/");
}

function isStrictFile(file) {
  const n = normalize(file);
  return STRICT_GLOBS.some((re) => re.test(n));
}

function isSelfFile(file) {
  return SELF_FILES.has(normalize(file));
}

function listTrackedFiles(cwd = process.cwd()) {
  const raw = execFileSync("git", ["ls-files", "-z"], {
    encoding: "buffer",
    cwd,
    windowsHide: true
  });
  return raw
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map(normalize);
}

function listUntrackedNonIgnored(cwd = process.cwd()) {
  try {
    const raw = execFileSync(
      "git",
      ["ls-files", "-co", "--exclude-standard", "-z"],
      { encoding: "buffer", cwd, windowsHide: true }
    );
    return raw
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .map(normalize);
  } catch {
    return [];
  }
}

function emailViolations(file, text) {
  const emails = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  const hits = [];
  for (const email of emails) {
    const lower = email.toLowerCase();
    if (lower.endsWith("@example.com")) continue;
    // Allow generic documentation placeholders only.
    if (lower.endsWith("@example.org") || lower.endsWith("@example.net")) {
      continue;
    }
    hits.push(`${file}: personal-or-non-example email (${email})`);
  }
  return hits;
}

export function scanText(file, text, options = {}) {
  const strict = options.strict ?? isStrictFile(file);
  const violations = [];

  if (FORBIDDEN_NAME.test(file)) {
    violations.push(`${file}: forbidden tracked artifact name`);
  }

  violations.push(...emailViolations(file, text));

  if (!strict) {
    // docs/tests may mention path/cookie patterns as negative assertions or
    // policy text. Still catch high-confidence secret material and emails.
    for (const { id, re } of CONTENT_PATTERNS) {
      if (
        id === "github-token" ||
        id === "github-pat" ||
        id === "aws-access-key" ||
        id === "private-key"
      ) {
        if (re.test(text)) violations.push(`${file}: matches ${id}`);
      }
    }
    return violations;
  }

  for (const { id, re } of CONTENT_PATTERNS) {
    if (re.test(text)) violations.push(`${file}: matches ${id}`);
  }
  return violations;
}

export async function scanPrivacy(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const tracked = options.files ?? listTrackedFiles(cwd);
  const alsoUntracked = options.includeUntracked === true;
  const files = alsoUntracked
    ? [...new Set([...tracked, ...listUntrackedNonIgnored(cwd)])]
    : tracked;

  const violations = [];
  for (const file of files) {
    if (isSelfFile(file)) continue;
    if (file.startsWith("node_modules/") || file.startsWith(".git/")) continue;

    if (FORBIDDEN_NAME.test(file)) {
      violations.push(`${file}: forbidden tracked artifact name`);
      continue;
    }

    let text = "";
    try {
      text = await readFile(path.join(cwd, file), "utf8");
    } catch {
      // binary or missing: name checks already applied
      continue;
    }
    violations.push(...scanText(file, text));
  }

  return {
    ok: violations.length === 0,
    violations: [...new Set(violations)].sort(),
    scanned: files.length
  };
}
