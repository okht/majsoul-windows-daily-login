import { readFile } from "node:fs/promises";
import { beijingClock } from "./beijing-time.mjs";
import { canReachTarget as defaultCanReachTarget } from "./connectivity.mjs";
import { credentialStore } from "./credentials.mjs";
import { detectLobby as defaultDetectLobby } from "./browser/lobby-detector.mjs";
import { PassiveEdge } from "./browser/passive-edge.mjs";
import { withFingerprintTokenizer as defaultWithFingerprintTokenizer } from "./browser/fingerprint-key.mjs";
import { readFingerprintRecord as defaultReadFingerprintRecord } from "./browser/fingerprint-store.mjs";
import { appendLogLine } from "./logger.mjs";
import { sendFailureMail } from "./notifier.mjs";
import { appPaths } from "./paths.mjs";
import { withRunLock as defaultWithRunLock } from "./run-lock.mjs";
import { decideRun as defaultDecideRun } from "./schedule-policy.mjs";
import { isSessionUnlocked as defaultIsSessionUnlocked } from "./session-guard.mjs";
import { readState as defaultReadState, writeState as defaultWriteState } from "./state-store.mjs";

const TARGET = "https://game.maj-soul.com/1/";

function createHeadlessSession(paths) {
  return new PassiveEdge({
    profileDir: paths.profile,
    headless: true
  });
}

async function loadMailConfig(paths) {
  try {
    const raw = await readFile(paths.config, "utf8");
    const parsed = JSON.parse(raw);
    if (
      typeof parsed?.sender === "string" &&
      typeof parsed?.recipient === "string" &&
      parsed.sender.trim() &&
      parsed.recipient.trim()
    ) {
      return {
        sender: parsed.sender.trim(),
        recipient: parsed.recipient.trim()
      };
    }
  } catch (error) {
    if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) {
      throw error;
    }
  }
  const error = new Error("Gmail config is missing or invalid.");
  error.code = "GMAIL_CONFIG_MISSING";
  throw error;
}

function buildProductionDependencies(options = {}) {
  const paths = options.paths ?? appPaths();
  const store = options.store ?? credentialStore();
  const readFingerprintRecord =
    options.readFingerprintRecord ?? defaultReadFingerprintRecord;
  const withFingerprintTokenizer =
    options.withFingerprintTokenizer ?? defaultWithFingerprintTokenizer;
  const detectLobbyImpl = options.detectLobby ?? defaultDetectLobby;
  const createSession =
    options.createSession ?? (() => createHeadlessSession(paths));

  return {
    targetUrl: TARGET,
    logPath: paths.logs,
    paths,
    clock: options.clock ?? beijingClock,
    readState: (dateKey) =>
      (options.readState ?? defaultReadState)(dateKey, paths),
    writeState: (dateKey, state) =>
      (options.writeState ?? defaultWriteState)(dateKey, state, paths),
    isSessionUnlocked:
      options.isSessionUnlocked ?? defaultIsSessionUnlocked,
    canReachTarget: () =>
      (options.canReachTarget ?? defaultCanReachTarget)(TARGET),
    decideRun: options.decideRun ?? defaultDecideRun,
    withRunLock: (callback) =>
      (options.withRunLock ?? defaultWithRunLock)(paths, callback),
    createSession,
    detectLobby: async (session) => {
      let record;
      try {
        record = await readFingerprintRecord(paths);
      } catch (error) {
        if (error?.code === "FINGERPRINT_RECORD_INVALID") {
          return {
            status: "MANUAL_ACTION_REQUIRED",
            reasonCode: "FINGERPRINT_RECORD_INVALID"
          };
        }
        throw error;
      }
      if (record == null) {
        return {
          status: "MANUAL_ACTION_REQUIRED",
          reasonCode: "FINGERPRINT_NOT_ENROLLED"
        };
      }
      return withFingerprintTokenizer((tokenizer) =>
        detectLobbyImpl(session, record, tokenizer)
      );
    },
    notifyOnce: async (_clock, failure) => {
      const config = await loadMailConfig(paths);
      await sendFailureMail(config, failure, { store });
    },
    log: async (record) => {
      const dateKey =
        typeof record?.dateKey === "string"
          ? record.dateKey
          : beijingClock().dateKey;
      await appendLogLine(paths, dateKey, record);
    }
  };
}

export function productionDependencies(options = {}) {
  return buildProductionDependencies(options);
}
