import { pathToFileURL } from "node:url";
import { scanPrivacy } from "./lib/privacy-scan.mjs";

export async function checkPrivacy(options = {}) {
  return scanPrivacy(options);
}

function isMainModule() {
  return Boolean(
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href
  );
}

if (isMainModule()) {
  checkPrivacy({ includeUntracked: process.argv.includes("--untracked") }).then(
    (result) => {
      if (!result.ok) {
        process.stderr.write(result.violations.join("\n") + "\n");
        process.exitCode = 1;
        return;
      }
      process.stdout.write(
        `Privacy scan passed (${result.scanned} files).\n`
      );
      process.exitCode = 0;
    },
    (error) => {
      process.stderr.write(
        "PRIVACY_SCAN_FAILED " + (error?.message || String(error)) + "\n"
      );
      process.exitCode = 2;
    }
  );
}
