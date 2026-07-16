import { pathToFileURL } from "node:url";
import { createInterface as nodeCreateInterface } from "node:readline/promises";
import { appPaths } from "../paths.mjs";
import { PassiveEdge } from "../browser/passive-edge.mjs";
import { enrollLobbyFrames } from "../browser/fingerprint.mjs";
import { withFingerprintTokenizer } from "../browser/fingerprint-key.mjs";
import { writeFingerprintRecord } from "../browser/fingerprint-store.mjs";

const TARGET = "https://game.maj-soul.com/1/";
const SAMPLE_COUNT = 5;
const SAMPLE_INTERVAL_MS = 2_000;

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function defaultDependencies() {
  return {
    paths: appPaths(),
    input: process.stdin,
    output: process.stdout,
    createSession: (options) => new PassiveEdge(options),
    createInterface: nodeCreateInterface,
    sleep: defaultSleep,
    withFingerprintTokenizer,
    enrollLobbyFrames,
    writeFingerprintRecord
  };
}

export async function runVisibleSetup(dependencies = {}) {
  const values = { ...defaultDependencies(), ...dependencies };
  const session = values.createSession({
    profileDir: values.paths.profile,
    headless: false
  });
  const frames = [];
  let prompt;

  try {
    await session.open(TARGET);
    prompt = values.createInterface({
      input: values.input,
      output: values.output
    });
    await prompt.question(
      "请在 Edge 中手动完成登录并进入大厅，然后回到终端按 Enter。"
    );

    for (let index = 0; index < SAMPLE_COUNT; index += 1) {
      frames.push(await session.frame());
      if (index + 1 < SAMPLE_COUNT) {
        await values.sleep(SAMPLE_INTERVAL_MS);
      }
    }

    await values.withFingerprintTokenizer(async (tokenizer) => {
      const record = await values.enrollLobbyFrames(frames, tokenizer);
      await values.writeFingerprintRecord(values.paths, record);
    });
  } finally {
    try {
      prompt?.close();
    } finally {
      try {
        await session.close();
      } finally {
        for (const frame of frames) {
          if (Buffer.isBuffer(frame)) frame.fill(0);
        }
      }
    }
  }
}

function isMainModule() {
  return Boolean(
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href
  );
}

if (isMainModule()) {
  runVisibleSetup().then(
    () => {
      process.stdout.write("SUCCESS\n");
      process.exitCode = 0;
    },
    () => {
      process.stderr.write("SETUP_FAILED\n");
      process.exitCode = 2;
    }
  );
}
