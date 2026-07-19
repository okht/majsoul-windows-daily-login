import { pathToFileURL } from "node:url";
import { auditNoInputProject } from "./lib/no-input-policy.mjs";

export async function checkNoInput(options = {}) {
  const diagnostics = await auditNoInputProject(options);
  const output = diagnostics.map((entry) =>
    `${entry.file}:${entry.line}:${entry.column} [${entry.code}]`
  );
  return { diagnostics, output };
}

function isMainModule() {
  return Boolean(
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href
  );
}

if (isMainModule()) {
  checkNoInput().then(
    ({ diagnostics, output }) => {
      if (output.length > 0) process.stderr.write(output.join("\n") + "\n");
      process.exitCode = diagnostics.length === 0 ? 0 : 1;
    },
    () => {
      process.stderr.write("NO_INPUT_POLICY_FAILED\n");
      process.exitCode = 2;
    }
  );
}
