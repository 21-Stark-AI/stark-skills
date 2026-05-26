#!/usr/bin/env -S node --experimental-strip-types
/**
 * Phase 7 host-side prune CLI for the stark-review observability stack.
 *
 * Two retention dimensions: age (`--retention-days`, default 30) and
 * total bytes (`--total-cap-gb`, default 50). The CLI:
 *
 *   1. Sweeps `.trash/` for any subdir older than the 60 s grace window
 *      and `rm -rf`s it. (Phase 7 Task 2: the grace lets the container
 *      tailer notice the dir disappearing and mark `spool_files.deleted_at`
 *      before bytes go away.)
 *   2. Reconciles host-side `meta.json` files for runs the container's
 *      liveness sweeper marked crashed via SQLite-only. The list comes
 *      from `GET /api/internal/retention/crashed-runs` on the retention
 *      listener (E4 Option B). On hit, the CLI atomically rewrites
 *      `meta.json` with the API's `ended_at` so the run becomes
 *      prune-eligible.
 *   3. Partitions surviving runs into age-prunable (terminal + older
 *      than `--retention-days`) and the rest. Age-prunable dirs move
 *      via `rename(2)` to `.trash/{run_id}/` and a `.moved_at` file is
 *      written; the actual `rm -rf` happens on the next prune cycle.
 *   4. If post-age total bytes > cap, runs the per-file streaming
 *      truncation routine for the oldest 25 % of terminal survivors.
 *      Still over cap → deletes oldest entire runs.
 *
 * Per-file rewrite is the canonical pre-rename → rename(2) → fstat →
 * update-mtime three-step. On `rename(2)` failure the CLI sends the
 * `abort-rewrite` action to release the server-side rewrite gate.
 *
 * Token: `security find-generic-password -s stark-observability-prune-token -w`.
 * The Keychain is the SOLE token surface; no helper-stdout, no env var,
 * no flag. The CLI never accepts the bootstrap-token credential.
 *
 * Output: structured JSON on stdout per the `PruneResult` shape, suitable
 * for `jq` pipelines. The CLI also appends a single JSON line to
 * `~/.claude/code-review/observability/prune.log` and self-trims entries
 * older than 90 days on each run.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import crypto from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import {
  OBSERVABILITY_ROOT,
  ensureRoot,
  ensurePrivateDir,
  metaPath,
  runDir,
  runsDir,
  trashDir,
} from "./observability_paths_lib.ts";

const KEYCHAIN_SERVICE = "stark-observability-prune-token";
const CONTAINER_SPOOL_PREFIX = "/spool/runs";
const TRASH_GRACE_MS = 60_000;
const PRUNE_LOG_TRIM_DAYS = 90;
const DAY_MS = 86_400_000;

const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_TOTAL_CAP_GB = 50;
const DEFAULT_RETENTION_BASE = "http://127.0.0.1:7701";

const PRE_RENAME_RETRY_MAX = 4;
const UPDATE_MTIME_RETRY_MAX = 6;
const RETRY_BASE_MS = 250;
const RETRY_MAX_MS = 8_000;

const RESCUE_HINT =
  "[observability_prune] run: node --experimental-strip-types tools/observability_open.ts --no-browser";

export interface CliArgs {
  retentionDays: number;
  totalCapGb: number;
  dryRun: boolean;
  json: boolean;
}

export interface MetaJson {
  run_id?: string;
  started_at?: string;
  ended_at?: string | null;
  status?: string | null;
  crashed_reason?: string | null;
  bytes_written?: number | null;
  rotation_index?: number | null;
  [k: string]: unknown;
}

export interface SpoolFileInfo {
  rotationIndex: number;
  filePath: string;
  sizeBytes: number;
}

export interface RunOnDisk {
  runId: string;
  dir: string;
  meta: MetaJson;
  totalBytes: number;
  files: SpoolFileInfo[];
  endedAtMs: number | null;
}

export interface TruncatedEntry {
  seq: number;
  subagent_id: string;
  stream: "stdout" | "stderr";
  bytes_dropped: number;
}

export interface PreRenameBody {
  action: "pre-rename";
  run_id: string;
  rotation_index: number;
  file_path: string;
  new_size_bytes: number;
  truncated: TruncatedEntry[];
  rewrite_txn_id: string;
}

export interface UpdateMtimeBody {
  action: "update-mtime";
  run_id: string;
  rotation_index: number;
  file_path: string;
  new_mtime_ns: number;
  rewrite_txn_id: string;
}

export interface AbortRewriteBody {
  action: "abort-rewrite";
  run_id: string;
  rotation_index: number;
  rewrite_txn_id: string;
}

export interface CrashedRunsItem {
  run_id: string;
  ended_at: string | null;
  crashed_reason: string | null;
  status: string | null;
}

export interface RecoverPendingStats {
  scanned: number;
  committed: number;
  aborted: number;
  skipped: number;
}

export interface PruneError {
  stage: string;
  run_id?: string;
  rotation_index?: number;
  file?: string;
  message: string;
}

export interface PruneTruncationRecord {
  run_id: string;
  rotation_index: number;
  bytes_dropped: number;
  seqs: number[];
}

export interface PruneResult {
  deleted: string[];
  truncated: PruneTruncationRecord[];
  bytes_reclaimed: number;
  errors: PruneError[];
}

export interface PruneDeps {
  readToken: () => string;
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Override observability root (tests). Defaults to OBSERVABILITY_ROOT. */
  obsRoot?: string;
  /** Override retention base URL. */
  retentionBase?: string;
  /** Override now (tests). */
  now?: () => number;
  /** When true, skip ensureRoot — tests prefer to set up paths themselves. */
  skipEnsureRoot?: boolean;
}

