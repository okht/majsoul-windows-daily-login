import { pathToFileURL } from "node:url";
import { localClock } from "../beijing-time.mjs";
import { runDaily } from "../daily-run.mjs";
import { appendLogLine } from "../logger.mjs";
import { appPaths } from "../paths.mjs";
import { productionDependencies } from "../production-dependencies.mjs";
import { withRunLock } from "../run-lock.mjs";
import {
  clearBlockedState,
  readState,
  writeState
} from "../state-store.mjs";
import { runVisibleSetup } from "./setup-session.mjs";

export async function repairSession(dependencies = {}) {
  const paths = dependencies.paths ?? appPaths();
  const clockFn = dependencies.beijingClock ?? dependencies.localClock ?? localClock;
  const lock = dependencies.withRunLock ?? withRunLock;
  const setup = dependencies.runVisibleSetup ?? runVisibleSetup;
  const clearBlocked = dependencies.clearBlockedState ?? clearBlockedState;
  const read = dependencies.readState ?? readState;
  const write = dependencies.writeState ?? writeState;
  const buildDeps =
    dependencies.productionDependencies ?? productionDependencies;
  const run = dependencies.runDaily ?? runDaily;

  return lock(paths, async () => {
    const clock = clockFn();
    const previous = await read(clock.dateKey, paths);

    await setup({
      paths,
      ...(dependencies.setupDependencies ?? {})
    });

    await clearBlocked(clock.dateKey, paths);

    const dailyDeps = buildDeps({ paths });
    const result = await run({
      trigger: "catchup",
      dependencies: dailyDeps,
      assumeLock: true
    });

    if (result.status !== "SUCCESS") {
      await write(
        clock.dateKey,
        {
          status: "BLOCKED_MANUAL",
          repairFailedAt: new Date().toISOString(),
          previousStatus: previous?.status || null,
          kind: "MANUAL_ACTION_REQUIRED",
          phase: "repair",
          action: "请再次运行会话修复并确认已进入大厅"
        },
        paths
      );
      await appendLogLine(paths, clock.dateKey, {
        level: "warn",
        event: "repair-failed",
        status: result.status
      });
      return { status: "BLOCKED_MANUAL", exitCode: 3, result };
    }

    await appendLogLine(paths, clock.dateKey, {
      level: "info",
      event: "repair-success"
    });
    return { status: "SUCCESS", exitCode: 0, result };
  });
}

function isMainModule() {
  return Boolean(
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href
  );
}

if (isMainModule()) {
  repairSession().then(
    (outcome) => {
      process.stdout.write(outcome.status + "\n");
      process.exitCode = outcome.exitCode;
    },
    () => {
      process.stderr.write("REPAIR_FAILED\n");
      process.exitCode = 2;
    }
  );
}
