# FAQ

Short answers for common local-ops questions.

## Does SUCCESS send email?

No. Optional Gmail is failure-only (`FAILED_TRANSIENT` / `BLOCKED_MANUAL`). A healthy day stays silent.

## Why does the browser dwell after SUCCESS?

After a lobby match, Edge stays open for a random 10–30 seconds, then exits. The dwell is passive (no synthetic input).

## Where do login state and secrets live?

Only on this PC under `%LOCALAPPDATA%\MajSoulDaily` and Windows Credential Manager. They are not committed to Git.

## What if the session expires?

Run `node src/cli/repair-session.mjs` (or setup again), verify, and refresh the local acceptance receipt before re-registering tasks.
