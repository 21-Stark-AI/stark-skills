# Stark Review Observability — Design

- **Date:** 2026-05-25
- **Status:** Draft
- **Owner:** Aryeh Kiovetsky
- **Scope:** localhost personal-playground tooling (stark-skills repo)

## Problem

`/stark-review` and the other multi-agent dispatchers in this repo
(`/stark-copilot`, `/stark-red-team-design`, `/stark-red-team-plan`,
`/stark-design-to-plan`, `/stark-plan-to-tasks`, `/stark-phase-execute`,
`/stark-review-design`, `/stark-review-plan`) regularly run for **30–90
minutes**. During that window the operator has zero visibility into:

- which sub-agents are alive vs stalled
- which sub-agent is burning the most tokens / time
- whether a long run is legitimately busy or a hung CLI

Today the only signal is **post-completion** `agent_dispatch` +
`review_finding` events written to `~/.stark-insights/queue.db` (see
`tools/multi_review_lib.ts:1129` and `tools/multi_review_lib.ts:1148`). No
mid-flight visibility. A 90-minute run looks identical to a deadlocked run
until it terminates.

## Goal

Localhost observability stack: a Docker container hosts a web server + UI.
Every `/stark-*` dispatcher streams **lifecycle**, **structured progress**,
and **full token-level stdout/stderr** events to a JSONL spool on disk. The
UI displays runs grouped by **repo → branch → PR → sub-agent**, with live
tail of the selected sub-agent and history search across the last 30 days.

Success means: while a 90-minute `/stark-review` is in flight, the operator
can open the UI, see all 27 sub-agents on one screen, identify the two that
are currently producing output and the three that have been silent for >5
minutes, and read the live token stream of any one of them in <2 seconds.

## Non-goals

- Multi-user / team-shared deployment
- Authentication or TLS
- Aggregation across multiple Macs
- Replacing the existing `~/.stark-insights/queue.db` pipeline — this stack
  is **independent**; the insights queue still ingests
  `agent_dispatch`/`review_finding` post-completion events
- Production hardening (this is a personal playground; per repo CLAUDE.md
  the rule is "ship straight to main, no rollout ceremony")

## Architecture

```
┌──────────────────────── HOST (Mac) ────────────────────────┐
│  /stark-review  /stark-copilot  /stark-red-team-* (etc.)   │
│       │              │                │                    │
│       └──────────────┴────────┬───────┘                    │
│                               ▼                            │
│      tools/observability_emit_lib.ts (new)                 │
│        • run_id  = uuid per invocation                     │
│        • subagent_id = run_id:agent:task                   │
│        • wraps runProcess(): pipes stdout/stderr chunks    │
│        • appends events to JSONL                           │
│                               ▼                            │
│  ~/.claude/code-review/observability/runs/{run_id}.jsonl   │
└───────────────────────────────┼────────────────────────────┘
                                │  (bind mount, read-only)
┌───────────── DOCKER (localhost:7700) ──────────────────────┐
│                               ▼                            │
│  fs.watch ─► tailer ─► event bus (in-proc) ─► WebSocket    │
│              │                  │                          │
│              ▼                  ▼                          │
│        SQLite index         browser UI                     │
│        (search/history)     (live + history)               │
└────────────────────────────────────────────────────────────┘
```

**Key idea: append-only JSONL is the contract.** Dispatchers write; the
docker container reads. If the container is down the reviews still run and
events queue up on disk; when the container comes up, the tailer replays
from the last persisted offset (stored in the SQLite index) and the UI
backfills.

## Components

### 1. Emit library — `tools/observability_emit_lib.ts` (new)

New TypeScript module. All functions are **best-effort**: failures are
swallowed and logged once per process to stderr, never thrown. Dispatcher
behavior MUST be identical whether observability succeeds or fails.

Surface:

```ts
export interface RunCtx {
  runId: string;
  dispatcher: string;
  repo?: string;
  branch?: string;
  prNumber?: number;
  startedAt: string;
}

export interface SubAgent {
  subagentId: string;
  agent: "claude" | "codex" | "gemini" | string;
  model: string;
  task: string;
}

export function startRun(opts: Omit<RunCtx, "runId" | "startedAt">): RunCtx;
export function endRun(ctx: RunCtx, status: "ok" | "error" | "timeout"): void;

export function startSubAgent(ctx: RunCtx, sa: SubAgent): void;
export function endSubAgent(
  ctx: RunCtx,
  sa: SubAgent,
  status: "ok" | "error" | "timeout",
  durationMs: number,
  summary?: Record<string, unknown>,
): void;

export function emitProgress(
  ctx: RunCtx,
  sa: SubAgent | null,
  kind: string,
  payload: Record<string, unknown>,
): void;

/**
 * Attach observability taps to a spawned child process. Returns
 * passthrough streams to forward into the existing `runProcess`
 * stdout/stderr capture so the dispatcher receives identical bytes.
 */
export function attachChild(
  ctx: RunCtx,
  sa: SubAgent,
  child: import("node:child_process").ChildProcess,
): void;
```

