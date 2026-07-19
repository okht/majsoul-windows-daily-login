import { pathToFileURL } from "node:url";
import { runDaily } from "../daily-run.mjs";
import {
  appendLogLine,
  keepBeijingDateKeys,
  pruneLogs
} from "../logger.mjs";
import { beijingClock } from "../beijing-time.mjs";
import { appPaths } from "../paths.mjs";
import { productionDependencies } from "../production-dependencies.mjs";

function parseTrigger(argv) {
  const index = argv.indexOf("--trigger");
  return index >= 0 ? argv[index + 1] : "";
}

export async function main(argv = process.argv.slice(2), dependencies) {
  const trigger = parseTrigger(argv);
  if (trigger !== "primary" && trigger !== "catchup") {
    process.stderr.write("Expected --trigger primary or --trigger catchup.\n");
    return 64;
  }

  const paths = dependencies?.paths ?? appPaths();
  const clock = (dependencies?.clock ?? beijingClock)();
  await pruneLogs(paths, new Set(keepBeijingDateKeys(clock.dateKey, 14)));

  const deps = dependencies ?? productionDependencies({ paths });
  const result = await runDaily({ trigger, dependencies: deps });

  await appendLogLine(paths, clock.dateKey, {
    level: "info",
    event: "daily-run",
    trigger,
    status: result.status
  });

  if (result.status === "BLOCKED_MANUAL") return 3;
  if (result.status === "FAILED_TRANSIENT") return 2;
  return 0;
}

function isMainModule() {
  return Boolean(
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href
  );
}

if (isMainModule()) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    async (error) => {
      try {
        const paths = appPaths();
        const clock = beijingClock();
        await appendLogLine(paths, clock.dateKey, {
          level: "error",
          event: "daily-run-crash",
          code: error?.code || "UNHANDLED"
        });
      } catch {
        // ignore logging failures
      }
      process.stderr.write("DAILY_RUN_FAILED\n");
      process.exitCode = 2;
    }
  );
}
