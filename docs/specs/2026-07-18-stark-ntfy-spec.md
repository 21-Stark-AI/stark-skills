# stark-ntfy — Desktop Notification on Command Completion

## intent — Intent & Soundness

**Problem.** When you kick off a long-running shell command (a build, a test suite, a migration, a fleet review) and switch windows, you lose the finish signal — you either poll the terminal or come back late. `stark-ntfy` closes that gap: it wraps a command, runs it to completion, and fires a native macOS desktop notification the moment it finishes, carrying the command line, the exit code, and the elapsed wall time.

**Design.** `stark-ntfy` is a thin wrapper process. It parses its own arguments up to a literal `--` separator, spawns everything after `--` as a child process inheriting the current stdio, waits for the child to exit, measures elapsed wall-clock time, invokes `osascript` to display a macOS notification, and then exits with the **same exit code** the child returned. This solves the problem because the notification is emitted at most once, after the wrapped command's real termination, and the wrapper is transparent to the command's own I/O and exit status — the only observable additions are the notification and a small startup/teardown latency.

**Success criteria (objective).**
- `stark-ntfy -- <cmd...>` runs `<cmd...>` with the same stdin/stdout/stderr the user would have seen running it directly.
- `stark-ntfy`'s own exit code equals the wrapped command's exit code (see `behavior` for the signal-death and spawn-failure cases).
- After the command finishes, `stark-ntfy` invokes `osascript` **exactly once** to display a notification containing the command string, the exit code, and the elapsed time. Notification *display* is best-effort: if `osascript` itself fails, no notification appears, this is logged to stderr, and the exit code is unaffected (see `behavior`). The exactly-once guarantee is on the *invocation*, not on a guaranteed-visible banner — the wrapper never fires zero or two notifications on a completed run.
- No daemon, no config file, no network call, no persisted state is created.

**Scope tier.** Playground — a single-user, local, macOS-only personal tool. The absence of a daemon, config server, auth, telemetry, cross-platform support, retries, and persistence is deliberate restraint, not a gap (see `scope`).

## scope — Scope & Boundaries

**In scope (V1).**
- A single CLI: `stark-ntfy -- <command...>`.
- Spawning the wrapped command with inherited stdio and waiting for it.
- Measuring elapsed wall-clock time from just-before-spawn to child-exit.
- Firing one macOS notification via `osascript` on completion (success or failure).
- Mirroring the child's exit code as the wrapper's exit code.
- Minimal wrapper-level flags: `--help`/`-h` (usage) and `--title <str>` (override the notification title; default `stark-ntfy`).

**Explicitly out of scope (V1)** — each a deliberate playground-scope exclusion, not a deferred production concern:
- No daemon or background service — the wrapper lives only for the duration of the wrapped command.
- No config file or config server — behavior is fully determined by argv.
- No network I/O — notifications are strictly local via `osascript`. No push services, no `ntfy.sh`, no webhooks. (The `stark-ntfy` name is coincidental with the `ntfy` project; this tool does not integrate with it.)
- No cross-platform support — macOS only; `osascript` is assumed present.
- No sound/notification-center configuration UI, no notification history, no click-to-focus action.
- No retries, timeouts, or process supervision of the wrapped command — it runs exactly once, for as long as it runs.
- No capture, filtering, or transformation of the command's output — stdio is passed through untouched.

**Non-goals.** Not a job runner, scheduler, log aggregator, or cross-machine alerting system. If any of those is ever needed, it is a new tool, not a flag on this one.

## interfaces — Interfaces & Contracts

### CLI surface

```
stark-ntfy [--title <str>] [--help|-h] -- <command> [args...]
```

**Argument grammar.**
- All tokens **before** the first literal `--` are `stark-ntfy`'s own options.
- The first literal `--` is the separator and is consumed (not passed to the child).
- All tokens **after** the first `--` form the wrapped command and its arguments, verbatim. A second `--` in that position is part of the command, not re-parsed.

**Options.**

| Flag | Type | Required | Default | Meaning |
|------|------|----------|---------|---------|
| `--title <str>` | string | optional | `stark-ntfy` | Notification title text. |
| `--help`, `-h` | boolean | optional | — | Print usage to stdout and exit 0; no command is run. |

