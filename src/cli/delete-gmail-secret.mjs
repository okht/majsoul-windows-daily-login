import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { credentialStore } from "../credentials.mjs";
import { appPaths } from "../paths.mjs";
import { keyringStore } from "../keyring-store.mjs";

const FINGERPRINT_SERVICE = "MajSoulDaily.Fingerprint";
const FINGERPRINT_ACCOUNT = "lobby-fingerprint-key";

async function readSender(paths) {
  try {
    const raw = await readFile(paths.config, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed?.sender === "string" && parsed.sender.trim()) {
      return parsed.sender.trim();
    }
  } catch (error) {
    if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) {
      throw error;
    }
  }
  return null;
}

export async function deleteLocalSecrets(dependencies = {}) {
  const paths = dependencies.paths ?? appPaths();
  const gmail = dependencies.gmailStore ?? credentialStore();
  const generic = dependencies.keyring ?? keyringStore();
  const sender = await readSender(paths);

  let gmailDeleted = false;
  if (sender) {
    gmailDeleted = Boolean(gmail.delete(sender));
  }

  let fingerprintDeleted = false;
  try {
    fingerprintDeleted = Boolean(
      generic.delete(FINGERPRINT_SERVICE, FINGERPRINT_ACCOUNT)
    );
  } catch {
    fingerprintDeleted = false;
  }

  return {
    gmailDeleted,
    fingerprintDeleted,
    // Never return the sender address to stdout callers.
    hadSender: Boolean(sender)
  };
}

function isMainModule() {
  return Boolean(
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href
  );
}

if (isMainModule()) {
  deleteLocalSecrets()
    .then((result) => {
      process.stdout.write(
        "SECRETS_CLEARED gmail=" +
          String(result.gmailDeleted) +
          " fingerprint=" +
          String(result.fingerprintDeleted) +
          "\n"
      );
      process.exitCode = 0;
    })
    .catch(() => {
      process.stderr.write("SECRET_DELETE_FAILED\n");
      process.exitCode = 2;
    });
}
