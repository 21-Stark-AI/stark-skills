// Phase 7 prune CLI tests. Vitest equivalent via node:test runner so it
// joins the existing `npm test` flow in tools/.

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendPruneLog,
  atomicWriteJson,
  cleanTrash,
  moveRunToTrash,
  parseArgs,
  pressurePass,
  reconcileCrashedRuns,
  recoverPendingViaServer,
  rewriteFile,
  runPrune,
  trimPruneLog,
  validatePreRenameBody,
  validateUpdateMtimeBody,
  walkRuns,
  __test,
  type CliArgs,
  type PreRenameBody,
  type RunOnDisk,
  type UpdateMtimeBody,
} from "./observability_prune.ts";

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "obs-prune-test-"));
}

function makeRun(args: {
  root: string;
  runId: string;
  endedAt: string | null;
  files: Array<{ idx: number; lines: object[] }>;
  meta?: Record<string, unknown>;
}): void {
  const dir = path.join(args.root, "runs", args.runId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const meta = {
    run_id: args.runId,
    started_at: args.endedAt ?? new Date().toISOString(),
    ended_at: args.endedAt,
    status: args.endedAt ? "ok" : "running",
    bytes_written: 0,
    ...(args.meta ?? {}),
  };
  let total = 0;
  for (const f of args.files) {
    const name = `events-${String(f.idx).padStart(4, "0")}.jsonl`;
    const body = f.lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
    fs.writeFileSync(path.join(dir, name), body, { mode: 0o600 });
    total += Buffer.byteLength(body, "utf8");
  }
  (meta as { bytes_written: number }).bytes_written = total;
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n", {
    mode: 0o600,
  });
}

function paths(root: string) {
  return __test.resolvePaths(root);
}

// --------------------------------------------------------------------
// parseArgs
// --------------------------------------------------------------------

test("parseArgs: defaults", () => {
  const a = parseArgs([]);
  assert.equal(a.retentionDays, 30);
  assert.equal(a.totalCapGb, 50);
  assert.equal(a.dryRun, false);
  assert.equal(a.json, false);
});

test("parseArgs: flags", () => {
  const a = parseArgs(["--retention-days", "7", "--total-cap-gb", "10", "--dry-run", "--json"]);
  assert.equal(a.retentionDays, 7);
  assert.equal(a.totalCapGb, 10);
  assert.equal(a.dryRun, true);
  assert.equal(a.json, true);
});

test("parseArgs: rejects unknown", () => {
  assert.throws(() => parseArgs(["--unknown"]), /unknown arg/);
});

test("parseArgs: rejects negative", () => {
  assert.throws(() => parseArgs(["--retention-days", "-1"]));
});

// --------------------------------------------------------------------
// validators
// --------------------------------------------------------------------

test("validatePreRenameBody: rejects new_mtime_ns smuggling", () => {
  const bad = {
    action: "pre-rename",
    run_id: "r1",
    rotation_index: 0,
    file_path: "/spool/runs/r1/events-0000.jsonl",
    new_size_bytes: 100,
    truncated: [{ seq: 1, subagent_id: "s", stream: "stdout", bytes_dropped: 1 }],
    rewrite_txn_id: "t1",
    new_mtime_ns: 123,
  } as unknown as PreRenameBody;
  assert.throws(() => validatePreRenameBody(bad), /new_mtime_ns/);
});

test("validatePreRenameBody: requires non-empty truncated", () => {
  const bad: PreRenameBody = {
    action: "pre-rename",
    run_id: "r1",
    rotation_index: 0,
    file_path: "/spool/runs/r1/events-0000.jsonl",
    new_size_bytes: 100,
    truncated: [],
    rewrite_txn_id: "t1",
  };
  assert.throws(() => validatePreRenameBody(bad), /truncated/);
});

test("validatePreRenameBody: accepts well-formed body", () => {
  const ok: PreRenameBody = {
    action: "pre-rename",
    run_id: "r1",
    rotation_index: 3,
    file_path: "/spool/runs/r1/events-0003.jsonl",
    new_size_bytes: 100,
    truncated: [{ seq: 7, subagent_id: "sa", stream: "stderr", bytes_dropped: 42 }],
    rewrite_txn_id: "r1.0003.deadbeef",
  };
  validatePreRenameBody(ok);
});

test("validateUpdateMtimeBody: rejects truncated smuggling", () => {
  const bad = {
    action: "update-mtime",
    run_id: "r1",
    rotation_index: 0,
    file_path: "/spool/runs/r1/events-0000.jsonl",
    new_mtime_ns: 1,
    rewrite_txn_id: "t1",
    truncated: [],
  } as unknown as UpdateMtimeBody;
  assert.throws(() => validateUpdateMtimeBody(bad), /truncated/);
});