**`--title` parsing semantics.**
- **Repeated `--title`:** accepted; **last occurrence wins** (`--title A --title B` yields title `B`). Repetition is not an error — it mirrors how conventional CLIs treat scalar flags, so a wrapper-generated command line that appends a title on top of an existing one behaves predictably rather than erroring.
- **Empty value:** `--title ""` is **valid** — an explicit empty string is accepted verbatim and produces an empty notification title (macOS renders the banner with no title line). An empty title is a legitimate user choice, distinct from omitting the flag (which yields the `DEFAULT_TITLE`, owned in `ssot`). What is rejected is `--title` with **no following token at all** (see below), which is a grammar error, not an empty value.
- A value beginning with `-` is still consumed as the title's value (e.g. `--title -x` sets the title to `-x`); `--title` always consumes exactly the next token.

**Invocation constraints** (rejected at parse time, exit code `2`, message to stderr, no command run, no notification):
- Missing `--` separator.
- Empty command after `--` (`stark-ntfy --` with nothing following).
- Unknown flag before `--`.
- `--title` as the final token before `--` (or end of argv) with no following value.

`--help`/`-h` before `--` short-circuits: usage printed, exit 0, nothing spawned. If both `--help` and an otherwise-valid command are present before `--`, help wins (usage printed, no spawn).

### Child process contract

- Spawned with `stdio: 'inherit'` — the child shares the parent's stdin, stdout, stderr fds. `stark-ntfy` writes nothing to stdout/stderr on the success path except via the notification; diagnostics (parse errors, spawn failure, `osascript` failure) go to **stderr**, prefixed `stark-ntfy:`.
- Spawned **without a shell** (`shell: false`): argv is passed as an argument vector, so `stark-ntfy` applies no shell-quoting or word-splitting — the user's shell already tokenized the argv before `stark-ntfy` saw it.
- Inherits the parent's environment and working directory unchanged.

### Notification contract (`osascript`)

`stark-ntfy` builds and runs:

```
osascript -e 'display notification "<body>" with title "<title>"'
```

- `<title>` = the `--title` value or the default `stark-ntfy`.
- `<body>` is a single line: `<command-display> — exit <code> — <elapsed>`, where
  - `<command-display>` = the wrapped argv joined by single spaces, truncated to 120 chars with a trailing `…` if longer;
  - `<code>` = the integer exit code (or `signal <NAME>` in the signal case, per `behavior`);
  - `<elapsed>` = humanized wall time: `<N>ms` under 1s, else `<M>m <S>s` at ≥60s, else `<S.S>s` (one decimal) — owned per `ssot`.
- Both `<title>` and `<body>` are escaped for the AppleScript double-quoted literal: every `\` → `\\` and every `"` → `\"` before interpolation. This is the sole injection boundary (see `security`).

There is **no stdout data contract** and **no JSON output** — the product is the side effect (the notification) plus the mirrored exit code.

### Data model / local store

None. `stark-ntfy` holds no persistent state and writes no files. Per-invocation in-memory state is only: parsed options, the child's argv, the start timestamp, and the child's exit result. No database, cache, or config file to model.

## behavior — Behavior & Correctness

**Happy path.**
1. Parse argv; split on the first `--`.
2. Record `start = monotonic-now`.
3. Spawn the command with inherited stdio, no shell.
4. Await child exit.
5. Compute `elapsed = monotonic-now − start`.
6. Fire the notification with command, exit code, humanized elapsed.
7. Exit with the child's exit code.

**Exit-code mirroring (the core contract).**
- Child exits with code `N` (0–255): `stark-ntfy` exits `N`; body reads `exit N`.
- Child killed by signal `SIG` (no numeric exit code): `stark-ntfy` exits `128 + <signal-number>` (conventional shell encoding), and body reads `signal SIG` instead of `exit N`, so a `SIGKILL`-ed build is not misreported as a clean `exit 0`.

