// Tests for `tools/approach_contract_lib.ts` — the plan-file → approach
// contract extractor ported from `scripts/approach_contract.py`.

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildContract,
  dedupe,
  detectViolations,
  extractConstraints,
  extractGoals,
  extractHow,
  findRepoRoot,
  formatContract,
} from "./approach_contract_lib.ts";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "approach-test-"));
}

// ---------------------------------------------------------------------------
// dedupe
// ---------------------------------------------------------------------------

test("dedupe: normalizes whitespace, drops empties, keeps first-seen order", () => {
  assert.deepEqual(
    dedupe(["  Build   X ", "Build X", "", "Ship  Y", "ship y"]),
    ["Build X", "Ship Y"],
  );
});

// ---------------------------------------------------------------------------
// extractGoals
// ---------------------------------------------------------------------------

test("extractGoals: pulls heading title + bullets under a Goal section", () => {
  const plan = [
    "# Goal",
    "- ship the thing",
    "- delight users",
    "## Other",
    "- ignored bullet",
  ].join("\n");
  assert.deepEqual(extractGoals(plan), [
    "Goal",
    "ship the thing",
    "delight users",
  ]);
});

test("extractGoals: falls back to non-phase/task headings when no goal section", () => {
  const plan = ["# Architecture", "## Phase 1", "## Rollout"].join("\n");
  // "Phase 1" filtered out; "Phase"/"Task"/"Step" prefixes excluded.
  assert.deepEqual(extractGoals(plan), ["Architecture", "Rollout"]);
});

// ---------------------------------------------------------------------------
// extractHow
// ---------------------------------------------------------------------------

test("extractHow: collects phase headings + substantive bullets", () => {
  const plan = [
    "## Phase 1: setup",
    "- do a thing here",
    "- short",
    "## Notes",
  ].join("\n");
  // "Phase 1: setup" (heading prefix), "do a thing here" (>=3 words).
  // "short" is < 3 words → dropped; "Notes" not a how-prefix → dropped.
  assert.deepEqual(extractHow(plan), ["Phase 1: setup", "do a thing here"]);
});

// ---------------------------------------------------------------------------
// extractConstraints + findRepoRoot
// ---------------------------------------------------------------------------

test("extractConstraints: reads constraint lines from CLAUDE.md", () => {
  const dir = tmp();
  try {
    fs.writeFileSync(
      path.join(dir, "CLAUDE.md"),
      [
        "# Rules",
        "- You must run tests",
        "- This is just prose",
        "- Never push to main",
      ].join("\n"),
    );
    assert.deepEqual(extractConstraints(dir), [
      "You must run tests",
      "Never push to main",
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("extractConstraints: missing CLAUDE.md → empty list", () => {
  const dir = tmp();
  try {
    assert.deepEqual(extractConstraints(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("findRepoRoot: walks up to the dir holding CLAUDE.md", () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, "CLAUDE.md"), "x");
    const sub = path.join(dir, "docs", "specs");
    fs.mkdirSync(sub, { recursive: true });
    const planFile = path.join(sub, "plan.md");
    fs.writeFileSync(planFile, "x");
    assert.equal(fs.realpathSync(findRepoRoot(planFile)), fs.realpathSync(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// detectViolations
// ---------------------------------------------------------------------------

test("detectViolations: flags a constraint whose forbidden term appears in the plan", () => {
  const constraints = ["Do not commit without review", "You must verify changes"];
  const plan = "Step 1: git commit the work and ship.";
  assert.deepEqual(detectViolations(plan, constraints), [
    "Do not commit without review",
  ]);
});

test("detectViolations: no forbidden term in plan → no violations", () => {
  const constraints = ["Do not push directly"];
  assert.deepEqual(detectViolations("just edit some files", constraints), []);
});

// ---------------------------------------------------------------------------
// buildContract + formatContract
// ---------------------------------------------------------------------------

test("buildContract: valid plan → valid=true, confirmed=false", () => {
  const dir = tmp();
  try {
    const planFile = path.join(dir, "plan.md");
    fs.writeFileSync(planFile, "# Goal\n- build the feature cleanly\n");
    const c = buildContract(planFile);
    assert.equal(c.plan_file, planFile);
    assert.equal(c.valid, true);
    assert.equal(c.confirmed, false);
    assert.deepEqual(c.violations, []);
    assert.ok(c.what.includes("Goal"));
    assert.match(c.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("buildContract: plan violating a CLAUDE.md constraint → valid=false", () => {
  const dir = tmp();
  try {
    fs.writeFileSync(
      path.join(dir, "CLAUDE.md"),
      "- You must run tests before merging\n",
    );
    const planFile = path.join(dir, "plan.md");
    fs.writeFileSync(planFile, "# Goal\n- skip tests to move faster\n");
    const c = buildContract(planFile);
    assert.equal(c.valid, false);
    assert.equal(c.violations.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("formatContract: renders What/How/Constraints sections", () => {
  const out = formatContract({
    plan_file: "/x/plan.md",
    what: ["Goal A"],
    how: ["Phase 1"],
    constraints: [],
    valid: true,
    violations: [],
    confirmed: false,
    timestamp: "2026-05-20T00:00:00Z",
  });
  assert.match(out, /Approach Contract: \/x\/plan\.md/);
  assert.match(out, /What\n- Goal A/);
  assert.match(out, /How\n- Phase 1/);
  assert.match(out, /No CLAUDE\.md constraints found/);
});
