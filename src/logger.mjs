import {
  appendFile,
  mkdir,
  readdir,
  rm
} from "node:fs/promises";
import path from "node:path";

const EMAIL_RE =
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const COOKIE_HEADER_RE = /(cookie\s*[:=]\s*)([^\r\n]+)/gi;
const AUTHORIZATION_RE = /(authorization\s*[:=]\s*)([^\r\n]+)/gi;
const PASSWORD_ASSIGN_RE =
  /((?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*)([^\s,;]+)/gi;

export function redactText(value) {
  if (value == null) return value;
  let text = String(value);
  text = text.replace(EMAIL_RE, "[REDACTED_EMAIL]");
  text = text.replace(COOKIE_HEADER_RE, "$1[REDACTED]");
  text = text.replace(AUTHORIZATION_RE, "$1[REDACTED]");
  text = text.replace(PASSWORD_ASSIGN_RE, "$1[REDACTED]");
  return text;
}

function redactValue(value) {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactValue(entry)])
    );
  }
  return value;
}

export function keepBeijingDateKeys(endDateKey, days = 14) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(endDateKey);
  if (!match) {
    const error = new TypeError("endDateKey must be YYYY-MM-DD.");
    error.code = "INVALID_DATE_KEY";
    throw error;
  }

  const end = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3])
  );
  const keys = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = new Date(end - offset * 86_400_000);
    keys.push(day.toISOString().slice(0, 10));
  }
  return keys;
}

export async function pruneLogs(paths, keepDateKeys) {
  await mkdir(paths.logs, { recursive: true });
  const root = path.resolve(paths.logs) + path.sep;
  for (const name of await readdir(paths.logs)) {
    const match = /^(\d{4}-\d{2}-\d{2})\.log$/.exec(name);
    if (!match || keepDateKeys.has(match[1])) continue;
    const target = path.resolve(paths.logs, name);
    if (!target.startsWith(root)) {
      throw new Error("Refusing to delete outside logs.");
    }
    await rm(target, { force: true });
  }
}

export async function appendLogLine(paths, dateKey, record) {
  await mkdir(paths.logs, { recursive: true });
  const line = JSON.stringify({
    at: new Date().toISOString(),
    ...redactValue(record)
  });
  await appendFile(
    path.join(paths.logs, dateKey + ".log"),
    line + "\n",
    "utf8"
  );
}