**Error and edge cases.**
- **Spawn failure** (`ENOENT`/`EACCES` — command not found / not executable): stderr `stark-ntfy: could not run <cmd>: <reason>`; a notification whose body reads `<command-display> — failed to start — <reason>`; exit `127` (conventional "command not found").
- **Empty / malformed invocation** (missing `--`, empty command, unknown flag, `--title` without value): usage error to stderr, exit `2`, no command run, no notification.
- **`osascript` failure** (missing binary / non-zero exit): the notification is best-effort — logged to stderr as `stark-ntfy: notification failed: <reason>` but does **not** change the exit code, which still mirrors the child. Fail-soft here is deliberate and narrow: it applies only to the notification side effect, never to exit-code fidelity.
- **`stark-ntfy` receives a signal itself** (e.g. Ctrl-C): SIGINT/SIGTERM are forwarded to the child. The wrapper then **waits for the child's actual exit** rather than assuming the forwarded signal killed it — the child is the sole authority on how it terminated:
  - If the child terminates *from* the forwarded signal, the normal completion path runs (notification + mirrored `128 + signal`, body `signal SIG`).
  - If the child **traps or ignores** the signal and later **exits normally** with code `N` (e.g. it catches SIGINT, cleans up, and exits 0), `stark-ntfy` mirrors that real exit — exit `N`, body `exit N`. The wrapper does not pre-empt or override the child's chosen exit; it reports whatever the child ultimately did.
  - Either way, exactly one notification fires, and it fires only after the child has actually exited. Forwarding is one-shot per received signal (the wrapper re-forwards each signal it receives; it does not escalate to SIGKILL on its own). The interrupt is never swallowed by the wrapper.
- **Zero-duration command** (<1ms): elapsed renders `0ms`; still one notification.
- **Very long command line**: `<command-display>` truncated to 120 chars + `…` in the notification only; exit code and elapsed unaffected.

**Notification exactly-once ordering.** On every path where a child was successfully spawned (normal exit, signal death, or trap-then-normal-exit), the notification is invoked exactly once and strictly after the child's exit is observed — never before, never twice. On the pre-spawn parse-error path no notification fires; on the spawn-failure path exactly one (failure-body) notification fires. There is no code path that fires two notifications for a single invocation.

**Consistency.** The 120-char truncation, the elapsed thresholds (1s, 60s), the default title (`stark-ntfy`), and the exit-code conventions (`2`/`127`/`128+signal`) each appear once here and are owned as stated in `ssot`; no section restates them with a different value.

**Observability.** Playground-appropriate: all diagnostics go to stderr with the `stark-ntfy:` prefix. No log file, no metrics, and none needed — the tool runs in the foreground and the user sees its stderr directly.

## ssot — Single Source of Truth

Each value/rule below has exactly one authoritative owner; every other site consumes it.

- **Elapsed-time humanization** — a single `formatElapsed(ms): string` owns the 1s/60s thresholds and the `ms`/`s`/`m s` rendering. The notification body is its only consumer.
- **Command display string** — a single `formatCommand(argv): string` owns the space-join and 120-char + `…` truncation. Consumed by both the success and spawn-failure bodies.
- **AppleScript escaping** — a single `escapeForOsascript(s): string` owns the `\`→`\\` and `"`→`\"` rules. Both `<title>` and `<body>` pass through it; no caller escapes inline.
- **Exit-code policy** — a single `resolveExitCode(childResult): number` owns the mapping (normal → `N`, signal → `128 + n`, spawn-failure → `127`) so the process-exit value and the notification value cannot drift.
- **Default title constant** — one `DEFAULT_TITLE = "stark-ntfy"`; the parser default and the usage text both reference it.

No configuration store, environment variable, or second copy of any of these values exists — argv is the only input, and each derived value has the single owner above.

## security — Security & Trust

**Trust model.** Single-user, local, foreground tool. The operator is the sole trust principal and already has a shell — `stark-ntfy` grants no privilege the user does not already have. The wrapped command runs with the user's own identity, environment, and working directory. There is no privilege boundary to cross and no remote party.

**The one real trust boundary — AppleScript string interpolation.** The wrapped command's argv flows into an `osascript -e '…'` AppleScript string. Un-escaped, a command containing `"` or `\` could break out of the string literal and inject arbitrary AppleScript. This is neutralized by routing **both** title and body through the single `escapeForOsascript` owner (`ssot`) before interpolation, and by passing the script via `-e` argv (not through a shell), so no shell metacharacter interpretation occurs. This is the only place a value crosses from data into an interpreted context, and it is explicitly closed.

**Command execution.** The child is spawned with `shell: false` and an explicit argv vector, so `stark-ntfy` itself introduces **no** shell-injection surface — it does not re-interpret, glob, or word-split the command. Whatever the user's shell tokenized is what runs.