// ---------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------

export function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    retentionDays: envInt("OBSERVABILITY_RETENTION_DAYS", DEFAULT_RETENTION_DAYS),
    totalCapGb: envInt("OBSERVABILITY_TOTAL_CAP_GB", DEFAULT_TOTAL_CAP_GB),
    dryRun: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--retention-days") out.retentionDays = mustInt(argv[++i], "--retention-days");
    else if (a === "--total-cap-gb") out.totalCapGb = mustInt(argv[++i], "--total-cap-gb");
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--json") out.json = true;
    else throw new Error(`unknown arg: ${a}`);
  }
  return out;
}

function envInt(name: string, def: number): number {
  const v = process.env[name];
  if (!v) return def;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`env ${name} must be a non-negative integer; got ${v}`);
  }
  return n;
}

function mustInt(raw: string | undefined, label: string): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${label} requires a non-negative integer`);
  }
  return n;
}

// ---------------------------------------------------------------------
// Token resolution (Keychain — sole surface)
// ---------------------------------------------------------------------

export function readPruneTokenFromKeychain(): string {
  const r = spawnSync(
    "/usr/bin/security",
    ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    process.stderr.write(
      `[observability_prune] missing Keychain entry for ${KEYCHAIN_SERVICE}\n` +
        RESCUE_HINT +
        "\n",
    );
    process.exit(2);
  }
  return r.stdout.trim();
}

// ---------------------------------------------------------------------
// Path helpers (override-aware)
// ---------------------------------------------------------------------

interface ResolvedPaths {
  root: string;
  runsRoot: string;
  trashRoot: string;
  pruneLog: string;
  runDir(id: string): string;
  metaPath(id: string): string;
  containerPath(runId: string, rotationIndex: number): string;
}

function resolvePaths(rootOverride?: string): ResolvedPaths {
  if (!rootOverride) {
    return {
      root: OBSERVABILITY_ROOT,
      runsRoot: runsDir(),
      trashRoot: trashDir(),
      pruneLog: path.join(OBSERVABILITY_ROOT, "prune.log"),
      runDir: (id) => runDir(id),
      metaPath: (id) => metaPath(id),
      containerPath: (runId, idx) =>
        `${CONTAINER_SPOOL_PREFIX}/${runId}/events-${padIdx(idx)}.jsonl`,
    };
  }
  return {
    root: rootOverride,
    runsRoot: path.join(rootOverride, "runs"),
    trashRoot: path.join(rootOverride, ".trash"),
    pruneLog: path.join(rootOverride, "prune.log"),
    runDir: (id) => path.join(rootOverride, "runs", sanitize(id)),
    metaPath: (id) =>
      path.join(rootOverride, "runs", sanitize(id), "meta.json"),
    containerPath: (runId, idx) =>
      `${CONTAINER_SPOOL_PREFIX}/${runId}/events-${padIdx(idx)}.jsonl`,
  };
}

function padIdx(n: number): string {
  return String(n).padStart(4, "0");
}

function sanitize(id: string): string {
  if (!id || id.includes("/") || id.includes("\\") || id.includes("..")) {
    throw new Error(`unsafe run id: ${id}`);
  }
  return id;
}

// ---------------------------------------------------------------------
// Disk walking
// ---------------------------------------------------------------------

export function walkRuns(paths: ResolvedPaths): RunOnDisk[] {
  let ids: string[] = [];
  try {
    ids = fs
      .readdirSync(paths.runsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name);
  } catch {
    return [];
  }
  const out: RunOnDisk[] = [];
  for (const id of ids) {
    out.push(loadRun(paths, id));
  }
  return out;
}

function loadRun(paths: ResolvedPaths, runId: string): RunOnDisk {
  const dir = paths.runDir(runId);
  const meta = readMeta(paths.metaPath(runId));
  const files: SpoolFileInfo[] = [];
  let totalBytes = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      const m = name.match(/^events-(\d{4,})\.jsonl$/);
      if (!m) continue;
      const idx = Number.parseInt(m[1]!, 10);
      const fp = path.join(dir, name);
      let size = 0;
      try {
        size = fs.statSync(fp).size;
      } catch {
        continue;
      }
      files.push({ rotationIndex: idx, filePath: fp, sizeBytes: size });
      totalBytes += size;
    }
  } catch {
    // run dir missing; treat as empty
  }
  files.sort((a, b) => a.rotationIndex - b.rotationIndex);
  return {
    runId,
    dir,
    meta,
    totalBytes,
    files,
    endedAtMs: parseDateMs(meta.ended_at),
  };
}

function readMeta(p: string): MetaJson {
  try {
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as MetaJson;
    }
  } catch {
    // missing or malformed
  }
  return {};
}

function parseDateMs(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------
// Atomic writes
// ---------------------------------------------------------------------

export function atomicWriteJson(target: string, value: unknown): void {
  const tmp = target + ".tmp";
  const payload = JSON.stringify(value, null, 2) + "\n";
  const fd = fs.openSync(
    tmp,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC,
    0o600,
  );
  try {
    fs.writeSync(fd, payload);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
}

// ---------------------------------------------------------------------
// Server-authoritative pending-rewrite recovery
// ---------------------------------------------------------------------
//
// Wing-finding regression: if a prior cycle's `update-mtime` exhausted
// retries AFTER the `rename(2)` succeeded, the on-disk file is already
// rewritten (no more `subagent_stdout`/`subagent_stderr` chunks) but
// `spool_files.rewrite_state` stays `'pending'` and the tailer stays
// paused on that file. The next cycle's `streamRewrite` finds no
// truncation candidates, returns null, and pre-rename never fires —
// the row never recovers without a server restart.
//
// The retention listener exposes `POST /internal/retention/recover-
// pending` which drives the same `recoverPendingRewrites` sweep that
// runs at server boot. We invoke it at the start of every prune cycle
// so stuck rows finish-forward (commit) or finish-back (abort) before
// the cycle's pressure pass. Non-200 responses are recorded but never
// fatal — the cycle continues.