test("validateUpdateMtimeBody: rejects new_size_bytes smuggling", () => {
  const bad = {
    action: "update-mtime",
    run_id: "r1",
    rotation_index: 0,
    file_path: "/spool/runs/r1/events-0000.jsonl",
    new_mtime_ns: 1,
    rewrite_txn_id: "t1",
    new_size_bytes: 99,
  } as unknown as UpdateMtimeBody;
  assert.throws(() => validateUpdateMtimeBody(bad), /new_size_bytes/);
});

test("validateUpdateMtimeBody: rejects bad file_path", () => {
  const bad: UpdateMtimeBody = {
    action: "update-mtime",
    run_id: "r1",
    rotation_index: 0,
    file_path: "/etc/passwd",
    new_mtime_ns: 1,
    rewrite_txn_id: "t1",
  };
  assert.throws(() => validateUpdateMtimeBody(bad), /file_path/);
});

// --------------------------------------------------------------------
// walkRuns + loadRun
// --------------------------------------------------------------------

test("walkRuns: returns terminal + active runs", () => {
  const root = tmpdir();
  makeRun({
    root,
    runId: "run-a",
    endedAt: "2026-01-01T00:00:00Z",
    files: [{ idx: 0, lines: [{ type: "run_start", run_id: "run-a" }] }],
  });
  makeRun({
    root,
    runId: "run-b",
    endedAt: null,
    files: [{ idx: 0, lines: [{ type: "run_start", run_id: "run-b" }] }],
  });
  const runs = walkRuns(paths(root));
  assert.equal(runs.length, 2);
  const a = runs.find((r) => r.runId === "run-a")!;
  assert.equal(a.endedAtMs !== null, true);
  const b = runs.find((r) => r.runId === "run-b")!;
  assert.equal(b.endedAtMs, null);
});

test("walkRuns: skips dot-prefixed dirs", () => {
  const root = tmpdir();
  fs.mkdirSync(path.join(root, "runs"), { recursive: true });
  fs.mkdirSync(path.join(root, "runs", ".hidden"), { recursive: true });
  fs.mkdirSync(path.join(root, "runs", "good"), { recursive: true });
  fs.writeFileSync(path.join(root, "runs", "good", "meta.json"), "{}");
  const runs = walkRuns(paths(root));
  assert.deepEqual(runs.map((r) => r.runId).sort(), ["good"]);
});

// --------------------------------------------------------------------
// .trash sweep
// --------------------------------------------------------------------

test("cleanTrash: only deletes dirs past grace window", () => {
  const root = tmpdir();
  const trash = path.join(root, ".trash");
  fs.mkdirSync(trash, { recursive: true, mode: 0o700 });
  const old = path.join(trash, "old");
  const fresh = path.join(trash, "fresh");
  fs.mkdirSync(old, { mode: 0o700 });
  fs.mkdirSync(fresh, { mode: 0o700 });
  const oldStamp = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const freshStamp = new Date().toISOString();
  fs.writeFileSync(path.join(old, ".moved_at"), oldStamp);
  fs.writeFileSync(path.join(fresh, ".moved_at"), freshStamp);
  fs.writeFileSync(path.join(old, "events-0000.jsonl"), "hello\n");
  const out = cleanTrash({ paths: paths(root), nowMs: Date.now(), dryRun: false });
  assert.deepEqual(out.deleted, ["old"]);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(fresh), true);
  assert.ok(out.bytesReclaimed > 0);
});

test("cleanTrash: dry run leaves dirs intact", () => {
  const root = tmpdir();
  const trash = path.join(root, ".trash");
  fs.mkdirSync(trash, { recursive: true, mode: 0o700 });
  const old = path.join(trash, "old");
  fs.mkdirSync(old, { mode: 0o700 });
  fs.writeFileSync(
    path.join(old, ".moved_at"),
    new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  );
  const out = cleanTrash({ paths: paths(root), nowMs: Date.now(), dryRun: true });
  assert.deepEqual(out.deleted, ["old"]);
  assert.equal(fs.existsSync(old), true);
});

// --------------------------------------------------------------------
// moveRunToTrash
// --------------------------------------------------------------------

test("moveRunToTrash: renames run dir + writes .moved_at", () => {
  const root = tmpdir();
  makeRun({
    root,
    runId: "old-run",
    endedAt: "2025-01-01T00:00:00Z",
    files: [{ idx: 0, lines: [{ type: "x" }] }],
  });
  const runs = walkRuns(paths(root));
  const moved = moveRunToTrash({
    paths: paths(root),
    run: runs[0]!,
    nowMs: Date.now(),
    dryRun: false,
  });
  assert.equal(moved.ok, true);
  assert.equal(fs.existsSync(path.join(root, "runs", "old-run")), false);
  assert.equal(fs.existsSync(path.join(root, ".trash", "old-run", ".moved_at")), true);
});

// --------------------------------------------------------------------
// reconcileCrashedRuns
// --------------------------------------------------------------------

