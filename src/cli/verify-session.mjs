import { pathToFileURL } from "node:url";
import { appPaths } from "../paths.mjs";
import { detectLobby } from "../browser/lobby-detector.mjs";
import { PassiveEdge } from "../browser/passive-edge.mjs";
import { withFingerprintTokenizer } from "../browser/fingerprint-key.mjs";
import { readFingerprintRecord } from "../browser/fingerprint-store.mjs";

const TARGET = "https://game.maj-soul.com/1/";

function defaultDependencies() {
  return {
    paths: appPaths(),
    readFingerprintRecord,
    createSession: ({ profileDir, headless }) => new PassiveEdge({
      profileDir,
      headless
    }),
    withFingerprintTokenizer,
    detectLobby
  };
}

function configFailure(reasonCode) {
  return {
    status: "CONFIG_ERROR",
    reasonCode,
    exitCode: 2
  };
}

function transientFailure() {
  return {
    status: "TRANSIENT_ERROR",
    reasonCode: "SESSION_VERIFICATION_FAILED",
    exitCode: 2
  };
}

function mapDetectorResult(result) {
  if (result?.status === "SUCCESS") {
    return { status: "SUCCESS", exitCode: 0 };
  }
  if (result?.status === "MANUAL_ACTION_REQUIRED") {
    return {
      status: "MANUAL_ACTION_REQUIRED",
      reasonCode: result.reasonCode,
      exitCode: 3
    };
  }
  return transientFailure();
}

export async function verifyStoredSession(dependencies = {}) {
  const values = { ...defaultDependencies(), ...dependencies };
  let record;

  try {
    record = await values.readFingerprintRecord(values.paths);
  } catch (error) {
    if (error?.code === "FINGERPRINT_RECORD_INVALID") {
      return configFailure("FINGERPRINT_RECORD_INVALID");
    }
    return transientFailure();
  }

  if (record === null || record === undefined) {
    return configFailure("FINGERPRINT_NOT_ENROLLED");
  }

  let session;
  let detectorResult;
  let failed = false;

  try {
    session = await values.createSession({
      profileDir: values.paths.profile,
      headless: true
    });
    await session.open(TARGET);
    detectorResult = await values.withFingerprintTokenizer((tokenizer) =>
      values.detectLobby(session, record, tokenizer)
    );
  } catch {
    failed = true;
  } finally {
    if (session) {
      try {
        await session.close();
      } catch {
        failed = true;
      }
    }
  }

  return failed ? transientFailure() : mapDetectorResult(detectorResult);
}

function isMainModule() {
  return Boolean(
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href
  );
}

if (isMainModule()) {
  verifyStoredSession().then((result) => {
    const message = result.reasonCode
      ? result.status + ":" + result.reasonCode
      : result.status;
    process.stdout.write(message + "\n");
    process.exitCode = result.exitCode;
  });
}