export async function recoverPendingViaServer(args: {
  retentionBase: string;
  token: string;
  fetchImpl: typeof fetch;
}): Promise<{ stats: RecoverPendingStats | null; error: PruneError | null }> {
  let res: Response;
  try {
    res = await args.fetchImpl(
      `${args.retentionBase}/api/internal/retention/recover-pending`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${args.token}`,
        },
        body: "{}",
      },
    );
  } catch (err) {
    return {
      stats: null,
      error: {
        stage: "recover-pending/fetch",
        message: (err as Error).message,
      },
    };
  }
  if (!res.ok) {
    return {
      stats: null,
      error: {
        stage: "recover-pending/http",
        message: `HTTP ${res.status}`,
      },
    };
  }
  let body: { stats?: RecoverPendingStats } | null = null;
  try {
    body = (await res.json()) as { stats?: RecoverPendingStats };
  } catch {
    body = null;
  }
  return { stats: body?.stats ?? null, error: null };
}

// ---------------------------------------------------------------------
// Reconciliation (E4 Option B)
// ---------------------------------------------------------------------

interface ReconcileOutput {
  reconciled: string[];
  errors: PruneError[];
}

export async function reconcileCrashedRuns(args: {
  paths: ResolvedPaths;
  retentionBase: string;
  token: string;
  fetchImpl: typeof fetch;
  dryRun: boolean;
}): Promise<ReconcileOutput> {
  const out: ReconcileOutput = { reconciled: [], errors: [] };
  let res: Response;
  try {
    res = await args.fetchImpl(
      `${args.retentionBase}/api/internal/retention/crashed-runs`,
      { headers: { Authorization: `Bearer ${args.token}` } },
    );
  } catch (err) {
    out.errors.push({
      stage: "reconcile/fetch",
      message: (err as Error).message,
    });
    return out;
  }
  if (!res.ok) {
    out.errors.push({
      stage: "reconcile/fetch",
      message: `crashed-runs returned HTTP ${res.status}`,
    });
    return out;
  }
  let body: { items?: CrashedRunsItem[] };
  try {
    body = (await res.json()) as { items?: CrashedRunsItem[] };
  } catch (err) {
    out.errors.push({
      stage: "reconcile/parse",
      message: (err as Error).message,
    });
    return out;
  }
  const items = Array.isArray(body.items) ? body.items : [];
  for (const item of items) {
    if (!item || typeof item.run_id !== "string") continue;
    if (!item.ended_at) continue;
    let mp: string;
    try {
      mp = args.paths.metaPath(item.run_id);
    } catch (err) {
      out.errors.push({
        stage: "reconcile/path",
        run_id: item.run_id,
        message: (err as Error).message,
      });
      continue;
    }
    if (!fs.existsSync(mp)) continue;
    const meta = readMeta(mp);
    if (typeof meta.ended_at === "string" && meta.ended_at.length > 0) continue;
    const merged: MetaJson = {
      ...meta,
      ended_at: item.ended_at,
      status: item.status ?? "crashed",
      crashed_reason: item.crashed_reason ?? meta.crashed_reason ?? null,
    };
    if (args.dryRun) {
      out.reconciled.push(item.run_id);
      continue;
    }
    try {
      atomicWriteJson(mp, merged);
      out.reconciled.push(item.run_id);
    } catch (err) {
      out.errors.push({
        stage: "reconcile/write",
        run_id: item.run_id,
        message: (err as Error).message,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------
// .trash sweep
// ---------------------------------------------------------------------

export function cleanTrash(args: {
  paths: ResolvedPaths;
  nowMs: number;
  dryRun: boolean;
}): { deleted: string[]; bytesReclaimed: number; errors: PruneError[] } {
  const out = { deleted: [] as string[], bytesReclaimed: 0, errors: [] as PruneError[] };
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(args.paths.trashRoot, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(args.paths.trashRoot, e.name);
    const movedFile = path.join(dir, ".moved_at");
    let movedMs = 0;
    try {
      movedMs = Date.parse(fs.readFileSync(movedFile, "utf8").trim());
      if (!Number.isFinite(movedMs)) movedMs = 0;
    } catch {
      movedMs = 0;
    }
    if (args.nowMs - movedMs < TRASH_GRACE_MS) continue;
    let bytes = 0;
    try {
      bytes = dirSize(dir);
    } catch {
      // best-effort byte count
    }
    if (args.dryRun) {
      out.deleted.push(e.name);
      out.bytesReclaimed += bytes;
      continue;
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      out.deleted.push(e.name);
      out.bytesReclaimed += bytes;
    } catch (err) {
      out.errors.push({
        stage: "trash/rm",
        run_id: e.name,
        message: (err as Error).message,
      });
    }
  }
  return out;
}

function dirSize(dir: string): number {
  let total = 0;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    let st: fs.Stats;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) total += dirSize(p);
    else total += st.size;
  }
  return total;
}

// ---------------------------------------------------------------------
// Age pruning
// ---------------------------------------------------------------------

export function moveRunToTrash(args: {
  paths: ResolvedPaths;
  run: RunOnDisk;
  nowMs: number;
  dryRun: boolean;
}): { ok: boolean; bytes: number; error?: PruneError } {
  if (args.dryRun) {
    return { ok: true, bytes: args.run.totalBytes };
  }
  try {
    ensurePrivateDir(args.paths.trashRoot);
  } catch (err) {
    return {
      ok: false,
      bytes: 0,
      error: {
        stage: "age/ensureTrash",
        run_id: args.run.runId,
        message: (err as Error).message,
      },
    };
  }
  const dst = path.join(args.paths.trashRoot, sanitize(args.run.runId));
  try {
    fs.renameSync(args.run.dir, dst);
  } catch (err) {
    return {
      ok: false,
      bytes: 0,
      error: {
        stage: "age/rename",
        run_id: args.run.runId,
        message: (err as Error).message,
      },
    };
  }
  try {
    fs.writeFileSync(path.join(dst, ".moved_at"), new Date(args.nowMs).toISOString(), {
      mode: 0o600,
    });
  } catch {
    // best-effort marker
  }
  return { ok: true, bytes: args.run.totalBytes };
}

// ---------------------------------------------------------------------
// Per-file streaming rewrite (Phase 7 Task 3)
// ---------------------------------------------------------------------
//
// RT2: SQLite is the SOLE rewrite transaction log. Every notify POST
// carries `rewrite_txn_id`; the retention listener owns the
// pending/renamed/committed/aborted transition state in `spool_files`
// and recovers stuck rows on its own startup (`fstat` against
// `target_size_bytes`/`target_mtime_ns`). The prune CLI keeps no
// host-side journal — if `update-mtime` exhausts retries, we throw
// and rely on the server-side recovery path to finish-forward or
// finish-back on its next startup. The next prune cycle either
// reuses the same gate by mint-new-txn pre-rename (server replaces
// the pending row) or moves on if the file has been swept.

interface RewriteOutcome {
  truncated: TruncatedEntry[];
  bytesDropped: number;
}

export async function rewriteFile(args: {
  paths: ResolvedPaths;
  run: RunOnDisk;
  file: SpoolFileInfo;
  retentionBase: string;
  token: string;
  fetchImpl: typeof fetch;
}): Promise<RewriteOutcome | null> {
  const tmpPath = args.file.filePath + ".tmp";
  const stream = await streamRewrite(args.file.filePath, tmpPath);
  if (stream.truncated.length === 0) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // already gone
    }
    return null;
  }
  const newSizeBytes = stream.newSizeBytes;
  const txnId = mintTxnId(args.run.runId, args.file.rotationIndex);
  const containerPath = args.paths.containerPath(
    args.run.runId,
    args.file.rotationIndex,
  );

  const preBody: PreRenameBody = {
    action: "pre-rename",
    run_id: args.run.runId,
    rotation_index: args.file.rotationIndex,
    file_path: containerPath,
    new_size_bytes: newSizeBytes,
    truncated: stream.truncated,
    rewrite_txn_id: txnId,
  };
  validatePreRenameBody(preBody);

  // Pre-rename + scan-now retry loop. 409 scan_pending → call scan-now,
  // back off, retry. Any other non-2xx → fatal for this file.
  let preOk = false;
  for (let attempt = 0; attempt < PRE_RENAME_RETRY_MAX; attempt++) {
    const result = await postJson(
      args.fetchImpl,
      `${args.retentionBase}/api/internal/retention/notify`,
      preBody,
      args.token,
    );
    if (result.status === 200) {
      preOk = true;
      break;
    }
    if (result.status === 409 && result.body?.code === "scan_pending") {
      await postJson(
        args.fetchImpl,
        `${args.retentionBase}/api/internal/retention/scan-now`,
        { run_id: args.run.runId, rotation_index: args.file.rotationIndex },
        args.token,
      );
      await sleep(backoffMs(attempt));
      continue;
    }
    safeUnlink(tmpPath);
    throw new Error(
      `pre-rename HTTP ${result.status}: ${JSON.stringify(result.body)}`,
    );
  }
  if (!preOk) {
    safeUnlink(tmpPath);
    throw new Error("pre-rename exhausted scan_pending retries");
  }

  // rename(2) the tmp over the original. On failure, drive abort-rewrite.
  try {
    fs.renameSync(tmpPath, args.file.filePath);
  } catch (renameErr) {
    const abortBody: AbortRewriteBody = {
      action: "abort-rewrite",
      run_id: args.run.runId,
      rotation_index: args.file.rotationIndex,
      rewrite_txn_id: txnId,
    };
    try {
      await postJson(
        args.fetchImpl,
        `${args.retentionBase}/api/internal/retention/notify`,
        abortBody,
        args.token,
      );
    } catch {
      // best-effort — surface the rename failure as the primary error
    }
    safeUnlink(tmpPath);
    throw renameErr;
  }

  const st = fs.statSync(args.file.filePath);
  const mtimeNs = Math.floor(st.mtimeMs * 1_000_000);

  const updBody: UpdateMtimeBody = {
    action: "update-mtime",
    run_id: args.run.runId,
    rotation_index: args.file.rotationIndex,
    file_path: containerPath,
    new_mtime_ns: mtimeNs,
    rewrite_txn_id: txnId,
  };
  validateUpdateMtimeBody(updBody);

  // Bounded backoff retry on update-mtime. 5xx → retry; 4xx → terminal.
  // RT2: if retries exhaust we throw and rely on the server's
  // startup-scan recovery (or the next prune cycle's pre-rename) to
  // finish the txn — no host-side journal.
  let lastErr: string | null = null;
  for (let attempt = 0; attempt < UPDATE_MTIME_RETRY_MAX; attempt++) {
    let result: HttpResult;
    try {
      result = await postJson(
        args.fetchImpl,
        `${args.retentionBase}/api/internal/retention/notify`,
        updBody,
        args.token,
      );
    } catch (err) {
      lastErr = (err as Error).message;
      await sleep(backoffMs(attempt));
      continue;
    }
    if (result.status === 200) {
      return {
        truncated: stream.truncated,
        bytesDropped: stream.bytesDropped,
      };
    }
    if (result.status >= 500) {
      lastErr = `HTTP ${result.status}`;
      await sleep(backoffMs(attempt));
      continue;
    }
    throw new Error(
      `update-mtime HTTP ${result.status}: ${JSON.stringify(result.body)}`,
    );
  }
  throw new Error(
    `update-mtime exhausted retries: ${lastErr ?? "no response"}`,
  );
}

function backoffMs(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempt);
}

function safeUnlink(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch {
    // already gone
  }
}

function mintTxnId(runId: string, rotationIndex: number): string {
  const rand = crypto.randomBytes(8).toString("hex");
  return `${sanitize(runId)}.${padIdx(rotationIndex)}.${rand}`;
}

interface StreamResult {
  truncated: TruncatedEntry[];
  bytesDropped: number;
  newSizeBytes: number;
}

async function streamRewrite(
  src: string,
  dst: string,
): Promise<StreamResult> {
  const truncated: TruncatedEntry[] = [];
  let bytesDropped = 0;
  const fd = fs.openSync(
    dst,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC,
    0o600,
  );
  let success = false;
  try {
    const rl = readline.createInterface({
      input: fs.createReadStream(src, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (line.length === 0) continue;
      // transformLine throws on malformed JSON; we let it propagate so
      // the caller never advances to pre-rename / rename(2).
      const out = transformLine(line, truncated);
      if (out.bytesDropped > 0) bytesDropped += out.bytesDropped;
      const buf = Buffer.from(out.line + "\n", "utf8");
      fs.writeSync(fd, buf);
    }
    fs.fsyncSync(fd);
    success = true;
  } finally {
    fs.closeSync(fd);
    if (!success) {
      try {
        fs.unlinkSync(dst);
      } catch {
        // already gone
      }
    }
  }
  const st = fs.statSync(dst);
  return { truncated, bytesDropped, newSizeBytes: st.size };
}

function transformLine(
  line: string,
  truncated: TruncatedEntry[],
): { line: string; bytesDropped: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    throw new Error(`malformed JSONL line: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    // Valid JSON, but not an event object — preserve verbatim.
    return { line, bytesDropped: 0 };
  }
  const evt = parsed as Record<string, unknown>;
  const type = evt.type;
  if (type !== "subagent_stdout" && type !== "subagent_stderr") {
    return { line, bytesDropped: 0 };
  }
  const stream: "stdout" | "stderr" =
    type === "subagent_stdout" ? "stdout" : "stderr";
  const seq = typeof evt.seq === "number" ? evt.seq : -1;
  const ts = typeof evt.ts === "string" ? evt.ts : new Date().toISOString();
  const runId = typeof evt.run_id === "string" ? evt.run_id : "";
  const subagentId =
    typeof evt.subagent_id === "string" ? evt.subagent_id : "";
  const dropped = chunkByteLength(evt);
  truncated.push({
    seq,
    subagent_id: subagentId,
    stream,
    bytes_dropped: dropped,
  });
  const replacement = {
    seq,
    ts,
    type: "chunk_truncated",
    run_id: runId,
    subagent_id: subagentId,
    stream,
    bytes_dropped: dropped,
  };
  return { line: JSON.stringify(replacement), bytesDropped: dropped };
}

function chunkByteLength(evt: Record<string, unknown>): number {
  const chunk = evt.chunk;
  const encoding = evt.encoding;
  if (typeof chunk !== "string") return 0;
  if (encoding === "base64") {
    try {
      return Buffer.from(chunk, "base64").length;
    } catch {
      return Buffer.byteLength(chunk, "utf8");
    }
  }
  return Buffer.byteLength(chunk, "utf8");
}

// ---------------------------------------------------------------------
// Request validation guards (zod-mirror invariants)
// ---------------------------------------------------------------------

export function validatePreRenameBody(b: PreRenameBody): void {
  if (b.action !== "pre-rename") {
    throw new Error("pre-rename body must have action=pre-rename");
  }
  if ("new_mtime_ns" in (b as object)) {
    throw new Error("pre-rename body must NOT carry new_mtime_ns");
  }
  if (!Number.isInteger(b.new_size_bytes) || b.new_size_bytes < 0) {
    throw new Error("pre-rename new_size_bytes must be a non-negative integer");
  }
  if (!Array.isArray(b.truncated) || b.truncated.length === 0) {
    throw new Error("pre-rename truncated[] must be non-empty");
  }
  for (const t of b.truncated) {
    if (
      !t ||
      typeof t.subagent_id !== "string" ||
      (t.stream !== "stdout" && t.stream !== "stderr") ||
      !Number.isInteger(t.seq) ||
      !Number.isInteger(t.bytes_dropped) ||
      t.bytes_dropped < 0
    ) {
      throw new Error(`pre-rename truncated entry malformed: ${JSON.stringify(t)}`);
    }
  }
  validateCommon(b.run_id, b.rotation_index, b.file_path, b.rewrite_txn_id);
}

export function validateUpdateMtimeBody(b: UpdateMtimeBody): void {
  if (b.action !== "update-mtime") {
    throw new Error("update-mtime body must have action=update-mtime");
  }
  if ("truncated" in (b as object)) {
    throw new Error("update-mtime body must NOT carry truncated[]");
  }
  if ("new_size_bytes" in (b as object)) {
    throw new Error("update-mtime body must NOT carry new_size_bytes");
  }
  if (!Number.isInteger(b.new_mtime_ns) || b.new_mtime_ns < 0) {
    throw new Error("update-mtime new_mtime_ns must be a non-negative integer");
  }
  validateCommon(b.run_id, b.rotation_index, b.file_path, b.rewrite_txn_id);
}

function validateCommon(
  runId: string,
  rotationIndex: number,
  filePath: string,
  txnId: string,
): void {
  if (typeof runId !== "string" || runId.length === 0) {
    throw new Error("run_id required");
  }
  if (!Number.isInteger(rotationIndex) || rotationIndex < 0) {
    throw new Error("rotation_index must be a non-negative integer");
  }
  if (
    typeof filePath !== "string" ||
    !/^\/spool\/runs\/[A-Za-z0-9._-]+\/events-\d{4,}\.jsonl$/.test(filePath)
  ) {
    throw new Error("file_path must match /spool/runs/<runId>/events-<NNNN>.jsonl");
  }
  if (
    typeof txnId !== "string" ||
    txnId.length === 0 ||
    txnId.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/.test(txnId)
  ) {
    throw new Error("rewrite_txn_id must be a stable opaque token");
  }
}

// ---------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------

interface HttpResult {
  status: number;
  body: Record<string, unknown> | null;
}

async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  body: unknown,
  token: string,
): Promise<HttpResult> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = (await res.json()) as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
}

