# Mahjong Soul Windows Daily Opener — Mandatory Plan Corrections

**Date:** 2026-07-16  
**Status:** approved implementation addendum  
**Applies after:** Task 1, commit `a74f530`

This addendum supersedes every conflicting instruction or code sketch in
`2026-07-16-majsoul-windows-daily-login.md`. Implementers must read both the
original task brief and the matching section below. Safety and privacy tests in
this addendum are release blockers.

## Invariants for every remaining task

- Scheduled code may navigate, read metadata, capture a frame in memory, and
  close the browser. It may not synthesize mouse, keyboard, touch, drag, focus,
  form, clipboard, or CDP input.
- Frames and page text never reach disk, state, logs, email, or Git.
- A failure to prove the lobby conservatively stops and requests manual action.
- All daily-state reads, decisions, repairs, notification transitions, and
  writes occur while the same cross-process lock is held.
- Runtime files are deployed under `%LOCALAPPDATA%\MajSoulDaily\app`; scheduled
  tasks never point into a clone or worktree.
- Registration is impossible until the complete local acceptance gate passes.
- No tracked file contains a personal address, credential, browser profile,
  user-specific absolute path, screenshot, page dump, or token.

## Task 2 override — atomic state and cross-process locking

### Files

- Modify `package.json` and `package-lock.json`: add exact
  `proper-lockfile@4.1.2`.
- Create `src/state-store.mjs`, `src/run-lock.mjs`.
- Create `tests/state-store.test.mjs`, `tests/run-lock.test.mjs` and a small
  cross-process lock worker fixture.

### Required interfaces and behavior

- Preserve `readState()`, `writeState()`, `clearBlockedState()` and
  `withRunLock(paths, fn, options)`.
- `writeState()` uses a unique temporary file, flushes it, and renames it in the
  same directory. State updates merge preserved fields such as notification
  outbox data instead of silently erasing them.
- Invalid JSON is quarantined without logging its contents.
- `withRunLock()` creates the parent directory, then wraps
  `proper-lockfile.lock()` with `realpath:false`, an explicit
  `lockfilePath:paths.lock`, `stale:720000`, `update:60000`, and `retries:0`.
  All callers use the same lease values. Map `ELOCKED` to
  `RUN_ALREADY_ACTIVE`; always call the returned release function in `finally`.
- Treat `paths.lock` as the package-owned lock directory. Do not manually
  delete another process's live lock.

### Blocking tests

- Round-trip, atomic replacement, corrupt quarantine, and preserved-field merge.
- A holder and contender prove only one callback enters.
- Force-kill a worker, age the lock mtime without sleeping, start two contenders
  behind one barrier, and prove exactly one takes over.
- Callback throw still releases the lock.

### Verification and commit

Run focused state/lock tests, then the full suite. Commit as
`feat: add atomic daily state`.

## Task 3 override — schedule, session, and connectivity gates

### Required behavior

- Reject unknown trigger names before reading lock or session state.
- Validate the Beijing minute range and apply the 10:00 lower boundary before
  lock-state handling. An early manually invoked primary run cannot create
  `PENDING_DUE`.
- `primary` may run when Task Scheduler starts it at or after its randomized due
  time. A locked due primary returns `MARK_DUE`.
- `catchup` before 12:30 runs only for `PENDING_DUE`; at or after 12:30 it may
  run until the final scheduled repetition at 23:45.
- `SUCCESS` and `BLOCKED_MANUAL` are terminal for browser launch, while a
  pending notification may still be serviced by Task 6.
- Session and connectivity adapters remain injected and side-effect-free in
  unit tests.

### Blocking tests

- Add invalid-trigger, before-10:00-locked, exact 10:00, exact 12:30, terminal,
  offline, and due-marker matrix cases.
- Prove no session/network adapter is needed for a terminal state without a
  pending notification.

Commit as `feat: gate runs by schedule and session`.

## Task 4 override — passive Edge and privacy-preserving lobby proof

### Files and dependencies

- Add exact `acorn@8.15.0` as a development dependency.
- Create a generic Windows keyring adapter usable by both the fingerprint key
  and Task 5 Gmail secret.
- Replace the numeric frame-vector module with a keyed token module.
- Keep `PassiveEdge` limited to `open()`, `metadata()`, `frame()`, and `close()`.

### Stored fingerprint format

- During visible manual setup, generate a random 32-byte key and store it in
  Windows Credential Manager under a fixed fingerprint service name.
- Keep each approved PNG frame only in memory. Divide it into a fixed coarse
  grid, derive a heavily quantized directional hash per tile, and store only
  `HMAC-SHA-256(key, version | tile-index | quantized-hash)` tokens.
- Capture at least three approved lobby samples. Persist only version,
  algorithm/grid identifiers, per-position HMAC token variants, and thresholds.
- Persist no pixels, numeric pixel/vector features, raw tile hashes, PNG
  signatures, base64 values, page text, or HMAC key.
