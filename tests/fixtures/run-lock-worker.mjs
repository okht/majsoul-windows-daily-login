import { withRunLock } from "../../src/run-lock.mjs";

const lockPath = process.argv[2];

if (!lockPath || typeof process.send !== "function") {
  throw new Error("The run-lock worker requires a lock path and an IPC channel.");
}

function send(message) {
  if (process.connected) process.send(message);
}

async function waitForRelease() {
  await new Promise((resolve) => {
    const onMessage = (message) => {
      if (message?.type !== "release") return;
      process.off("message", onMessage);
      resolve();
    };
    process.on("message", onMessage);
    send({ type: "entered", pid: process.pid });
  });
}

process.once("message", async (message) => {
  if (message?.type !== "start") {
    throw new Error("The first worker command must be start.");
  }

  try {
    await withRunLock({ lock: lockPath }, waitForRelease);
    send({ type: "result", outcome: "completed" });
  } catch (error) {
    send({
      type: "result",
      outcome: "error",
      code: error?.code ?? null,
      name: error?.name ?? "Error"
    });
  } finally {
    if (process.connected) process.disconnect();
  }
});

send({ type: "ready", pid: process.pid });