// ---------------------------------------------------------------------
// Pressure pass
// ---------------------------------------------------------------------

interface PressurePassArgs {
  paths: ResolvedPaths;
  retentionBase: string;
  token: string;
  fetchImpl: typeof fetch;
  totalCapBytes: number;
  nowMs: number;
  dryRun: boolean;
}

export async function pressurePass(
  survivors: RunOnDisk[],
  args: PressurePassArgs,
): Promise<{
  truncated: PruneTruncationRecord[];
  deleted: string[];
  bytesReclaimed: number;
  errors: PruneError[];
  remainingTotal: number;
}> {
  const out = {
    truncated: [] as PruneTruncationRecord[],
    deleted: [] as string[],
    bytesReclaimed: 0,
    errors: [] as PruneError[],
    remainingTotal: 0,
  };
  let total = survivors.reduce((a, r) => a + r.totalBytes, 0);
  out.remainingTotal = total;
  if (total <= args.totalCapBytes) return out;

  const terminal = survivors
    .filter((r) => r.endedAtMs !== null)
    .sort((a, b) => (a.endedAtMs! - b.endedAtMs!));
  if (terminal.length === 0) return out;

  // Oldest 25 % by count get streaming rewrite.
  const sliceCount = Math.max(1, Math.floor(terminal.length / 4));
  const rewriteTargets = terminal.slice(0, sliceCount);
  for (const run of rewriteTargets) {
    for (const file of run.files) {
      const beforeSize = file.sizeBytes;
      if (args.dryRun) {
        out.truncated.push({
          run_id: run.runId,
          rotation_index: file.rotationIndex,
          bytes_dropped: 0,
          seqs: [],
        });
        continue;
      }
      try {
        const outcome = await rewriteFile({
          paths: args.paths,
          run,
          file,
          retentionBase: args.retentionBase,
          token: args.token,
          fetchImpl: args.fetchImpl,
        });
        if (outcome === null) continue;
        out.truncated.push({
          run_id: run.runId,
          rotation_index: file.rotationIndex,
          bytes_dropped: outcome.bytesDropped,
          seqs: outcome.truncated.map((t) => t.seq),
        });
        let afterSize = beforeSize;
        try {
          afterSize = fs.statSync(file.filePath).size;
        } catch {
          // ignore
        }
        const delta = Math.max(0, beforeSize - afterSize);
        out.bytesReclaimed += delta;
        total -= delta;
        // Patch the meta.json bytes_written counter (best-effort).
        try {
          patchMetaBytesWritten(args.paths.metaPath(run.runId), delta);
        } catch (err) {
          out.errors.push({
            stage: "pressure/meta",
            run_id: run.runId,
            rotation_index: file.rotationIndex,
            message: (err as Error).message,
          });
        }
      } catch (err) {
        out.errors.push({
          stage: "pressure/rewrite",
          run_id: run.runId,
          rotation_index: file.rotationIndex,
          file: file.filePath,
          message: (err as Error).message,
        });
      }
    }
  }
  out.remainingTotal = total;
  if (total <= args.totalCapBytes) return out;

  // Still over cap → delete oldest entire terminal runs (move to .trash).
  for (const run of terminal) {
    if (total <= args.totalCapBytes) break;
    if (out.deleted.includes(run.runId)) continue;
    const refreshed = loadRun(args.paths, run.runId);
    if (refreshed.totalBytes === 0 && !fs.existsSync(refreshed.dir)) continue;
    const moved = moveRunToTrash({
      paths: args.paths,
      run: refreshed,
      nowMs: args.nowMs,
      dryRun: args.dryRun,
    });
    if (!moved.ok) {
      if (moved.error) out.errors.push(moved.error);
      continue;
    }
    // `bytes_reclaimed` reflects bytes actually freed from disk this
    // invocation — moves to .trash are bytes-pending until the next
    // cycle's trash sweep runs the `rm -rf`. We DO decrement `total`
    // so the cap-loop terminates, but we leave bytes_reclaimed alone
    // to stay consistent with the age-prune path.
    out.deleted.push(run.runId);
    total -= moved.bytes;
  }
  out.remainingTotal = total;
  return out;
}

