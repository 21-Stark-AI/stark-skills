import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveAgents,
  parseFindings,
  dedupeFindings,
  type IacFinding,
} from "./iac_review_lib.ts";

test("resolveAgents: CLI overrides config, filters unknown, dedupes, preserves order", () => {
  const { agents, skipped } = resolveAgents(
    ["gemini", "codex", "gemini", "bogus"],
    ["claude"],
  );
  assert.deepEqual(agents, ["gemini", "codex"]);
  assert.ok(skipped.some((s) => s.startsWith("bogus")));
});

test("resolveAgents: falls back to config when no CLI agents", () => {
  const { agents } = resolveAgents(null, ["codex"]);
  assert.deepEqual(agents, ["codex"]);
});

test("resolveAgents: falls back to ['codex'] when neither given", () => {
  const { agents } = resolveAgents(null, undefined);
  assert.deepEqual(agents, ["codex"]);
});

test("parseFindings: extracts trailing JSON array, ignores prose/fences", () => {
  const raw = [
    "Here is my review. I found one issue.",
    "```json",
    '[{"severity":"high","file":"main.tf","line":12,"title":"Public bucket","description":"no PAB","suggestion":"add aws_s3_bucket_public_access_block"}]',
    "```",
    "Done.",
  ].join("\n");
  const f = parseFindings(raw, "codex");
  assert.equal(f.length, 1);
  assert.equal(f[0].agent, "codex");
  assert.equal(f[0].severity, "high");
  assert.equal(f[0].file, "main.tf");
  assert.equal(f[0].line, 12);
});

test("parseFindings: coerces bad severity to medium, drops title-less items, empty array", () => {
  assert.deepEqual(parseFindings("[]", "codex"), []);
  const f = parseFindings(
    '[{"severity":"sev0","title":"x"},{"description":"no title"}]',
    "gemini",
  );
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, "medium");
  assert.equal(f[0].line, 0);
});

test("parseFindings: returns [] on garbage", () => {
  assert.deepEqual(parseFindings("no json here", "codex"), []);
  assert.deepEqual(parseFindings("", "codex"), []);
});

test("dedupeFindings: merges same file+title across agents into cross-validated", () => {
  const findings: IacFinding[] = [
    {
      agent: "codex", severity: "high", file: "main.tf", line: 10,
      title: "Public S3 bucket", description: "", suggestion: "", cross_validated_by: [],
    },
    {
      agent: "gemini", severity: "critical", file: "main.tf", line: 11,
      title: "Public S3 bucket!", description: "", suggestion: "", cross_validated_by: [],
    },
    {
      agent: "codex", severity: "low", file: "variables.tf", line: 3,
      title: "Missing description", description: "", suggestion: "", cross_validated_by: [],
    },
  ];
  const merged = dedupeFindings(findings);
  assert.equal(merged.length, 2);
  // highest severity wins for the merged group, and the other agent is recorded
  const bucket = merged.find((m) => m.file === "main.tf")!;
  assert.equal(bucket.severity, "critical");
  assert.ok(bucket.cross_validated_by.length >= 1);
  // sorted: critical before low
  assert.equal(merged[0].severity, "critical");
});
