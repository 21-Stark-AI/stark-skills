/**
 * RT2 startup recovery. SQLite is the sole rewrite transaction log
 * (the host-side `.pending-rewrites/` journal proposed in plan-review
 * erratum E5 is deleted in favor of this path).
 *
 * At server boot, walk `spool_files WHERE rewrite_state IN
 * ('pending','renamed')`. For each row, `fstat` the file on disk and:
 *
 *   - finish-forward (`committed`) if the on-disk size matches
 *     `target_size_bytes` — the prune CLI's `rename(2)` landed but the
 *     follow-up `update-mtime` POST never arrived. Apply the destructive
 *     transition (delete the truncated seqs from `event_offsets` +
 *     `chunk_offsets`, reset `tail_offsets.offset = 0`) and persist the
 *     on-disk mtime as `target_mtime_ns` + the run's `mtime_ns`. The
 *     server is the sole owner of the transition; there is no host-side
 *     journal.
 *   - finish-back (`aborted`) otherwise — the rename never happened
 *     (or was rolled back). Clear the pending fields.
 *
 * If a prior recovery sweep already persisted `target_mtime_ns` (or a
 * future schema variant pre-populates it before rename), the stricter
 * size-AND-mtime match is required — the on-disk mtime must equal the
 * persisted target. This is the defensive branch; the realistic
 * post-rename/pre-update crash path has `target_mtime_ns IS NULL` and
 * is handled by the size-only branch above.
 *
 * The recovery sweep runs in a single SQLite write transaction per
 * row so a crash mid-recovery is replay-safe on the next boot.
 */

import fs from "node:fs";

import type Database from "better-sqlite3";

type DbHandle = Database.Database;

export interface RecoveryStats {
  scanned: number;
  committed: number;
  aborted: number;
  skipped: number;
}

interface PendingRow {
  run_id: string;
  rotation_index: number;
  file_path: string;
  rewrite_pending_truncated_json: string | null;
  target_size_bytes: number | null;
  target_mtime_ns: number | null;
  rewrite_state: string;
}

/** Optional FS façade so tests can drive recovery without touching real disk. */
export interface RewriteRecoveryFs {
  statSync(path: string): { size: number; mtimeMs: number };
}

const realFs: RewriteRecoveryFs = {
  statSync: (p) => {
    const st = fs.statSync(p);
    return { size: st.size, mtimeMs: st.mtimeMs };
  },
};

export function recoverPendingRewrites(
  db: DbHandle,
  fsFacade: RewriteRecoveryFs = realFs,
): RecoveryStats {
  const stats: RecoveryStats = {
    scanned: 0,
    committed: 0,
    aborted: 0,
    skipped: 0,
  };

  const rows = db
    .prepare(
      `SELECT run_id, rotation_index, file_path,
              rewrite_pending_truncated_json, target_size_bytes,
              target_mtime_ns, rewrite_state
         FROM spool_files
        WHERE rewrite_state IN ('pending','renamed')`,
    )
    .all() as PendingRow[];

  const deleteEventOffsetSeq = db.prepare(
    `DELETE FROM event_offsets WHERE run_id = ? AND seq = ?`,
  );
  const deleteChunkOffsetSeq = db.prepare(
    `DELETE FROM chunk_offsets WHERE run_id = ? AND seq = ?`,
  );
  const resetTailOffset = db.prepare(
    `INSERT INTO tail_offsets (file_path, offset, mtime_ns)
     VALUES (?, 0, ?)
     ON CONFLICT(file_path) DO UPDATE SET offset = 0, mtime_ns = excluded.mtime_ns`,
  );
  const commitRewrite = db.prepare(
    `UPDATE spool_files
        SET size_bytes = COALESCE(rewrite_pending_size_bytes, size_bytes),
            mtime_ns   = ?,
            rewrite_pending = 0,
            rewrite_pending_size_bytes = NULL,
            rewrite_pending_truncated_json = NULL,
            deleted_at = NULL,
            rewrite_state = 'committed',
            target_mtime_ns = ?,
            rewrite_txn_id = NULL
      WHERE run_id = ? AND rotation_index = ?`,
  );
  const abortRewrite = db.prepare(
    `UPDATE spool_files
        SET rewrite_pending = 0,
            rewrite_pending_size_bytes = NULL,
            rewrite_pending_truncated_json = NULL,
            rewrite_state = 'aborted',
            target_size_bytes = NULL,
            target_mtime_ns = NULL,
            rewrite_txn_id = NULL
      WHERE run_id = ? AND rotation_index = ?`,
  );

  for (const row of rows) {
    stats.scanned += 1;
    let st: { size: number; mtimeMs: number } | null = null;
    try {
      st = fsFacade.statSync(row.file_path);
    } catch {
      st = null;
    }
    const target = row.target_size_bytes;
    const targetMtime = row.target_mtime_ns;
    const mtimeNs = st !== null ? Math.floor(st.mtimeMs * 1_000_000) : null;
    // RT2 finish-forward: server is the sole owner of the rewrite
    // transition state. Pre-rename intentionally leaves `target_mtime_ns`
    // NULL (the rename's mtime is unknowable until after the syscall),
    // so the realistic post-rename/pre-update crash recovers by:
    //
    //   1. target_mtime_ns IS NULL + on-disk size == target_size_bytes
    //      → rename(2) landed; capture the current on-disk mtime as
    //        the actual mtime and finish-forward.
    //   2. target_mtime_ns IS NOT NULL + on-disk (size AND mtime) match
    //      → strict path; finish-forward.
    //
    // Any other state → finish-back. The system stays consistent in
    // either direction because the tailer re-reads from offset = 0
    // after recovery and authoritatively re-inserts chunk_truncations
    // (file rewritten) or chunk_offsets (file untouched) from actual
    // on-disk content.
    const sizeMatches =
      st !== null && typeof target === "number" && st.size === target;
    const finishForward =
      sizeMatches &&
      mtimeNs !== null &&
      (targetMtime === null || mtimeNs === targetMtime);
    if (finishForward) {
      const txn = db.transaction(() => {
        const seqs = parseStoredTruncatedSeqs(
          row.rewrite_pending_truncated_json,
        );
        for (const seq of seqs) {
          deleteChunkOffsetSeq.run(row.run_id, seq);
          deleteEventOffsetSeq.run(row.run_id, seq);
        }
        resetTailOffset.run(row.file_path, mtimeNs);
        commitRewrite.run(mtimeNs, mtimeNs, row.run_id, row.rotation_index);
      });
      txn();
      stats.committed += 1;
    } else {
      const txn = db.transaction(() => {
        abortRewrite.run(row.run_id, row.rotation_index);
      });
      txn();
      stats.aborted += 1;
    }
  }

  return stats;
}

function parseStoredTruncatedSeqs(stored: string | null): number[] {
  if (typeof stored !== "string" || stored.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: number[] = [];
  for (const entry of parsed) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const seq = (entry as Record<string, unknown>).seq;
      if (typeof seq === "number" && Number.isInteger(seq) && seq >= 0) {
        out.push(seq);
      }
    }
  }
  return out;
}