function patchMetaBytesWritten(metaFile: string, delta: number): void {
  if (delta <= 0) return;
  let meta: MetaJson;
  try {
    meta = JSON.parse(fs.readFileSync(metaFile, "utf8")) as MetaJson;
  } catch {
    return;
  }
  if (typeof meta.bytes_written !== "number") return;
  meta.bytes_written = Math.max(0, meta.bytes_written - delta);
  atomicWriteJson(metaFile, meta);
}

// ---------------------------------------------------------------------
// prune.log trim + append
// ---------------------------------------------------------------------

export function trimPruneLog(
  logPath: string,
  nowMs: number,
  trimDays = PRUNE_LOG_TRIM_DAYS,
): void {
  if (!fs.existsSync(logPath)) return;
  const cutoff = nowMs - trimDays * DAY_MS;
  const raw = fs.readFileSync(logPath, "utf8");
  const kept: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const o = JSON.parse(trimmed) as { ts?: string };
      const ts = typeof o.ts === "string" ? Date.parse(o.ts) : NaN;
      if (Number.isFinite(ts) && ts >= cutoff) kept.push(trimmed);
    } catch {
      // drop unparseable lines
    }
  }
  const fd = fs.openSync(
    logPath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC,
    0o600,
  );
  try {
    if (kept.length > 0) fs.writeSync(fd, kept.join("\n") + "\n");
  } finally {
    fs.closeSync(fd);
  }
}