`attachChild` is the load-bearing function. It subscribes additional
listeners to `child.stdout`/`child.stderr` `"data"` events, **without
consuming the existing buffers** that `runProcess` already accumulates. It
buffers chunks in a per-subagent ring (max 4 KB or 50 ms of latency,
whichever comes first) before writing one `subagent_stdout` /
`subagent_stderr` event per flush.

### 2. Spool format

Path: `~/.claude/code-review/observability/runs/{run_id}.jsonl`. One JSON
object per line. Append-only. Rotation: when a file exceeds 100 MB, the
emit lib closes it and starts `{run_id}.1.jsonl`, `{run_id}.2.jsonl`, etc.
The logical run continues across rotations.

Event types:

| Type                | Required fields                                                                       |
| ------------------- | ------------------------------------------------------------------------------------- |
| `run_start`         | `run_id`, `dispatcher`, `repo?`, `branch?`, `pr_number?`, `started_at`, `version`     |
| `subagent_start`    | `run_id`, `subagent_id`, `agent`, `model`, `task`, `started_at`                       |
| `subagent_stdout`   | `run_id`, `subagent_id`, `chunk`, `ts`, `encoding` (`"utf8"` \| `"base64"`)           |
| `subagent_stderr`   | (same as stdout)                                                                      |
| `subagent_progress` | `run_id`, `subagent_id?`, `kind`, `payload`, `ts`                                     |
| `subagent_end`      | `run_id`, `subagent_id`, `status`, `duration_ms`, `summary?`, `ts`                    |
| `run_end`           | `run_id`, `status`, `ended_at`                                                        |

`chunk` is the raw process output. UTF-8 by default; invalid sequences
trigger `encoding: "base64"` and the chunk is base64-encoded. Chunks larger
than 64 KB are split.

### 3. Docker server — `tools/observability_server/`

Single container, image based on `node:22-alpine`. Mounts
`~/.claude/code-review/observability/runs/` **read-only**.

Container subcomponents (one Node process):

- **Tailer.** Watches the spool dir via `fs.watch` (using `chokidar` to
  smooth over the well-known macOS `fs.watch` quirks). On a new file or
  append, reads from the last-known offset, parses JSONL, pushes events to
  the in-proc event bus. Restart-safe: per-file offset is persisted in
  SQLite (`tail_offsets` table).
- **Index writer.** Subscribes to the bus; UPSERTs into the SQLite index.
  Token-stream events (`subagent_stdout`/`subagent_stderr`) increment a
  byte counter in `subagents` but their `chunk` field is NOT stored in
  SQLite — chunks live in the JSONL files only.
- **WebSocket hub.** One WebSocket endpoint at `/ws`. Clients subscribe to
  `{type: "subscribe", filter: {...}}` (filters by `run_id`,
  `subagent_id`, `repo`, or `live: true` for all currently-running runs).
  Pushes JSON-encoded events matching the filter.
- **HTTP API.** REST endpoints (see below).
- **Static UI.** Single-page React app served from `/`.

Port: `7700` (overridable via env `OBSERVABILITY_PORT`).

### 4. SQLite index schema (`/data/index.db`, named docker volume)

```sql
CREATE TABLE IF NOT EXISTS runs (
  run_id           TEXT PRIMARY KEY,
  dispatcher       TEXT NOT NULL,
  repo             TEXT,
  branch           TEXT,
  pr_number        INTEGER,
  started_at       TEXT NOT NULL,
  ended_at         TEXT,
  status           TEXT,
  total_subagents  INTEGER DEFAULT 0,
  total_findings   INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS subagents (
  subagent_id    TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  agent          TEXT NOT NULL,
  model          TEXT,
  task           TEXT NOT NULL,
  started_at     TEXT NOT NULL,
  ended_at       TEXT,
  status         TEXT,
  duration_ms    INTEGER,
  stdout_bytes   INTEGER DEFAULT 0,
  stderr_bytes   INTEGER DEFAULT 0,
  summary_json   TEXT
);

CREATE TABLE IF NOT EXISTS tail_offsets (
  file_path TEXT PRIMARY KEY,
  offset    INTEGER NOT NULL,
  mtime_ns  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_repo_started  ON runs(repo, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status        ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_started       ON runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_subagents_run      ON subagents(run_id);
CREATE INDEX IF NOT EXISTS idx_subagents_status   ON subagents(status);
```

`status` values: `running | ok | error | timeout`.

### 5. HTTP API

| Method | Path                                      | Returns                                      |
| ------ | ----------------------------------------- | -------------------------------------------- |
| GET    | `/api/runs?repo=&dispatcher=&status=&limit=&since=` | paginated runs                       |
| GET    | `/api/runs/:run_id`                       | run + sub-agent list                         |
| GET    | `/api/runs/:run_id/subagents/:sid`        | sub-agent metadata                           |
| GET    | `/api/runs/:run_id/subagents/:sid/chunks?from=&to=` | streamed stdout/stderr chunks      |
| GET    | `/api/health`                             | tailer status + lag + DB size                |
| WS     | `/ws`                                     | filtered live event stream                   |