test("reconcileCrashedRuns: patches meta.json on sweeper-crashed run", async () => {
  const root = tmpdir();
  makeRun({
    root,
    runId: "crashed",
    endedAt: null,
    files: [{ idx: 0, lines: [{ type: "run_start", run_id: "crashed" }] }],
  });
  const fetchImpl = async (_url: string, _init?: unknown): Promise<Response> => {
    const body = {
      items: [
        {
          run_id: "crashed",
          ended_at: "2026-05-01T12:00:00.000Z",
          crashed_reason: "parent_exit",
          status: "crashed",
        },
      ],
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const out = await reconcileCrashedRuns({
    paths: paths(root),
    retentionBase: "http://x",
    token: "t",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    dryRun: false,
  });
  assert.deepEqual(out.reconciled, ["crashed"]);
  const meta = JSON.parse(
    fs.readFileSync(path.join(root, "runs", "crashed", "meta.json"), "utf8"),
  );
  assert.equal(meta.ended_at, "2026-05-01T12:00:00.000Z");
  assert.equal(meta.status, "crashed");
  assert.equal(meta.crashed_reason, "parent_exit");
});

test("reconcileCrashedRuns: skips runs whose host meta already has ended_at", async () => {
  const root = tmpdir();
  makeRun({
    root,
    runId: "already",
    endedAt: "2026-04-01T00:00:00.000Z",
    files: [{ idx: 0, lines: [{ type: "x" }] }],
  });
  const fetchImpl = async (): Promise<Response> =>
    new Response(
      JSON.stringify({
        items: [
          {
            run_id: "already",
            ended_at: "2026-05-01T12:00:00.000Z",
            crashed_reason: "parent_exit",
            status: "crashed",
          },
        ],
      }),
      { status: 200 },
    );
  const out = await reconcileCrashedRuns({
    paths: paths(root),
    retentionBase: "http://x",
    token: "t",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    dryRun: false,
  });
  assert.deepEqual(out.reconciled, []);
  const meta = JSON.parse(
    fs.readFileSync(path.join(root, "runs", "already", "meta.json"), "utf8"),
  );
  assert.equal(meta.ended_at, "2026-04-01T00:00:00.000Z");
});

// --------------------------------------------------------------------
// rewriteFile (Call A + rename + Call B ordering)
// --------------------------------------------------------------------

test("rewriteFile: strict Call A → rename → Call B ordering, schema invariants", async () => {
  const root = tmpdir();
  makeRun({
    root,
    runId: "rw1",
    endedAt: "2026-01-01T00:00:00Z",
    files: [
      {
        idx: 0,
        lines: [
          { type: "run_start", run_id: "rw1", seq: 0 },
          {
            type: "subagent_stdout",
            seq: 1,
            ts: "2026-01-01T00:00:00.001Z",
            run_id: "rw1",
            subagent_id: "rw1:0",
            stream: "stdout",
            encoding: "utf8",
            chunk: "hello world",
          },
          { type: "subagent_progress", seq: 2, kind: "finding", payload: {} },
        ],
      },
    ],
  });
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  let updateSeenAfterRename = false;
  const filePath = path.join(root, "runs", "rw1", "events-0000.jsonl");

  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const tmpExists = fs.existsSync(filePath + ".tmp");
    if (body.action === "pre-rename") {
      assert.equal(tmpExists, true, "pre-rename must fire BEFORE rename(2)");
    }
    if (body.action === "update-mtime") {
      assert.equal(tmpExists, false, "update-mtime must fire AFTER rename(2)");
      updateSeenAfterRename = true;
    }
    calls.push({ url, body });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const runs = walkRuns(paths(root));
  const file = runs[0]!.files[0]!;
  const outcome = await rewriteFile({
    paths: paths(root),
    run: runs[0]!,
    file,
    retentionBase: "http://x",
    token: "t",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  assert.ok(outcome !== null);
  assert.equal(outcome!.truncated.length, 1);
  void updateSeenAfterRename; // pinned for the assert.equal below

  // Calls in correct order.
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.body.action, "pre-rename");
  assert.equal(calls[1]!.body.action, "update-mtime");

  // Pre-rename body: has new_size_bytes + truncated, NO new_mtime_ns.
  assert.equal(typeof calls[0]!.body.new_size_bytes, "number");
  assert.ok(Array.isArray(calls[0]!.body.truncated));
  assert.equal((calls[0]!.body.truncated as unknown[]).length, 1);
  assert.equal("new_mtime_ns" in calls[0]!.body, false);

  // Update-mtime body: has new_mtime_ns, NO truncated, NO new_size_bytes.
  assert.equal(typeof calls[1]!.body.new_mtime_ns, "number");
  assert.equal("truncated" in calls[1]!.body, false);
  assert.equal("new_size_bytes" in calls[1]!.body, false);

  // Two calls carry the SAME txn id.
  assert.equal(calls[0]!.body.rewrite_txn_id, calls[1]!.body.rewrite_txn_id);

  // File on disk now has chunk_truncated record in place of stdout.
  const replayed = fs
    .readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.equal(replayed[1]!.type, "chunk_truncated");
  assert.equal(replayed[1]!.seq, 1);
  assert.equal(typeof replayed[1]!.bytes_dropped, "number");

  // Other event types preserved.
  assert.equal(replayed[0]!.type, "run_start");
  assert.equal(replayed[2]!.type, "subagent_progress");

  // Belt-and-suspenders: the ordering checks fired.
  assert.equal(updateSeenAfterRename, true);
});

test("rewriteFile: rename(2) failure triggers abort-rewrite", async () => {
  const root = tmpdir();
  makeRun({
    root,
    runId: "rwfail",
    endedAt: "2026-01-01T00:00:00Z",
    files: [
      {
        idx: 0,
        lines: [
          {
            type: "subagent_stdout",
            seq: 1,
            ts: "2026-01-01T00:00:00.001Z",
            run_id: "rwfail",
            subagent_id: "rwfail:0",
            stream: "stdout",
            encoding: "utf8",
            chunk: "x",
          },
        ],
      },
    ],
  });
  const calls: Array<Record<string, unknown>> = [];
  const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push(body);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  // Force renameSync to throw.
  const origRename = fs.renameSync.bind(fs);
  const filePath = path.join(root, "runs", "rwfail", "events-0000.jsonl");
  (fs as { renameSync: typeof fs.renameSync }).renameSync = ((from, to) => {
    if (String(to) === filePath) {
      throw new Error("simulated rename failure");
    }
    return origRename(from, to);
  }) as typeof fs.renameSync;

  let caught: Error | null = null;
  try {
    const runs = walkRuns(paths(root));
    await rewriteFile({
      paths: paths(root),
      run: runs[0]!,
      file: runs[0]!.files[0]!,
      retentionBase: "http://x",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
  } catch (err) {
    caught = err as Error;
  } finally {
    (fs as { renameSync: typeof fs.renameSync }).renameSync = origRename;
  }
  assert.ok(caught, "rename failure should propagate");
  assert.match((caught as Error).message, /simulated rename/);
  // Expect pre-rename then abort-rewrite, NO update-mtime.
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.action, "pre-rename");
  assert.equal(calls[1]!.action, "abort-rewrite");
  assert.equal(calls[0]!.rewrite_txn_id, calls[1]!.rewrite_txn_id);
});

test("rewriteFile: 409 scan_pending triggers scan-now retry", async () => {
  const root = tmpdir();
  makeRun({
    root,
    runId: "scanp",
    endedAt: "2026-01-01T00:00:00Z",
    files: [
      {
        idx: 0,
        lines: [
          {
            type: "subagent_stdout",
            seq: 1,
            ts: "2026-01-01T00:00:00.001Z",
            run_id: "scanp",
            subagent_id: "scanp:0",
            stream: "stdout",
            encoding: "utf8",
            chunk: "y",
          },
        ],
      },
    ],
  });
  let preRenameAttempts = 0;
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url, body });
    if (body.action === "pre-rename") {
      preRenameAttempts += 1;
      if (preRenameAttempts === 1) {
        return new Response(JSON.stringify({ ok: false, code: "scan_pending" }), { status: 409 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const runs = walkRuns(paths(root));
  const outcome = await rewriteFile({
    paths: paths(root),
    run: runs[0]!,
    file: runs[0]!.files[0]!,
    retentionBase: "http://x",
    token: "t",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  assert.ok(outcome);
  // Sequence: pre-rename (409) → scan-now → pre-rename (200) → update-mtime.
  const actions = calls.map((c) => c.body.action);
  assert.deepEqual(actions, ["pre-rename", undefined, "pre-rename", "update-mtime"]);
  // The scan-now call hits a different URL and carries no `action`.
  assert.ok(calls[1]!.url.endsWith("/api/internal/retention/scan-now"));
});

// --------------------------------------------------------------------
// trimPruneLog
// --------------------------------------------------------------------

test("trimPruneLog: drops entries older than cutoff", () => {
  const root = tmpdir();
  const log = path.join(root, "prune.log");
  const old = new Date(Date.now() - 120 * 24 * 3600 * 1000).toISOString();
  const recent = new Date().toISOString();
  fs.writeFileSync(
    log,
    JSON.stringify({ ts: old, deleted: ["old"] }) +
      "\n" +
      JSON.stringify({ ts: recent, deleted: ["recent"] }) +
      "\n",
  );
  trimPruneLog(log, Date.now(), 90);
  const kept = fs.readFileSync(log, "utf8").trim().split("\n");
  assert.equal(kept.length, 1);
  assert.match(kept[0]!, /"recent"/);
});

test("appendPruneLog: appends a JSON line", () => {
  const root = tmpdir();
  const log = path.join(root, "prune.log");
  appendPruneLog(log, { deleted: ["x"], truncated: [], bytes_reclaimed: 1, errors: [] }, Date.now());
  const text = fs.readFileSync(log, "utf8");
  assert.match(text, /"deleted":\["x"\]/);
  assert.match(text, /"ts":"/);
});

// --------------------------------------------------------------------
// pressurePass
// --------------------------------------------------------------------

test("pressurePass: under cap → no rewrites", async () => {
  const root = tmpdir();
  makeRun({
    root,
    runId: "small",
    endedAt: "2026-01-01T00:00:00Z",
    files: [{ idx: 0, lines: [{ type: "run_end" }] }],
  });
  const survivors = walkRuns(paths(root));
  const out = await pressurePass(survivors, {
    paths: paths(root),
    retentionBase: "http://x",
    token: "t",
    fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    totalCapBytes: 1024 * 1024 * 1024,
    nowMs: Date.now(),
    dryRun: false,
  });
  assert.equal(out.truncated.length, 0);
  assert.equal(out.deleted.length, 0);
});

test("pressurePass: over cap → rewrites oldest 25% of terminal runs", async () => {
  const root = tmpdir();
  // 8 terminal runs with varying ended_at; oldest 2 get rewrites.
  for (let i = 0; i < 8; i++) {
    makeRun({
      root,
      runId: `r${i}`,
      endedAt: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
      files: [
        {
          idx: 0,
          lines: [
            {
              type: "subagent_stdout",
              seq: 1,
              ts: "2026-01-01T00:00:00Z",
              run_id: `r${i}`,
              subagent_id: `r${i}:0`,
              stream: "stdout",
              encoding: "utf8",
              chunk: "x".repeat(100),
            },
          ],
        },
      ],
    });
  }
  const survivors = walkRuns(paths(root));
  const calls: Array<Record<string, unknown>> = [];
  const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push(body);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const out = await pressurePass(survivors, {
    paths: paths(root),
    retentionBase: "http://x",
    token: "t",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    totalCapBytes: 1, // force pressure
    nowMs: Date.now(),
    dryRun: false,
  });
  // 2 runs × 1 file × 2 calls = 4 calls minimum, but additional delete-oldest
  // may move runs to trash. Verify the oldest two runs got rewritten.
  const rewrittenRuns = new Set(out.truncated.map((t) => t.run_id));
  assert.ok(rewrittenRuns.has("r0"), "oldest r0 must be rewritten");
  assert.ok(rewrittenRuns.has("r1"), "second-oldest r1 must be rewritten");
  assert.equal(out.truncated.length, 2);
  // Verify pre-rename and update-mtime pair fired per file.
  const preCount = calls.filter((c) => c.action === "pre-rename").length;
  const updCount = calls.filter((c) => c.action === "update-mtime").length;
  assert.equal(preCount, 2);
  assert.equal(updCount, 2);
});

// --------------------------------------------------------------------
// runPrune integration
// --------------------------------------------------------------------

test("runPrune: age-pruning moves terminal runs older than retention", async () => {
  const root = tmpdir();
  makeRun({
    root,
    runId: "old",
    endedAt: new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString(),
    files: [{ idx: 0, lines: [{ type: "run_end" }] }],
  });
  makeRun({
    root,
    runId: "fresh",
    endedAt: new Date().toISOString(),
    files: [{ idx: 0, lines: [{ type: "run_end" }] }],
  });
  makeRun({
    root,
    runId: "running",
    endedAt: null,
    files: [{ idx: 0, lines: [{ type: "run_start" }] }],
  });
  const args: CliArgs = { retentionDays: 30, totalCapGb: 50, dryRun: false, json: true };
  const result = await runPrune(args, {
    readToken: () => "t",
    obsRoot: root,
    skipEnsureRoot: true,
    fetchImpl: (async () => new Response(JSON.stringify({ items: [] }), { status: 200 })) as unknown as typeof fetch,
  });
  assert.deepEqual(result.deleted.sort(), ["old"]);
  assert.equal(fs.existsSync(path.join(root, ".trash", "old", ".moved_at")), true);
  assert.equal(fs.existsSync(path.join(root, "runs", "fresh")), true);
  assert.equal(fs.existsSync(path.join(root, "runs", "running")), true);
});

test("runPrune: --dry-run does NOT call the recover-pending endpoint", async () => {
  // Regression for Phase 7 round 5 wing finding: recoverPendingViaServer
  // can commit/abort pending rewrite rows and reset tail_offsets, all of
  // which violate the dry-run non-mutating contract. The dry-run path
  // must skip that POST entirely.
  const root = tmpdir();
  fs.mkdirSync(path.join(root, "runs"), { recursive: true });
  const calls: string[] = [];
  const args: CliArgs = { retentionDays: 30, totalCapGb: 50, dryRun: true, json: true };
  await runPrune(args, {
    readToken: () => "t",
    obsRoot: root,
    skipEnsureRoot: true,
    fetchImpl: (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push(url);
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }) as unknown as typeof fetch,
  });
  const hits = calls.filter((u) => u.includes("recover-pending"));
  assert.deepEqual(hits, []);
});

test("runPrune: non-dry-run DOES call the recover-pending endpoint", async () => {
  // Companion to the dry-run regression test above.
  const root = tmpdir();
  fs.mkdirSync(path.join(root, "runs"), { recursive: true });
  const calls: string[] = [];
  const args: CliArgs = { retentionDays: 30, totalCapGb: 50, dryRun: false, json: true };
  await runPrune(args, {
    readToken: () => "t",
    obsRoot: root,
    skipEnsureRoot: true,
    fetchImpl: (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push(url);
      return new Response(JSON.stringify({ items: [], stats: { scanned: 0 } }), { status: 200 });
    }) as unknown as typeof fetch,
  });
  const hits = calls.filter((u) => u.includes("recover-pending"));
  assert.equal(hits.length >= 1, true);
});

test("runPrune: surfaces token resolution failure as error entry", async () => {
  const root = tmpdir();
  fs.mkdirSync(path.join(root, "runs"), { recursive: true });
  const args: CliArgs = { retentionDays: 30, totalCapGb: 50, dryRun: false, json: true };
  const result = await runPrune(args, {
    readToken: () => {
      throw new Error("missing Keychain entry");
    },
    obsRoot: root,
    skipEnsureRoot: true,
    fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
  });
  assert.ok(result.errors.some((e) => e.stage === "token"));
  assert.equal(result.deleted.length, 0);
});

// --------------------------------------------------------------------
// transformLine helpers
// --------------------------------------------------------------------

test("transformLine: passes non-chunk events through verbatim", () => {
  const truncated: Array<Record<string, unknown>> = [];
  const out = __test.transformLine(
    JSON.stringify({ type: "run_heartbeat", seq: 1 }),
    truncated as unknown as Array<{ seq: number; subagent_id: string; stream: "stdout" | "stderr"; bytes_dropped: number }>,
  );
  assert.equal(out.bytesDropped, 0);
  const parsed = JSON.parse(out.line);
  assert.equal(parsed.type, "run_heartbeat");
  assert.equal(truncated.length, 0);
});

test("transformLine: replaces subagent_stdout with chunk_truncated, base64 byte-count is exact", () => {
  const chunk = Buffer.from("hello\x00world").toString("base64");
  const truncated: Array<{ seq: number; subagent_id: string; stream: "stdout" | "stderr"; bytes_dropped: number }> = [];
  const out = __test.transformLine(
    JSON.stringify({
      type: "subagent_stdout",
      seq: 7,
      ts: "2026-01-01T00:00:00.000Z",
      run_id: "r",
      subagent_id: "r:0",
      stream: "stdout",
      encoding: "base64",
      chunk,
    }),
    truncated,
  );
  const parsed = JSON.parse(out.line);
  assert.equal(parsed.type, "chunk_truncated");
  assert.equal(parsed.seq, 7);
  assert.equal(parsed.bytes_dropped, 11);
  assert.equal(truncated[0]!.bytes_dropped, 11);
});

// --------------------------------------------------------------------
// atomicWriteJson
// --------------------------------------------------------------------

test("atomicWriteJson: writes 0600 and round-trips", () => {
  const root = tmpdir();
  const p = path.join(root, "meta.json");
  atomicWriteJson(p, { hello: "world", n: 42 });
  const back = JSON.parse(fs.readFileSync(p, "utf8"));
  assert.deepEqual(back, { hello: "world", n: 42 });
  assert.equal(fs.statSync(p).mode & 0o777, 0o600);
});

// --------------------------------------------------------------------
// Malformed-JSONL guard (wing fix: streamRewrite must fail before
// pre-rename / rename(2), tmp file removed, original untouched)
// --------------------------------------------------------------------

test("rewriteFile: malformed JSONL → throws, tmp removed, no HTTP calls", async () => {
  const root = tmpdir();
  // Build a file by hand to interleave one malformed line with a valid
  // subagent_stdout that would otherwise trigger truncation.
  const runDir = path.join(root, "runs", "badjson");
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const filePath = path.join(runDir, "events-0000.jsonl");
  const malformed = "{not json";
  const stdout = JSON.stringify({
    type: "subagent_stdout",
    seq: 1,
    ts: "2026-01-01T00:00:00.000Z",
    run_id: "badjson",
    subagent_id: "badjson:0",
    stream: "stdout",
    encoding: "utf8",
    chunk: "x",
  });
  const originalBody = `${stdout}\n${malformed}\n`;
  fs.writeFileSync(filePath, originalBody, { mode: 0o600 });
  fs.writeFileSync(
    path.join(runDir, "meta.json"),
    JSON.stringify({
      run_id: "badjson",
      started_at: "2026-01-01T00:00:00Z",
      ended_at: "2026-01-01T00:00:01Z",
      status: "ok",
      bytes_written: Buffer.byteLength(originalBody, "utf8"),
    }),
    { mode: 0o600 },
  );

  const calls: unknown[] = [];
  const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
    calls.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response("{}", { status: 200 });
  };
  const runs = walkRuns(paths(root));
  let caught: Error | null = null;
  try {
    await rewriteFile({
      paths: paths(root),
      run: runs[0]!,
      file: runs[0]!.files[0]!,
      retentionBase: "http://x",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
  } catch (err) {
    caught = err as Error;
  }
  assert.ok(caught, "must throw on malformed JSONL");
  assert.match(caught!.message, /malformed JSONL/);
  assert.equal(calls.length, 0, "no HTTP call should be issued before rename");
  assert.equal(fs.existsSync(filePath + ".tmp"), false, "tmp must be removed");
  assert.equal(
    fs.readFileSync(filePath, "utf8"),
    originalBody,
    "original file must be untouched",
  );
});

// --------------------------------------------------------------------
// Pressure-pass active-run exclusion (wing fix: active runs must not
// be counted toward the total cap)
// --------------------------------------------------------------------

test("runPrune: active runs are excluded from pressure total — no truncation under terminal-only cap", async () => {
  const root = tmpdir();
  // One small terminal run + a chunky active run. If the pressure pass
  // counted active bytes, the cap would trip and the terminal would be
  // rewritten/deleted. After the fix, the terminal stays untouched.
  makeRun({
    root,
    runId: "term-small",
    endedAt: "2026-01-01T00:00:00.000Z",
    files: [{ idx: 0, lines: [{ type: "run_end", seq: 0 }] }],
  });
  // Active run with a chunky stdout chunk — would tip total over the
  // cap if it were counted.
  makeRun({
    root,
    runId: "active-big",
    endedAt: null,
    files: [
      {
        idx: 0,
        lines: [
          {
            type: "subagent_stdout",
            seq: 1,
            ts: "2026-01-01T00:00:00.000Z",
            run_id: "active-big",
            subagent_id: "active-big:0",
            stream: "stdout",
            encoding: "utf8",
            chunk: "Z".repeat(8_000),
          },
        ],
      },
    ],
  });
  const calls: Array<Record<string, unknown>> = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.endsWith("/crashed-runs")) {
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push(body);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  // Cap of 1 byte → terminal-only total (run_end line = a few dozen
  // bytes) still exceeds, but the wing fix is about not letting the
  // active run's 8 KB tip the calculation. We pick the cap so that:
  //   terminal-only-total < cap  AND  terminal + active > cap.
  const activeBytes = fs.statSync(
    path.join(root, "runs", "active-big", "events-0000.jsonl"),
  ).size;
  const terminalBytes = fs.statSync(
    path.join(root, "runs", "term-small", "events-0000.jsonl"),
  ).size;
  // Cap halfway between terminal-only and combined.
  const capBytes = terminalBytes + Math.floor(activeBytes / 2);
  const capGb = capBytes / (1024 * 1024 * 1024);
  const args: CliArgs = {
    retentionDays: 365,
    totalCapGb: capGb,
    dryRun: false,
    json: true,
  };
  const result = await runPrune(args, {
    readToken: () => "t",
    obsRoot: root,
    skipEnsureRoot: true,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  assert.equal(result.truncated.length, 0, "terminal-only total under cap → no rewrites");
  assert.equal(
    result.deleted.length,
    0,
    "no deletes; active run must not be a deletion candidate",
  );
  // No update-mtime / pre-rename calls.
  assert.equal(
    calls.filter((c) => c.action === "pre-rename" || c.action === "update-mtime").length,
    0,
  );
  // Both runs still on disk.
  assert.equal(fs.existsSync(path.join(root, "runs", "term-small")), true);
  assert.equal(fs.existsSync(path.join(root, "runs", "active-big")), true);
});

// --------------------------------------------------------------------
// Token-first ordering (wing fix: cleanTrash must NOT run before token
// acquisition)
// --------------------------------------------------------------------

test("runPrune: token failure short-circuits before .trash sweep", async () => {
  const root = tmpdir();
  const trash = path.join(root, ".trash");
  fs.mkdirSync(trash, { recursive: true, mode: 0o700 });
  const stale = path.join(trash, "stale");
  fs.mkdirSync(stale, { mode: 0o700 });
  fs.writeFileSync(
    path.join(stale, ".moved_at"),
    new Date(Date.now() - 10 * 60 * 1000).toISOString(),
  );
  fs.writeFileSync(path.join(stale, "events-0000.jsonl"), "old\n");

  const args: CliArgs = { retentionDays: 30, totalCapGb: 50, dryRun: false, json: true };
  const result = await runPrune(args, {
    readToken: () => {
      throw new Error("missing Keychain entry");
    },
    obsRoot: root,
    skipEnsureRoot: true,
    fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
  });
  assert.ok(result.errors.some((e) => e.stage === "token"));
  // .trash subdir must still exist — sweep did not run.
  assert.equal(fs.existsSync(stale), true);
  assert.equal(result.deleted.length, 0);
  assert.equal(result.bytes_reclaimed, 0);
});

// --------------------------------------------------------------------
// Wing-finding regression: server-authoritative recovery of stuck
// rewrite-pending rows
// --------------------------------------------------------------------

test("recoverPendingViaServer: 200 with stats yields no error", async () => {
  let url = "";
  let methodSeen = "";
  let bodySeen = "";
  let authSeen = "";
  const fetchImpl = async (u: string, init?: RequestInit): Promise<Response> => {
    url = u;
    methodSeen = init?.method ?? "";
    bodySeen = String(init?.body ?? "");
    authSeen = new Headers(
      (init?.headers ?? {}) as Record<string, string>,
    ).get("authorization") ?? "";
    return new Response(
      JSON.stringify({
        ok: true,
        action: "recover-pending",
        stats: { scanned: 2, committed: 1, aborted: 1, skipped: 0 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  const out = await recoverPendingViaServer({
    retentionBase: "http://x",
    token: "t",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  assert.equal(url, "http://x/api/internal/retention/recover-pending");
  assert.equal(methodSeen, "POST");
  assert.equal(bodySeen, "{}");
  assert.equal(authSeen, "Bearer t");
  assert.equal(out.error, null);
  assert.deepEqual(out.stats, { scanned: 2, committed: 1, aborted: 1, skipped: 0 });
});

test("recoverPendingViaServer: non-200 surfaces stage='recover-pending/http'", async () => {
  const fetchImpl = async (): Promise<Response> =>
    new Response("{}", { status: 503 });
  const out = await recoverPendingViaServer({
    retentionBase: "http://x",
    token: "t",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  assert.equal(out.stats, null);
  assert.ok(out.error);
  assert.equal(out.error!.stage, "recover-pending/http");
  assert.match(out.error!.message, /503/);
});

test("recoverPendingViaServer: fetch throw surfaces stage='recover-pending/fetch'", async () => {
  const fetchImpl = async (): Promise<Response> => {
    throw new Error("ECONNREFUSED");
  };
  const out = await recoverPendingViaServer({
    retentionBase: "http://x",
    token: "t",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  assert.ok(out.error);
  assert.equal(out.error!.stage, "recover-pending/fetch");
  assert.match(out.error!.message, /ECONNREFUSED/);
});

test("runPrune: posts to recover-pending at start of every cycle, before any per-file work", async () => {
  const root = tmpdir();
  // Seed a terminal run that has NO stdout/stderr chunks — modelling
  // the post-rename / pre-update crash scenario where the prior cycle
  // already rewrote the file in place. streamRewrite would return null
  // here, so pre-rename would never fire; the recovery endpoint is the
  // sole path that unsticks the SQLite gate.
  makeRun({
    root,
    runId: "stuck",
    endedAt: "2026-01-01T00:00:00Z",
    files: [{ idx: 0, lines: [{ type: "chunk_truncated", seq: 1, bytes_dropped: 100 }] }],
  });
  const order: string[] = [];
  const fetchImpl = async (url: string, _init?: RequestInit): Promise<Response> => {
    order.push(url);
    if (url.endsWith("/recover-pending")) {
      return new Response(
        JSON.stringify({
          ok: true,
          action: "recover-pending",
          stats: { scanned: 1, committed: 1, aborted: 0, skipped: 0 },
        }),
        { status: 200 },
      );
    }
    if (url.endsWith("/crashed-runs")) {
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }
    // No other call should happen — pressurePass on a single small run
    // is below the cap.
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const args: CliArgs = {
    retentionDays: 365,
    totalCapGb: 50,
    dryRun: false,
    json: true,
  };
  const result = await runPrune(args, {
    readToken: () => "t",
    obsRoot: root,
    skipEnsureRoot: true,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  // recover-pending fires first (before crashed-runs reconciliation).
  assert.ok(
    order[0]?.endsWith("/recover-pending"),
    "recover-pending must be the first network call (got " + order[0] + ")",
  );
  // Run completes cleanly.
  assert.equal(result.errors.length, 0);
  assert.equal(result.truncated.length, 0);
});

test("runPrune: recover-pending HTTP 500 is captured as a non-fatal error", async () => {
  const root = tmpdir();
  const fetchImpl = async (url: string): Promise<Response> => {
    if (url.endsWith("/recover-pending")) {
      return new Response(
        JSON.stringify({ ok: false, code: "recovery_failed" }),
        { status: 500 },
      );
    }
    return new Response(JSON.stringify({ items: [] }), { status: 200 });
  };
  const args: CliArgs = {
    retentionDays: 30,
    totalCapGb: 50,
    dryRun: false,
    json: true,
  };
  const result = await runPrune(args, {
    readToken: () => "t",
    obsRoot: root,
    skipEnsureRoot: true,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  assert.ok(
    result.errors.some((e) => e.stage === "recover-pending/http"),
    "recover-pending HTTP failure must be recorded as a non-fatal error",
  );
  // Cycle did not throw; later steps still ran.
});

// Suppress dangling-handle leaks (readline streams) from the rewrite test.
void {} as unknown as RunOnDisk;
