#!/usr/bin/env node
/**
 * emit-queue CLI — TS replacement for `python3 scripts/emit_queue.py --health`
 * and the per-tick `record_context_pct` import that statusline-command.sh runs.
 *
 * Subcommands:
 *   --health                         Print queue health stats as JSON, exit 0.
 *                                    Shape matches the Python `_health()` so
 *                                    /stark-session can swap consumers freely.
 *   --init-schema                    Open the queue DB to force schema
 *                                    creation. Used by install.sh in place of
 *                                    the prior `import emit_queue` heredoc.
 *   record-context-pct <pct>         Record a context-window % reading and
 *                                    print the trend indicator (▲ / ▸ / "")
 *                                    on a single line (no trailing newline).
 *   pending-count                    Print queue pending row count, one int.
 *   dead-letter-count                Print dead_letter row count, one int.
 *
 * Both Python (`scripts/emit_queue.py`) and TS implementations write to the
 * same `~/.stark-insights/queue.db` SQLite, so a Python drain still picks up
 * rows enqueued by TS callers and vice versa.
 */

import {
  deadLetterCount,
  health,
  initSchema,
  pendingCount,
  recordContextPct,
} from "./emit_queue_lib.ts";

const USAGE = `\
emit-queue CLI

  emit_queue_cli.ts --health
  emit_queue_cli.ts --init-schema
  emit_queue_cli.ts record-context-pct <pct>
  emit_queue_cli.ts pending-count
  emit_queue_cli.ts dead-letter-count
`;

export function main(argv: string[]): number {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(USAGE);
    return 0;
  }

  const cmd = argv[0];

  if (cmd === "--health") {
    process.stdout.write(JSON.stringify(health(), null, 2) + "\n");
    return 0;
  }

  if (cmd === "--init-schema") {
    initSchema();
    return 0;
  }

  if (cmd === "record-context-pct") {
    const raw = argv[1];
    if (raw === undefined) {
      process.stderr.write("record-context-pct: missing <pct> argument\n");
      return 2;
    }
    const pct = Number(raw);
    if (!Number.isFinite(pct)) {
      process.stderr.write(`record-context-pct: <pct> must be a finite number, got: ${raw}\n`);
      return 2;
    }
    process.stdout.write(recordContextPct(pct));
    return 0;
  }

  if (cmd === "pending-count") {
    process.stdout.write(String(pendingCount()) + "\n");
    return 0;
  }

  if (cmd === "dead-letter-count") {
    process.stdout.write(String(deadLetterCount()) + "\n");
    return 0;
  }

  process.stderr.write(`unknown command: ${cmd}\n${USAGE}`);
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
