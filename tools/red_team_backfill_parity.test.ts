// Phase 5a parity test: TS `runBackfill` + `buildEnvelopesForRow` vs
// Python `run_backfill` + `build_envelopes_for_row`. Both seed the same
// fixture DB, walk it, build envelopes for each row, and the test diffs
// the resulting envelope shapes + dedupe-key matrix.

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  initRedTeamTables,
  recordFindings,
  recordRedTeamRun,
} from "./red_team_audit_lib.ts";
import { policyFromConfig } from "./red_team_audit_text_lib.ts";
import { DatabaseSync } from "node:sqlite";
import {
  buildEnvelopesForRow,
  runBackfill,
  type BackfillScope,
} from "./red_team_backfill_lib.ts";

// Isolate the emit-queue DB so dry-run+manifest tests don't depend on
// real queue state.
process.env.STARK_QUEUE_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "rt-backfill-queue-"),
);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const PY_SCRIPTS = path.join(REPO_ROOT, "scripts");

function tmpDb(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rt-backfill-${label}-`));
  return path.join(dir, "audit.db");
}

function runPython(script: string, payload: string = ""): string {
  const proc = spawnSync(
    "python3",
    [
      "-c",
      `
import sys, json
sys.path.insert(0, ${JSON.stringify(PY_SCRIPTS)})
${script}
`,
    ],
    { input: payload, encoding: "utf8" },
  );
  if (proc.status !== 0) {
    throw new Error(`python helper failed (exit=${proc.status}): ${proc.stderr}`);
  }
  return proc.stdout;
}

function seedFixtureDb(dbPath: string): void {
  initRedTeamTables(dbPath);
  // One legacy-style run (no fix_plan_status). One forward run with a
  // successful fix-plan + warnings. One forward run with status=error.
  recordRedTeamRun(
    {
      run_id: "legacy-run",
      stage: "design",
      rounds_used: 1,
      final_status: "halted",
      total_findings: 2,
      critical_count: 0,
      high_count: 1,
      medium_count: 1,
      human_review_count: 0,
      duration_s: 1.5,
      cost_usd: 0.25,
      model: "gpt-5.5-pro",
      caller: "legacy-pipeline",
      repo: "Evinced/foo",
      artifact_relative_path: "docs/legacy.md",
      pr_number: null,
      // The audit lib defaults fix_plan_status to "pending" when null is
      // passed; pass through an explicit "pending"-equivalent here so the
      // legacy split (`fix_plan_status IS NULL`) still works. Backfill is
      // backward-compat for the actual NULL case, but recordRedTeamRun's
      // ?? "pending" coerces it. Use an UPDATE to NULL it out.
      fix_plan_status: null,
      fix_plan_md: null,
      fix_plan_json: null,
      fix_plan_cost_usd: null,
      created_at: "2026-01-01T00:00:00Z",
    },
    dbPath,
  );
  // Force fix_plan_status to NULL for the legacy split.
  const sqlite = new DatabaseSync(dbPath);
  try {
    sqlite
      .prepare("UPDATE red_team_runs SET fix_plan_status = NULL WHERE run_id = ?")
      .run("legacy-run");
  } finally {
    sqlite.close();
  }
  recordFindings(
    [
      {
        run_id: "legacy-run",
        stage: "design",
        round_num: 1,
        finding_id: "rt1",
        persona: "security-trust",
        severity: "high",
        concern: "Token leak via user@evinced.com",
        consequence: "Auth bypass",
        counter_proposal: "Rotate secret",
        trade_off: "deploy hit",
        reason_for_uncertainty: null,
        stable_key: "legacy-run:design:1:security-trust:rt1:h1",
        concern_hash: "h1",
        risk_key: null,
        affected_component: null,
        failure_mode: null,
      },
      {
        run_id: "legacy-run",
        stage: "design",
        round_num: 1,
        finding_id: "rt2",
        persona: "data",
        severity: "medium",
        concern: "Schema",
        consequence: "C",
        counter_proposal: "REQUEST_HUMAN_REVIEW",
        trade_off: null,
        reason_for_uncertainty: "needs ops",
        stable_key: "legacy-run:design:1:data:rt2:h2",
        concern_hash: "h2",
        risk_key: null,
        affected_component: null,
        failure_mode: null,
      },
    ],
    dbPath,
    policyFromConfig({ retain_full_text: true }),
  );

  // Forward run with successful fix plan.
  recordRedTeamRun(
    {
      run_id: "forward-run",
      stage: "plan",
      rounds_used: 1,
      final_status: "halted",
      total_findings: 1,
      critical_count: 0,
      high_count: 1,
      medium_count: 0,
      human_review_count: 0,
      duration_s: 0.8,
      cost_usd: 0.12,
      model: "gpt-5.5-pro",
      caller: "stark-red-team-ts",
      repo: "Evinced/foo",
      artifact_relative_path: "docs/plan.md",
      pr_number: 7,
      fix_plan_status: "success",
      fix_plan_md: "## Proposed Fix Plan\n...",
      fix_plan_json: JSON.stringify({
        moves: [
          { id: "m1", title: "stage", addressed_finding_ids: ["rt1"], new_trade_off: "step" },
        ],
        summary: "phased",
        notes: "",
        unaddressed_finding_ids: [],
        orphan_finding_ids: [],
        warnings: ["over_budget_after_fix"],
        cost_usd: 0.05,
        duration_s: 1.2,
        input_tokens: 100,
        output_tokens: 50,
        model: "gpt-5.5-pro",
        reasoning_effort: "xhigh",
      }),
      fix_plan_cost_usd: 0.05,
      created_at: "2026-02-01T00:00:00Z",
    },
    dbPath,
  );
  recordFindings(
    [
      {
        run_id: "forward-run",
        stage: "plan",
        round_num: 1,
        finding_id: "rt1",
        persona: "security-trust",
        severity: "high",
        concern: "Plan concern",
        consequence: "C",
        counter_proposal: "Real fix",
        trade_off: "T",
        reason_for_uncertainty: null,
        stable_key: "forward-run:plan:1:security-trust:rt1:fwd-h1",
        concern_hash: "fwd-h1",
        risk_key: null,
        affected_component: null,
        failure_mode: null,
      },
    ],
    dbPath,
    policyFromConfig({ retain_full_text: true }),
  );
}

// ── Pure envelope-builder parity (each scope) ─────────────────────────

for (const scope of ["all", "legacy", "forward"] as const) {
  test(`buildEnvelopesForRow parity vs Python build_envelopes_for_row (scope=${scope})`, async () => {
    const dbPath = tmpDb(`build-${scope}`);
    seedFixtureDb(dbPath);

    const tsStats = runBackfill({
      dbPath,
      scope,
      dryRun: true, // build envelopes only, don't enqueue
    });
    // Pull Python's dedupe-key + counts via dry-run manifest.
    const manifestPath = path.join(path.dirname(dbPath), "py-manifest.json");
    runPython(
      `
import red_team_backfill
stats = red_team_backfill.run_backfill(
    db_path=${JSON.stringify(dbPath)},
    scope=${JSON.stringify(scope)},
    dry_run=True,
    manifest_path=${JSON.stringify(manifestPath)},
)
sys.stdout.write(json.dumps({
    "rows": stats["rows"],
    "red_team_run": stats["red_team_run"],
    "red_team_finding": stats["red_team_finding"],
    "red_team_fix_plan": stats["red_team_fix_plan"],
    "dedupe_keys": list(stats["dedupe_keys"]),
}))
`,
    );
    const pyManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.deepEqual(
      [...tsStats.dedupe_keys].sort(),
      [...pyManifest.dedupe_keys].sort(),
      `dedupe-key matrix divergence on scope=${scope}`,
    );
    // Counts also match.
    assert.equal(tsStats.red_team_run, pyManifest.scope ? pyManifest.dedupe_keys.filter((k: string) => k.startsWith("red-team:run:")).length : 0);
    assert.equal(tsStats.red_team_finding, pyManifest.dedupe_keys.filter((k: string) => k.startsWith("red-team:finding:")).length);
    assert.equal(tsStats.red_team_fix_plan, pyManifest.dedupe_keys.filter((k: string) => k.startsWith("red-team:fix_plan:")).length);
  });
}

// ── Live enqueue parity (with isolated queue dir) ─────────────────────

test("runBackfill enqueues envelopes that Python recognizes as duplicates", async () => {
  // First run: TS enqueues. Second run: Python tries the same envelopes,
  // gets duplicate=true for every one (the dedupe-key contract).
  const dbPath = tmpDb("enqueue");
  seedFixtureDb(dbPath);
  const tsStats = runBackfill({ dbPath, scope: "all" });
  assert.ok(tsStats.enqueued > 0, "first TS pass should enqueue at least one event");
  assert.equal(tsStats.duplicates, 0, "first TS pass should report zero duplicates");

  const pyStdout = runPython(
    `
import red_team_backfill
stats = red_team_backfill.run_backfill(
    db_path=${JSON.stringify(dbPath)}, scope="all",
)
sys.stdout.write(json.dumps({
    "enqueued": stats["enqueued"], "duplicates": stats["duplicates"], "rows": stats["rows"],
}))
`,
  );
  const pyStats = JSON.parse(pyStdout);
  assert.equal(pyStats.rows, tsStats.rows, "row counts must match");
  assert.equal(pyStats.enqueued, 0, "Python pass after TS must enqueue zero new envelopes");
  // Every envelope already in queue → all duplicates.
  assert.equal(
    pyStats.duplicates,
    tsStats.red_team_run + tsStats.red_team_finding + tsStats.red_team_fix_plan,
    "Python should report all envelopes as duplicates",
  );
});

// ── Scope-flag boundary cases ─────────────────────────────────────────

test("runBackfill rejects unsupported scope", () => {
  assert.throws(
    () =>
      runBackfill({
        dbPath: tmpDb("bad-scope"),
        scope: "bogus" as unknown as BackfillScope,
      }),
    /unsupported scope/,
  );
});

test("buildEnvelopesForRow skips fix-plan envelope for non-success rows", () => {
  // Forward row whose fix-plan errored — should NOT emit a fix_plan envelope.
  const row = {
    run_id: "x",
    stage: "design",
    rounds_used: 1,
    final_status: "halted",
    total_findings: 0,
    critical_count: 0,
    high_count: 0,
    medium_count: 0,
    human_review_count: 0,
    duration_s: 0,
    cost_usd: 0,
    model: "m",
    caller: "c",
    created_at: "2026-01-01T00:00:00Z",
    repo: "r",
    artifact_relative_path: null,
    pr_number: null,
    fix_plan_status: "error",
    fix_plan_md: null,
    fix_plan_json: '{"error":"boom"}',
    fix_plan_cost_usd: null,
    findings: [],
  };
  const envs = buildEnvelopesForRow(row);
  assert.equal(envs.length, 1, "errored fix-plan row should emit only run envelope");
  assert.equal(envs[0]!.type, "red_team_run");
});
