import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { appPaths } from "./paths.mjs";

/** Checks required before registration. Gmail is optional and deferred. */
export const REQUIRED_ACCEPTANCE_CHECKS = Object.freeze([
  "verify",
  "privacy",
  "noInput",
  "dryRun",
  "noTasksRegistered",
  "interactiveRealLobby"
]);

export function acceptanceReceiptPath(paths = appPaths()) {
  return path.join(paths.root, "acceptance-receipt.json");
}

export function isReceiptFresh(receipt, now = new Date(), maxAgeDays = 7) {
  if (!receipt?.createdAt) return false;
  const created = new Date(receipt.createdAt);
  if (Number.isNaN(created.getTime())) return false;
  const ageMs = now.getTime() - created.getTime();
  return ageMs >= 0 && ageMs <= maxAgeDays * 86_400_000;
}

export function isReceiptValid(receipt, packageVersion, now = new Date()) {
  if (!receipt || receipt.passed !== true) return false;
  if (receipt.version !== packageVersion) return false;
  if (!isReceiptFresh(receipt, now)) return false;
  const checks = receipt.checks;
  if (!checks || typeof checks !== "object") return false;
  return REQUIRED_ACCEPTANCE_CHECKS.every((key) => checks[key] === true);
}

export async function readAcceptanceReceipt(paths = appPaths()) {
  try {
    const raw = await readFile(acceptanceReceiptPath(paths), "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function writeAcceptanceReceipt(receipt, paths = appPaths()) {
  await mkdir(paths.root, { recursive: true });
  const file = acceptanceReceiptPath(paths);
  const body = JSON.stringify(receipt, null, 2) + "\n";
  await writeFile(file, body, "utf8");
  return file;
}

export function buildAcceptanceReceipt({
  version,
  checks,
  createdAt = new Date().toISOString()
}) {
  const passed = REQUIRED_ACCEPTANCE_CHECKS.every(
    (key) => checks?.[key] === true
  );
  return {
    version,
    passed,
    createdAt,
    checks: { ...checks }
  };
}
