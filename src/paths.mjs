import os from "node:os";
import path from "node:path";

export function appPaths(env = process.env, homeDir = os.homedir()) {
  const local = env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local");
  const root = path.join(local, "MajSoulDaily");
  return {
    root,
    profile: path.join(root, "edge-profile"),
    state: path.join(root, "state"),
    logs: path.join(root, "logs"),
    fingerprint: path.join(root, "lobby-fingerprint.json"),
    config: path.join(root, "config.json"),
    lock: path.join(root, "run.lock")
  };
}