- A live frame matches by the fraction of tile positions whose keyed token is in
  the approved variants. Require three consecutive lobby matches.

### Conservative manual classification

- Accessible login, verification, confirm, consent, or CAPTCHA markers stop
  immediately with `MANUAL_ACTION_REQUIRED`.
- A loaded page that stays unknown, or any detection deadline reached without a
  proven lobby, also returns `MANUAL_ACTION_REQUIRED` with a non-sensitive
  reason code. Browser launch/capture crashes and failed reachability remain
  transient errors.
- Fix setup input by using `createInterface()` from `node:readline/promises`,
  calling `rl.question()`, and closing the interface in `finally`.

### Zero-input enforcement

- Parse scheduled transitive JavaScript sources with Acorn. Reject direct,
  computed, optional, aliased, or destructured access to browser input APIs,
  including click, tap, press, type, fill, check, uncheck, select, upload,
  hover, drag, focus, mouse, keyboard, touchscreen, clipboard, evaluate,
  CDP sessions, routes, and `Input.dispatch*`.
- The runtime fixture captures trusted pointer, mouse, keyboard, touch, input,
  change, submit, composition, drag/drop, focus, context-menu, and wheel events.
  Every counter must remain zero.
- The raw Playwright page never leaves `PassiveEdge`.

### Blocking tests and commit

- Same approved view matches; materially different tiles do not.
- Serialized fingerprint contains only fixed-length HMAC tokens and metadata.
- DOM manual marker and unknown deadline both stop; crash stays transient.
- Three consecutive matches are required; the event matrix remains zero.
- Both the AST guard and source grep reject seeded forbidden fixtures.

Commit as `feat: add passive Edge lobby detection`.

## Task 5 override — keyring and text-only Gmail

### Required behavior

- Reuse the generic keyring adapter. Keep Gmail and fingerprint services
  separate. The Gmail app password is read only inside the send operation.
- SMTP uses Gmail TLS and a plain-text message. Build no HTML, attachment,
  screenshot, page excerpt, Cookie, Local Storage, or credential field.
- Export a deterministic `failureFingerprint(dateKey, kind, phase)` helper.
- The mail sender performs one send attempt; Task 6 owns durable deduplication
  and retry state.
- The interactive configuration CLI masks the secret, stores only sender and
  recipient in local config, and sends a plain-text test message.

### Blocking tests and commit

- Keyring service separation and no secret console output.
- Exact SMTP settings, text-only body, forbidden-field absence, and stable
  failure fingerprint.
- Masked-input tests restore terminal mode on success, backspace, and throw.

Commit as `feat: add private Gmail failure alerts`.

## Task 6 override — locked orchestration, outbox, and repair

### DailyState notification outbox

Use a merge-preserved field shaped like:

`notification: { fingerprint, status, attempts, lastAttemptAt, sentAt }`

`status` is `PENDING` or `SENT`. Write `PENDING` before SMTP and `SENT` only
after it resolves. A terminal state with `PENDING` may retry on a later online
catch-up. Once `SENT`, the same fingerprint is never sent again in normal
execution. Document the unavoidable crash window between SMTP acceptance and
the final state write.

### Required orchestration order

1. Compute the Beijing clock and validate the trigger.
2. Acquire `withRunLock()`; map an active lock to an intentional skip.
3. Read state inside the lock. Service a pending terminal notification first.
4. Exit terminal state without session/network/browser work when no mail is due.
5. Evaluate session/connectivity and policy inside the same lock.
6. Write `PENDING_DUE` or `RUNNING` inside the lock.
7. Open only `PassiveEdge`, detect, merge the final state and outbox, optionally
   send mail, close Edge in `finally`, then release the lock.

Unknown/deadline detection writes `BLOCKED_MANUAL`. Only launch/capture crashes
and reachability failures write `FAILED_TRANSIENT`. Success is silent.

Manual repair holds the same lock for visible setup, fingerprint replacement,
state transition, and verification, using `REPAIRING` or an equivalent private
transition that scheduled code cannot enter concurrently.

### Blocking tests and commit

- All original outcome scenarios plus stale-prelock-state, concurrent
  `SUCCESS`/`PENDING_DUE`, pending-mail retry, sent dedup, SMTP failure,
  `RUN_ALREADY_ACTIVE`, and repair concurrency.
- Assert every path closes Edge, releases the lock, preserves outbox fields,
  and emits redacted 14-day logs.

Commit as `feat: orchestrate silent daily runs`.

## Task 7 override — stable deployment and truly windowless schedules

### Stable app deployment

- Build a temporary runtime bundle under the local application root containing
  production source, production dependencies, scripts, and a verified copy of
  `node.exe`; atomically replace `%LOCALAPPDATA%\MajSoulDaily\app` only after all
  checks pass.
- Registered actions point only to the installed bundle. Moving or deleting the
  repository must not break a task.
