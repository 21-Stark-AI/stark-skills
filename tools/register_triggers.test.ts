// Tests for `scripts/register_triggers.sh`. Ported from the deleted
// `scripts/test_register_triggers.py` as part of the Python→TS migration
// (Phase 5): the repo keeps no Python, so this shell-script test moves to
// the TypeScript test suite.

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "register_triggers.sh");

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("bash", [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 30_000,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

test("register_triggers.sh: exists and is executable", () => {
  const st = fs.statSync(SCRIPT);
  assert.ok(st.isFile());
  assert.ok((st.mode & 0o111) !== 0, "script should be executable");
});

test("register_triggers.sh --dry-run: lists triggers + prompts dir", () => {
  const r = run(["--dry-run"]);
  assert.equal(r.status, 0);
  assert.ok(
    r.stdout.includes(`Prompts: ${path.join(REPO_ROOT, "automation", "prompts")}`),
    "dry-run output should name the prompts directory",
  );
  assert.ok(r.stdout.includes("stark-sentinel"), "dry-run output should list triggers");
});

test("register_triggers.sh --list: shows the registry", () => {
  assert.equal(run(["--list"]).status, 0);
});

test("register_triggers.sh --trigger <unknown>: fails", () => {
  assert.notEqual(run(["--trigger", "nonexistent-trigger"]).status, 0);
});

test("register_triggers: every configured trigger has a prompt file", () => {
  const config = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "global", "config.json"), "utf8"),
  );
  const configured = new Set(Object.keys(config.automation.triggers));
  const promptsDir = path.join(REPO_ROOT, "automation", "prompts");
  const prompts = new Set(
    fs
      .readdirSync(promptsDir)
      .filter((n) => n.startsWith("stark-") && n.endsWith(".md"))
      .map((n) => n.replace(/\.md$/, "")),
  );
  assert.deepEqual([...configured].sort(), [...prompts].sort());
});
