// Tests for `tools/plan_to_tasks_validate_lib.ts` — the pure logic of the
// plan-to-tasks validation dispatch ported from
// `scripts/plan_to_tasks_validate.py`. Subprocess dispatch is verified live.

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildValidationEnvelope,
  computePlanHash,
  DEFAULT_PLAN_TO_TASKS_CONFIG,
  loadConfig,
  parseValidationOutput,
} from "./plan_to_tasks_validate_lib.ts";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "p2t-validate-test-"));
}

// ---------------------------------------------------------------------------
// computePlanHash
// ---------------------------------------------------------------------------

test("computePlanHash: stable sha256 with prefix", () => {
  const h = computePlanHash("hello world");
  assert.match(h, /^sha256:[0-9a-f]{64}$/);
  assert.equal(h, computePlanHash("hello world"));
  assert.notEqual(h, computePlanHash("hello world!"));
});

// ---------------------------------------------------------------------------
// buildValidationEnvelope
// ---------------------------------------------------------------------------

test("buildValidationEnvelope: wraps plan + breakdown + hash", () => {
  const env = buildValidationEnvelope("plan text", { phases: [] }, "sha256:abc");
  assert.equal(env.schema_version, 1);
  assert.equal(env.plan_markdown, "plan text");
  assert.deepEqual(env.breakdown, { phases: [] });
  assert.equal(env.plan_hash, "sha256:abc");
});

// ---------------------------------------------------------------------------
// parseValidationOutput
// ---------------------------------------------------------------------------

test("parseValidationOutput: approved object with no issues", () => {
  const raw = JSON.stringify({ schema_version: 1, approved: true, issues: [] });
  const r = parseValidationOutput(raw, "codex");
  assert.equal(r.approved, true);
  assert.equal(r.issues.length, 0);
  assert.equal(r.error, null);
});

test("parseValidationOutput: collects well-formed issues", () => {
  const raw = JSON.stringify({
    approved: false,
    issues: [
      { phase_id: "P1", task_id: "T1", field: "how", problem: "vague", suggestion: "be specific" },
    ],
  });
  const r = parseValidationOutput(raw, "codex");
  assert.equal(r.approved, false);
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0].task_id, "T1");
  assert.equal(r.issues[0].suggestion, "be specific");
});

test("parseValidationOutput: drops issues missing required fields", () => {
  const raw = JSON.stringify({
    approved: false,
    issues: [{ phase_id: "P1", task_id: "T1" }], // missing field + problem
  });
  const r = parseValidationOutput(raw, "codex");
  assert.equal(r.issues.length, 0);
});

test("parseValidationOutput: strips markdown fences", () => {
  const raw = '```json\n{"approved": true, "issues": []}\n```';
  const r = parseValidationOutput(raw, "codex");
  assert.equal(r.approved, true);
  assert.equal(r.error, null);
});

test("parseValidationOutput: unwraps Gemini {response} envelope", () => {
  const inner = JSON.stringify({ approved: true, issues: [] });
  const raw = JSON.stringify({ response: inner });
  const r = parseValidationOutput(raw, "gemini");
  assert.equal(r.approved, true);
  assert.equal(r.error, null);
});

test("parseValidationOutput: malformed JSON → error result", () => {
  const r = parseValidationOutput("not json at all", "codex");
  assert.equal(r.approved, false);
  assert.match(r.error ?? "", /JSON parse error/);
});

test("parseValidationOutput: non-object JSON → error result", () => {
  const r = parseValidationOutput("[1,2,3]", "codex");
  assert.equal(r.approved, false);
  assert.match(r.error ?? "", /Expected JSON object/);
});

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

test("loadConfig: no config file → defaults", () => {
  const dir = tmp();
  try {
    const cfg = loadConfig(null, path.join(dir, "config.json"));
    assert.deepEqual(cfg, DEFAULT_PLAN_TO_TASKS_CONFIG);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig: global plan_to_tasks section merges over defaults", () => {
  const dir = tmp();
  try {
    const cfgFile = path.join(dir, "config.json");
    fs.writeFileSync(
      cfgFile,
      JSON.stringify({ plan_to_tasks: { validation_agents: ["codex", "gemini"] } }),
    );
    const cfg = loadConfig(null, cfgFile);
    assert.deepEqual(cfg.validation_agents, ["codex", "gemini"]);
    assert.equal(cfg.timeout, 300); // default survives
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig: repo section overrides global", () => {
  const globalDir = tmp();
  const repoDir = tmp();
  try {
    const globalFile = path.join(globalDir, "config.json");
    fs.writeFileSync(globalFile, JSON.stringify({ plan_to_tasks: { timeout: 100 } }));
    fs.mkdirSync(path.join(repoDir, ".code-review"), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, ".code-review", "config.json"),
      JSON.stringify({ plan_to_tasks: { timeout: 999 } }),
    );
    const cfg = loadConfig(repoDir, globalFile);
    assert.equal(cfg.timeout, 999);
  } finally {
    fs.rmSync(globalDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