**Secrets / data protection.** `stark-ntfy` handles no credentials and stores nothing. The command line it displays may incidentally contain a secret the user typed (e.g. `--token=…`); this is the same exposure the user already accepted by typing it into shell history, and the notification is local-only and ephemeral. No secret is transmitted, logged to a file, or persisted. A network-sending notifier would change this calculus, and that is out of scope.

**Least privilege / network.** No network access, no file writes, no elevated permissions. The only external process invoked is `osascript`, with a fixed argument shape.

**Not applicable at this tier (declared, not silently omitted):** authn/authz (no multi-user surface), encryption at rest/in transit (no persistence, no network), audit logging (single-user foreground tool), rate limiting (one notification per invocation).

## test-plan — Test Plan

Automated unit + integration tests via the built-in `node:test` runner, run with `node --experimental-strip-types`. Each behavior-changing claim has a named proving test with a concrete break scenario.

- **Exit-code mirroring (normal).** Stub command exits 3 → assert `stark-ntfy` exits 3. *Breaks if:* the wrapper hardcodes 0 or swallows the child code.
- **Exit-code mirroring (signal).** Stub self-kills with `SIGKILL` → assert exit `137` (`128+9`) and body contains `signal SIGKILL`. *Breaks if:* a signal death is misreported as `exit 0`.
- **Signal forwarding — child dies from forwarded signal.** Spawn a child that installs no handler; send `stark-ntfy` a SIGINT → assert the child receives SIGINT, `stark-ntfy` exits `130` (`128+2`), body reads `signal SIGINT`, and exactly one notification fired. *Breaks if:* the signal is swallowed, not forwarded, or the wrapper exits before the child.
- **Signal forwarding — child traps signal and exits normally.** Spawn a child that traps SIGINT, cleans up, and exits `0`; send `stark-ntfy` a SIGINT → assert `stark-ntfy` waits for the real exit and exits `0`, body reads `exit 0` (not `signal SIGINT`), one notification. *Breaks if:* the wrapper assumes the forwarded signal killed the child and reports `128+2` or exits early.
- **Spawn failure.** Wrap a non-existent binary → assert exit `127`, stderr `could not run`, failure-notification path invoked with `failed to start`. *Breaks if:* `ENOENT` throws unhandled or exits 0.
- **`osascript` failure is non-fatal.** Stubbed failing notifier + child exits 5 → assert `stark-ntfy` still exits 5 and logs `notification failed`. *Breaks if:* notification failure overrides the child's exit code.
- **Notification exactly-once + ordering.** Instrument the notifier to record call count and a timestamp relative to child-exit; run a normal command → assert the notifier was called exactly once and strictly after the child exited. Run the parse-error path → assert zero calls; run the spawn-failure path → assert exactly one (failure-body) call. *Breaks if:* a path fires the notification before child-exit, twice, or zero times on a completed run.
- **Arg parsing — missing `--`.** `stark-ntfy echo hi` → exit 2, usage on stderr, no spawn. *Breaks if:* `echo` is treated as the command without a separator.
- **Arg parsing — empty command.** `stark-ntfy --` → exit 2. *Breaks if:* the wrapper spawns an empty argv.
- **Arg parsing — unknown flag.** `stark-ntfy --bogus -- true` → exit 2, usage on stderr, no spawn, no notification. *Breaks if:* an unrecognized flag is silently ignored or leaks past the parser.
- **Arg parsing — `--help`/`-h`.** `stark-ntfy --help` (and `-h`) → usage printed to stdout, exit 0, nothing spawned; `stark-ntfy --help -- true` → help wins, `true` never runs. *Breaks if:* help spawns a command or exits non-zero.
- **Arg parsing — `--title` missing value.** `stark-ntfy --title -- true` (title flag is the final token before `--`) → exit 2, usage on stderr, no spawn. *Breaks if:* the separator `--` is mistakenly consumed as the title value.
- **Arg parsing — repeated `--title` (last wins).** `stark-ntfy --title A --title B -- true` → notifier invoked with title `B`. *Breaks if:* the first title wins, or repetition errors.
- **Arg parsing — empty `--title` value.** `stark-ntfy --title "" -- true` → notifier invoked with an empty title (distinct from the `DEFAULT_TITLE` produced when the flag is omitted). *Breaks if:* an empty string is rejected as "missing value" or silently replaced with the default.
- **Arg parsing — `--title` passthrough.** `stark-ntfy --title Build -- true` → notifier invoked with title `Build`; tokens after `--` unaffected. *Breaks if:* `--title` leaks into child argv or the split point is miscomputed.
- **`escapeForOsascript`.** Unit: input `he said "hi" \ bye` → both `"` and `\` escaped. *Breaks if:* an unescaped quote could break out of the AppleScript literal (the security boundary).
- **`formatElapsed` thresholds.** Table: `500` → `500ms`; `1500` → `1.5s`; `65000` → `1m 5s`. *Breaks if:* a threshold is off-by-one or branch order is wrong.
- **`formatCommand` truncation.** 200-char argv → 120 chars + `…`. *Breaks if:* truncation is missing and an over-long body reaches `osascript`.
- **Stdio inheritance — stdout (integration).** Wrap a command that writes known bytes to stdout (`printf 'STDOUT-MARKER'`) → capture the parent's stdout and assert the marker bytes arrive unmodified and unbuffered-into-oblivion. *Breaks if:* stdout is captured, transformed, or dropped instead of inherited.
- **Stdio inheritance — stderr (integration).** Wrap a command that writes a known marker to fd 2 (`sh -c 'printf STDERR-MARKER 1>&2'`) → capture the parent's stderr and assert the child's marker reaches it **and is not confused with `stark-ntfy`'s own `stark-ntfy:`-prefixed diagnostics** (the wrapper writes nothing to stderr on the success path). *Breaks if:* the child's stderr is swallowed, redirected into stdout, or the wrapper's own diagnostics contaminate the child's stderr stream.
- **Stdio inheritance — stdin (integration).** Feed a known payload to `stark-ntfy`'s stdin and wrap a command that reads all of stdin and echoes it (`cat`) → assert the child receives the exact payload from the parent's stdin and its echo reaches the parent's stdout. Additionally, wrap a command that reads a single line interactively (`sh -c 'read x; printf "got:%s" "$x"'`) with a line on stdin → assert the child reads it. *Breaks if:* the child's stdin is closed to `/dev/null`, the wrapper drains stdin itself, or fd 0 is not inherited (a REPL/pager wrapped by `stark-ntfy` would hang or see EOF).
- **Inherited environment + working directory (integration).** Set a sentinel env var and `cd` to a known dir before invoking `stark-ntfy -- <probe>`, where the probe echoes `$SENTINEL` and `pwd` → assert the child observes the sentinel value and the same cwd as the parent. *Breaks if:* the wrapper scrubs, resets, or overrides the child's env or cwd.

**Not tested (declared):** the real `osascript` visual rendering (manual smoke only — `stark-ntfy -- sleep 2` should surface one notification on the developer's Mac); performance/load (single foreground invocation, no throughput claim); no migration or rollout tests (no persisted state).

## accessibility — Accessibility

`n_a — headless CLI + macOS system notification; no in-app user-facing UI surface is authored by this tool.` The only visual output is the native macOS notification banner, whose accessibility (VoiceOver announcement, contrast, dismiss affordances) is owned by macOS Notification Center, not by `stark-ntfy`. The tool renders no custom UI, so it has no accessibility bar of its own to meet.

## open-questions — Open Questions

- **Signal forwarding scope.** V1 forwards SIGINT/SIGTERM to the child (`behavior`). Whether to also forward SIGHUP/SIGQUIT is deferred — no current use case needs it. Owner: author; revisit only if a real interrupt is observed not to propagate.
- **Notification when the terminal is closed mid-run.** If the user closes the terminal and `stark-ntfy` is killed with its child, no notification fires (the wrapper is gone). Accepted V1 behavior (no daemon by design); a detached/persistent mode is a non-goal unless a concrete need appears. Owner: author.
- **Sound / criticality.** Whether a failing command (`exit != 0`) should use a different notification sound or a more prominent style is unresolved; V1 emits a single uniform notification regardless of outcome. Owner: author; low priority.
- **`--title` default provenance.** Finalized: default is the literal `stark-ntfy` (`ssot`); listed only to record that no environment-variable override was intentionally added.