export function appendPruneLog(
  logPath: string,
  result: PruneResult,
  nowMs: number,
): void {
  const line =
    JSON.stringify({ ts: new Date(nowMs).toISOString(), ...result }) + "\n";
  fs.appendFileSync(logPath, line, { mode: 0o600 });
}

// ---------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------

export async function runPrune(
  args: CliArgs,
  deps: PruneDeps,
): Promise<PruneResult> {
  const paths = resolvePaths(deps.obsRoot);
  const nowMs = (deps.now ?? Date.now)();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const retentionBase = deps.retentionBase ?? DEFAULT_RETENTION_BASE;

  const result: PruneResult = {
    deleted: [],
    truncated: [],
    bytes_reclaimed: 0,
    errors: [],
  };

  // Step 1 — Keychain token acquisition MUST happen before ensureRoot()
  // and any other filesystem mutation. ensureRoot() chmods + creates
  // observability dirs, so a missing/invalid token should short-circuit
  // before we touch the FS at all.
  let token = "";
  try {
    token = deps.readToken();
  } catch (err) {
    result.errors.push({
      stage: "token",
      message: (err as Error).message,
    });
    return result;
  }
  if (!token) {
    result.errors.push({ stage: "token", message: "empty token" });
    return result;
  }

  // Step 2 — ensureRoot() only after the token is in hand. Tests pin
  // `skipEnsureRoot` / `obsRoot` to keep this scoped to the override.
  if (!deps.skipEnsureRoot && !deps.obsRoot) ensureRoot();

  try {
    // Step 3 — server-authoritative recovery of any rewrite-pending
    // rows left stuck by a prior cycle's post-rename / pre-update
    // crash. Runs BEFORE anything else that touches retention so the
    // SQLite gate is open by the time the pressure pass executes.
    //
    // Skip in dry-run: the recover-pending endpoint can commit or
    // abort pending rewrite rows, delete event_offsets/chunk_offsets,
    // and reset tail_offsets, all of which violate the `--dry-run`
    // non-mutating contract. Operators who want recovery applied run
    // a real (non-dry-run) cycle.
    if (!args.dryRun) {
      const recover = await recoverPendingViaServer({
        retentionBase,
        token,
        fetchImpl,
      });
      if (recover.error) result.errors.push(recover.error);
    }

    // Step 4 — sweep .trash from the previous invocation (≥ 60 s grace).
    const trashSwept = cleanTrash({ paths, nowMs, dryRun: args.dryRun });
    result.deleted.push(...trashSwept.deleted);
    result.bytes_reclaimed += trashSwept.bytesReclaimed;
    result.errors.push(...trashSwept.errors);

    // Step 5 — reconciliation pass.
    const reconcile = await reconcileCrashedRuns({
      paths,
      retentionBase,
      token,
      fetchImpl,
      dryRun: args.dryRun,
    });
    result.errors.push(...reconcile.errors);

    const runs = walkRuns(paths);
    const retentionMs = args.retentionDays * DAY_MS;

    // Step 6 — partition. Active runs (ended_at null) are excluded from
    // BOTH age pruning AND pressure pruning — their bytes don't count
    // toward the total cap and they're never targeted by rewrite/delete.
    const activeRuns: RunOnDisk[] = [];
    const terminalSurvivors: RunOnDisk[] = [];
    const agePrunable: RunOnDisk[] = [];
    for (const r of runs) {
      if (r.endedAtMs === null) {
        activeRuns.push(r);
        continue;
      }
      if (nowMs - r.endedAtMs >= retentionMs) {
        agePrunable.push(r);
      } else {
        terminalSurvivors.push(r);
      }
    }
    for (const r of agePrunable) {
      const moved = moveRunToTrash({
        paths,
        run: r,
        nowMs,
        dryRun: args.dryRun,
      });
      if (!moved.ok) {
        if (moved.error) result.errors.push(moved.error);
        // Failed to move — still a terminal run, keep it in the pressure
        // candidate set (never the active set).
        terminalSurvivors.push(r);
        continue;
      }
      // moved-to-trash counts toward deletion when the NEXT cycle rms it,
      // but per Phase 7 the operator-visible signal is the run id moving
      // out of `runs/`. Surface it as deleted now and rely on the next
      // cycle's trash sweep to free the bytes.
      result.deleted.push(r.runId);
    }

    // Step 7 — pressure pass on terminal survivors only. Active runs are
    // intentionally excluded from both the input set and the total-byte
    // tally so they never trigger truncation/deletion of terminal runs.
    void activeRuns;
    const totalCapBytes = args.totalCapGb * 1024 * 1024 * 1024;
    const pressure = await pressurePass(terminalSurvivors, {
      paths,
      retentionBase,
      token,
      fetchImpl,
      totalCapBytes,
      nowMs,
      dryRun: args.dryRun,
    });
    result.truncated.push(...pressure.truncated);
    for (const id of pressure.deleted) {
      if (!result.deleted.includes(id)) result.deleted.push(id);
    }
    result.bytes_reclaimed += pressure.bytesReclaimed;
    result.errors.push(...pressure.errors);
  } finally {
    // Best-effort zeroize: drop the local reference. JS string immutability
    // means the underlying bytes may persist until GC, but no other scope
    // can reach them through this CLI.
    token = "";
  }

  return result;
}

