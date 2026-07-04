// tools/red_team_fold_lib.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { sha256Hex, resolveFixPlanForFold, parseDispositions } from "./red_team_fold_lib.ts";

const PLAN = JSON.stringify({ summary: "s", moves: [], model: "gpt-5.5-pro",
  unaddressed_finding_ids: [], orphan_finding_ids: [], notes: "", input_truncated: false,
  input_omitted_finding_ids: [], warnings: [], raw_output: "", duration_s: 0, cost_usd: 0,
  input_tokens: 0, output_tokens: 0, reasoning_effort: "xhigh", error: null });

test("resolve: sidecar chosen when artifact_hash matches", () => {
  const art = "ARTIFACT BODY";
  const h = sha256Hex(art);
  const r = resolveFixPlanForFold({ artifactText: art,
    sidecar: { fixPlanJson: PLAN, runId: "run-1", artifactHash: h },
    explicitFixPlanJson: null, dbLatest: null, sourceRunId: null, forceStale: false });
  assert.equal(r.status, "ok");
  assert.equal(r.source?.sourceRunId, "run-1");
});

test("resolve: sidecar hash mismatch → stale_fix_plan unless forceStale", () => {
  const r = resolveFixPlanForFold({ artifactText: "EDITED",
    sidecar: { fixPlanJson: PLAN, runId: "run-1", artifactHash: sha256Hex("OLD") },
    explicitFixPlanJson: null, dbLatest: null, sourceRunId: null, forceStale: false });
  assert.equal(r.status, "stale_fix_plan");
  const forced = resolveFixPlanForFold({ artifactText: "EDITED",
    sidecar: { fixPlanJson: PLAN, runId: "run-1", artifactHash: sha256Hex("OLD") },
    explicitFixPlanJson: null, dbLatest: null, sourceRunId: null, forceStale: true });
  assert.equal(forced.status, "ok");
});

test("resolve: DB fallback requires --source-run-id", () => {
  const art = "A"; const h = sha256Hex(art);
  const noId = resolveFixPlanForFold({ artifactText: art, sidecar: null,
    explicitFixPlanJson: null, dbLatest: { fixPlanJson: PLAN, runId: "run-9", artifactHash: h },
    sourceRunId: null, forceStale: false });
  assert.equal(noId.status, "source_run_id_required");
  const withId = resolveFixPlanForFold({ artifactText: art, sidecar: null,
    explicitFixPlanJson: null, dbLatest: { fixPlanJson: PLAN, runId: "run-9", artifactHash: h },
    sourceRunId: "run-9", forceStale: false });
  assert.equal(withId.status, "ok");
});

test("resolve: nothing available → no_fix_plan_found", () => {
  const r = resolveFixPlanForFold({ artifactText: "A", sidecar: null,
    explicitFixPlanJson: null, dbLatest: null, sourceRunId: null, forceStale: false });
  assert.equal(r.status, "no_fix_plan_found");
});

const MOVES = [
  { id: "m1", title: "t1", addressed_finding_ids: ["rt1"], rationale: "r", sections_touched: ["§1"], new_trade_off: "to" },
  { id: "m2", title: "t2", addressed_finding_ids: ["rt2"], rationale: "r", sections_touched: [], new_trade_off: "to" },
];

test("parseDispositions: accept requires a patch", () => {
  const raw = JSON.stringify({ summary: "s", dispositions: [
    { move_id: "m1", addressed_finding_ids: ["rt1"], disposition: "accept", rationale: "ok",
      patch: { old: "AAA", new: "BBB" } },
    { move_id: "m2", addressed_finding_ids: ["rt2"], disposition: "reject", rationale: "no" },
  ]});
  const { dispositions, invalid } = parseDispositions(raw, MOVES);
  assert.equal(dispositions.length, 2);
  assert.equal(invalid.length, 0);
  assert.equal(dispositions[0].patch?.old, "AAA");
  assert.equal(dispositions[0].move_snapshot_json.includes("m1"), true);
});

test("parseDispositions: accept without patch is invalid", () => {
  const raw = JSON.stringify({ dispositions: [
    { move_id: "m1", disposition: "accept", rationale: "ok" } ]});
  const { dispositions, invalid } = parseDispositions(raw, MOVES);
  assert.equal(dispositions.length, 0);
  assert.equal(invalid[0].reason, "accept_without_patch");
});

test("parseDispositions: empty rationale invalid; unknown move invalid", () => {
  const raw = JSON.stringify({ dispositions: [
    { move_id: "m1", disposition: "reject", rationale: "" },
    { move_id: "m9", disposition: "reject", rationale: "x" } ]});
  const { invalid } = parseDispositions(raw, MOVES);
  assert.equal(invalid.some(i => i.reason === "empty_rationale"), true);
  assert.equal(invalid.some(i => i.reason === "unknown_move_id"), true);
});
