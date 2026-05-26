/**
 * Zod schemas for the canonical three-action `POST /api/internal/
 * retention/notify` body. Single source of truth — referenced by
 * Phase 3 Task 4 (server) and by Phase 7 Task 3 (prune CLI builders).
 *
 * Strict mode is REQUIRED: a pre-rename body that smuggles
 * `new_mtime_ns` MUST be rejected, and an update-mtime body that
 * smuggles `truncated[]` MUST be rejected. Both confusions could
 * arise from a CLI that crashed mid-flow and replayed with a stale
 * payload.
 */

import { z } from "zod";

const filePathSchema = z
  .string()
  .min(1)
  .regex(
    /^\/spool\/runs\/[A-Za-z0-9._-]+\/events-\d{4,}\.jsonl$/,
    "file_path must be /spool/runs/<runId>/events-<NNNN>.jsonl",
  );

const truncatedEntrySchema = z
  .object({
    seq: z.number().int().nonnegative(),
    subagent_id: z.string().min(1),
    stream: z.enum(["stdout", "stderr"]),
    bytes_dropped: z.number().int().nonnegative(),
  })
  .strict();

// RT2: every notify POST carries an opaque per-attempt transaction id
// minted by the prune CLI. The server is the only owner of the
// `spool_files.rewrite_state` transitions; `rewrite_txn_id` lets a
// retry verify it is targeting its own attempt and lets the startup
// recovery sweep correlate on-disk state with the SQLite transition.
const rewriteTxnIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, "rewrite_txn_id must be a stable opaque token");

export const preRenameBodySchema = z
  .object({
    action: z.literal("pre-rename"),
    run_id: z.string().min(1),
    rotation_index: z.number().int().nonnegative(),
    file_path: filePathSchema,
    new_size_bytes: z.number().int().nonnegative(),
    truncated: z.array(truncatedEntrySchema).min(1),
    rewrite_txn_id: rewriteTxnIdSchema,
  })
  .strict();

export const updateMtimeBodySchema = z
  .object({
    action: z.literal("update-mtime"),
    run_id: z.string().min(1),
    rotation_index: z.number().int().nonnegative(),
    file_path: filePathSchema,
    new_mtime_ns: z.number().int().nonnegative(),
    rewrite_txn_id: rewriteTxnIdSchema,
  })
  .strict();

export const abortRewriteBodySchema = z
  .object({
    action: z.literal("abort-rewrite"),
    run_id: z.string().min(1),
    rotation_index: z.number().int().nonnegative(),
    rewrite_txn_id: rewriteTxnIdSchema,
  })
  .strict();

export const retentionNotifyBodySchema = z.discriminatedUnion("action", [
  preRenameBodySchema,
  updateMtimeBodySchema,
  abortRewriteBodySchema,
]);

// E7: `POST /api/internal/retention/scan-now` — the prune CLI calls
// this when `pre-rename` returns 409 `scan_pending` to force an
// immediate filesystem scan instead of waiting for the next chokidar /
// 10 s backup sweep tick. All fields are optional: an empty body runs
// a full backup sweep; otherwise the named run / rotation is targeted.
export const scanNowBodySchema = z
  .object({
    run_id: z.string().min(1).optional(),
    rotation_index: z.number().int().nonnegative().optional(),
  })
  .strict();

// Wing-finding regression: if the prune CLI crashes / errors after a
// successful `rename(2)` but before / during `update-mtime`, the
// `spool_files` row stays in `rewrite_state='pending'` and the tailer
// stays paused on that file. The next prune cycle's `streamRewrite`
// finds no `subagent_stdout`/`subagent_stderr` lines (the file has
// already been rewritten in place), so pre-rename never fires and the
// row never recovers without a server restart.
//
// The retention listener exposes `POST /internal/retention/recover-
// pending` which drives the same `recoverPendingRewrites` sweep that
// runs at server boot — `fstat` each pending row's file and finish-
// forward (commit) or finish-back (abort) the SQLite transition. The
// prune CLI calls this endpoint at the start of every cycle. Body is
// intentionally empty so the server's recovery sweep stays the only
// owner of the transition logic.
export const recoverPendingBodySchema = z.object({}).strict();

export type PreRenameBody = z.infer<typeof preRenameBodySchema>;
export type UpdateMtimeBody = z.infer<typeof updateMtimeBodySchema>;
export type AbortRewriteBody = z.infer<typeof abortRewriteBodySchema>;
export type RetentionNotifyBody = z.infer<typeof retentionNotifyBodySchema>;
export type ScanNowBody = z.infer<typeof scanNowBodySchema>;
export type RecoverPendingBody = z.infer<typeof recoverPendingBodySchema>;