// ---------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`[observability_prune] ${(err as Error).message}\n`);
    process.exit(2);
  }

  const nowMs = Date.now();
  const paths = resolvePaths();

  let result: PruneResult;
  try {
    result = await runPrune(args, {
      readToken: readPruneTokenFromKeychain,
    });
  } catch (err) {
    process.stderr.write(`[observability_prune] ${(err as Error).message}\n`);
    process.exit(1);
  }

  try {
    trimPruneLog(paths.pruneLog, nowMs);
  } catch (err) {
    result.errors.push({
      stage: "log/trim",
      message: (err as Error).message,
    });
  }
  try {
    if (!args.dryRun) appendPruneLog(paths.pruneLog, result, nowMs);
  } catch (err) {
    result.errors.push({
      stage: "log/append",
      message: (err as Error).message,
    });
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(result) + "\n");
  } else {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  }
  process.exit(0);
}

const isEntry =
  import.meta.url ===
  (process.argv[1]
    ? new URL(`file://${path.resolve(process.argv[1])}`).href
    : "");
if (isEntry) {
  main().catch((err) => {
    process.stderr.write(`[observability_prune] fatal: ${(err as Error).message}\n`);
    process.exit(1);
  });
}

export const __test = {
  resolvePaths,
  loadRun,
  readMeta,
  parseDateMs,
  transformLine,
  chunkByteLength,
  mintTxnId,
  backoffMs,
  dirSize,
  KEYCHAIN_SERVICE,
  CONTAINER_SPOOL_PREFIX,
  TRASH_GRACE_MS,
  PRUNE_LOG_TRIM_DAYS,
};