Chunk endpoint reads the JSONL files directly and emits a server-sent
stream of decoded chunks (no full materialization in memory).

### 6. UI

Single-page React 18 app, built with Vite. Stack: TanStack Query for HTTP,
native `WebSocket` for streaming, no SSR.

Default layout (single-pane two-column):

- **Left rail (tree):** Repo → Branch → PR → Run → Sub-agent. Live runs
  sorted to top with a pulse indicator next to currently-emitting
  sub-agents. Clicking any node selects it.
- **Right pane (detail):**
  - If a Run is selected → a sortable table of its sub-agents with
    columns: agent, task, status, elapsed, stdout bytes, stderr bytes,
    finding count, last-output-at.
  - If a Sub-agent is selected → a live-tailing log view of its stdout
    (collapsible stderr panel beneath), plus a structured findings list
    that fills in as `subagent_progress { kind: "finding" }` events
    arrive.

Top bar: filter by dispatcher (`multi_review`, `copilot`, `red_team_design`,
…), status, time window.

History tab: search the SQLite index by repo, dispatcher, date range, or
status. Clicking a result loads the run in the main pane (live or replay).

### 7. Retention

Background job inside the container, runs hourly:

- spool files with `mtime` > 30 days → deleted from disk
- `runs` rows whose latest spool file is missing → deleted (ON DELETE CASCADE
  drops `subagents` rows)
- retention window overridable via `OBSERVABILITY_RETENTION_DAYS` env

## Integration with existing dispatchers

The following dispatcher entry points get a `RunCtx` at startup and pass it
through to a wrapped `runProcess`:

- `tools/multi_review_lib.ts` (entry: `runReview`, child spawner: line 593)
- `tools/copilot_dispatch.ts`
- `tools/plan_dispatch.ts`
- `tools/red_team_lib.ts` (called from `red_team_design.ts` /
  `red_team_plan.ts`)
- `tools/stark_review_doc.ts`
- `tools/plan_to_tasks_validate_lib.ts`
- `tools/stark_review.ts` (single-agent path)

The wrapping is mechanical: each dispatcher initializes `RunCtx` at the
top of its CLI `main`, then every `runProcess` call inside the dispatcher
becomes `runProcess(cmd, args, opts, { ctx, sa })`. The third-arg overload
calls `attachChild()` after spawn. Existing return semantics are unchanged.

## Security

- All data is read from the local filesystem only. No outbound network.
- Server binds `127.0.0.1` only (overridable via `OBSERVABILITY_BIND`).
- No auth (single-user, localhost).
- Token streams may contain secrets if a dispatcher accidentally leaks
  them in agent output. Mitigation already lives upstream in
  `tools/runtime_env_lib.ts` (env scrubbing for sub-process invocations);
  the observability stack does not add a second redaction pass. Anything
  in agent stdout is treated as already-safe-to-display per existing stark
  practice.

## Testing

- **Unit** — `tools/observability_emit_lib.test.ts`: runId stability, JSONL
  shape, swallow-failure semantics, chunk-encoding/base64-fallback,
  rotation at 100 MB.
- **Unit** — `tools/observability_server/tailer.test.ts`: replay from
  offset, partial-line handling, file rotation handling, mtime regression.
- **Unit** — index-writer tests: schema migration idempotency, UPSERT
  ordering when events arrive out of order across run boundaries.
- **Integration** — spawn a docker compose stack against a temp HOME, fire
  a synthetic run via the emit lib, assert WebSocket delivers events in
  order and the SQLite index reflects them.
- **Live** — run `/stark-review` against a real PR with the stack up,
  manually verify all sub-agents appear and stream.

## Deployment

New directory: `tools/observability_server/`

```
tools/observability_server/
├── Dockerfile
├── docker-compose.yml
├── package.json
├── tsconfig.json
├── server/                # Node/TS source
│   ├── index.ts
│   ├── tailer.ts
│   ├── index_writer.ts
│   ├── websocket_hub.ts
│   ├── http_api.ts
│   └── retention.ts
└── ui/                    # React/Vite source
    ├── index.html
    ├── package.json
    ├── vite.config.ts
    └── src/
        └── …
```

`docker-compose.yml` mounts:
- `~/.claude/code-review/observability/runs:/spool:ro`
- named volume `observability_index:/data`

Start: `docker compose -f tools/observability_server/docker-compose.yml up -d`.

UI: `http://localhost:7700`.

CLAUDE.md update (this repo + workspace-root) and a one-liner in
`AGENTS.md` mention the stack and how to start it.

## Open questions

None — all open clarifications resolved during the 2026-05-25 brainstorming
session (scope, granularity, persistence, deploy shape, transport).