- Uninstall removes tasks, app, config, fingerprint, state, logs, acceptance
  receipt, and both credentials. It preserves or deletes `edge-profile` only
  after an explicit user choice.

### Transparent WinExe launcher

- Do not use VBScript. Track a minimal C# launcher source and compile it locally
  as a Windows-subsystem executable during bootstrap with a verified Windows
  compiler. Fail closed if compilation or signature/hash verification fails.
- The launcher accepts only `primary` or `catchup`, resolves the installed Node
  and runner relative to itself, owns a per-user named `Mutex`, starts Node with
  `UseShellExecute=false` and `CreateNoWindow=true`, waits, and propagates the
  exit code. It contains no UI/input API.
- Keep `proper-lockfile` inside Node as defense for direct/manual invocations.
- Acceptance measures foreground-window identity and process window handles
  before, during, and after launch; no focus change or console window is allowed.

### Scheduler contract

- Installation hard-fails unless `Get-TimeZone` returns `China Standard Time`.
- Use two tasks deliberately: the primary task owns the randomized 10:00–12:30
  calendar trigger; the catch-up task owns logon, unlock, and 12:30–23:45
  repetition. This prevents early logon from bypassing the random primary time.
- Both use interactive user context, require network, start when available, do
  not wake the computer, ignore overlap, and have a ten-minute limit. The task
  may remain visible in Task Scheduler; process execution remains windowless.
- Scheduler XML may contain only `primary` or `catchup`. An acceptance-only CLI
  is separate and can never be rendered into task XML.

### Idempotent modes and registration gate

Split bootstrap/deploy, compatibility, render-only dry run, and registration
into explicit idempotent modes. Dry run performs no credential write, browser
launch, deploy, or registration. Registration requires a fresh local acceptance
receipt bound to the deployed version and configuration.

### Blocking tests and commit

- XML contracts, timezone refusal, stable installed paths, source-to-WinExe
  compilation, named-mutex overlap, zero window/focus change, atomic deployment,
  uninstall containment, and acceptance-trigger exclusion.

Commit as `feat: register safe Windows schedules`.

## Task 8 override — complete privacy and pre-registration acceptance

### Privacy scanner

- Scan `git ls-files -co --exclude-standard -z`, then separately scan staged
  content immediately before commit. Exclude only the scanner's own pattern
  table and ignored build/runtime directories.
- Detect personal addresses, user-profile paths, credentials/passwords,
  authorization and Cookie values, private keys, browser databases, page dumps,
  image/screenshot artifacts, raw pixel/hash vectors, and forbidden input APIs
  in JavaScript, PowerShell, and C# launcher sources.

### Complete gate before registration

The acceptance command is local and can bypass time policy only through a
dedicated non-scheduled entry point while preserving the lock, passive browser,
privacy, and notification gates. Before it writes a version-bound receipt it
must prove:

- three consecutive real-lobby successes;
- three consecutive manual-fixture stops;
- zero events across the broad input matrix;
- login expiry/unknown deadline, crash, offline, locked, unlock catch-up,
  overlap, and terminal skip outcomes;
- text-only Gmail test delivery confirmed interactively;
- no frame, page text, secret, personal path, or screenshot in state/log/email;
- no task is registered yet.

Only then may registration run. After registration, start each real task once,
verify exit/status/history, confirm the second invocation is terminal and does
not open Edge, and observe no window/focus change.

README status and commands may change only after the corresponding live checks
were actually executed. Until the user completes manual login and Gmail
confirmation, label the project as implementation complete with local acceptance
pending.

Commit as `docs: verify Windows daily opener` after deterministic checks and the
available live gate; never claim unperformed registration.

## Audit-finding-to-test matrix

| Finding | Blocking evidence |
| --- | --- |
| Reconstructable visual vector | HMAC-only serialization test and privacy scan |
| Canvas/manual page misclassification | DOM marker and unknown-deadline manual-stop tests |
| Lock/state races | killed-holder two-contender test and all-state-inside-lock orchestration tests |
| Mail dedup gap | pending retry, sent dedup, SMTP failure state tests |
| Worktree-coupled tasks | installed-path and repository-move tests |
| Visible console/focus | WinExe process-handle and foreground-window acceptance |
| Beijing/local-time drift | `China Standard Time` installer refusal test |
| Invalid readline API | visible setup CLI unit test using `createInterface()` |
| Registration before safety gate | missing/stale receipt refusal tests |
| Weak zero-input scan | AST seeded fixtures plus broad runtime event matrix |
| Early false due marker | before-10:00 locked-primary policy test |
| Terminal adapter work | terminal fast-exit spy test |
| Repair race | locked repair concurrency test |
| Side-effecting dry run | filesystem/process/task no-change test |
| Incomplete privacy scan | tracked, untracked nonignored, and staged fixtures |
| Incomplete acceptance | deterministic scenario matrix and three-run counters |
| Two-task design drift | design amendment and XML trigger ownership tests |
