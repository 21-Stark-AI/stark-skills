// Tests for `tools/automation_lib.ts` — the automation fleet log +
// registry utilities ported from the `scripts/automation/` package.
// Ported alongside the code from test_automation_logs.py +
// test_automation_schema.py.

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  loadRegistry,
  parseRunHistory,
  prependRunRecord,
} from "./automation_lib.ts";

function tmpFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automation-test-"));
  return path.join(dir, name);
}

// ---------------------------------------------------------------------------
// prependRunRecord
// ---------------------------------------------------------------------------

test("prependRunRecord: inserts immediately after the schema_version comment", () => {
  const log = tmpFile("log.md");
  fs.writeFileSync(log, "# Run Log\n<!-- schema_version: 1 -->\n");
  prependRunRecord(log, "## Run 2026-03-28T10:00:00Z\n- **Status**: success");
  const lines = fs.readFileSync(log, "utf8").split("\n");
  const schemaIdx = lines.findIndex((l) => l.includes("schema_version"));
  assert.match(lines[schemaIdx + 1], /## Run 2026-03-28T10:00:00Z/);
});

test("prependRunRecord: newest record appears before older ones", () => {
  const log = tmpFile("log.md");
  fs.writeFileSync(log, "# Run Log\n<!-- schema_version: 1 -->\n");
  prependRunRecord(log, "## Run 2026-03-28T09:00:00Z\n- **Status**: success");
  prependRunRecord(log, "## Run 2026-03-28T10:00:00Z\n- **Status**: failure");
  const content = fs.readFileSync(log, "utf8");
  assert.ok(content.indexOf("10:00:00Z") < content.indexOf("09:00:00Z"));
});

test("prependRunRecord: no schema comment → inserts after the first H1", () => {
  const log = tmpFile("log.md");
  fs.writeFileSync(log, "# Title\nsome prose\n");
  prependRunRecord(log, "## Run 2026-05-20T00:00:00Z\n- **Status**: success");
  const lines = fs.readFileSync(log, "utf8").split("\n");
  assert.match(lines[1], /## Run 2026-05-20T00:00:00Z/);
});

// ---------------------------------------------------------------------------
// parseRunHistory
// ---------------------------------------------------------------------------

test("parseRunHistory: extracts all structured fields from a run block", () => {
  const log = tmpFile("log.md");
  fs.writeFileSync(
    log,
    [
      "# Run Log",
      "<!-- schema_version: 1 -->",
      "## Run 2026-03-28T10:00:00Z",
      "- **Status**: success",
      "- **Duration**: 42.5",
      "- **Prompt tokens**: 1000",
      "- **Completion tokens**: 500",
      "- **Total tokens**: 1500",
      "- **Cost**: $0.018",
      "- **Findings**: 3",
      "- **Actions**: opened PR #42",
      "---",
      "",
    ].join("\n"),
  );
  const records = parseRunHistory(log);
  assert.equal(records.length, 1);
  const r = records[0];
  assert.equal(r.timestamp, "2026-03-28T10:00:00Z");
  assert.equal(r.status, "success");
  assert.equal(r.duration_s, 42.5);
  assert.equal(r.tokens?.prompt, 1000);
  assert.equal(r.tokens?.completion, 500);
  assert.equal(r.tokens?.total, 1500);
  assert.equal(r.cost_usd, 0.018);
  assert.equal(r.findings, 3);
  assert.equal(r.actions, "opened PR #42");
  assert.equal(r.error, undefined);
});

test("parseRunHistory: nonexistent log → empty list", () => {
  assert.deepEqual(parseRunHistory(tmpFile("nonexistent.md")), []);
});

test("parseRunHistory: round-trips with prependRunRecord", () => {
  const log = tmpFile("log.md");
  fs.writeFileSync(log, "# Run Log\n<!-- schema_version: 1 -->\n");
  prependRunRecord(
    log,
    "## Run 2026-05-20T08:00:00Z\n- **Status**: success\n- **Findings**: 2",
  );
  const records = parseRunHistory(log);
  assert.equal(records.length, 1);
  assert.equal(records[0].status, "success");
  assert.equal(records[0].findings, 2);
});

// ---------------------------------------------------------------------------
// loadRegistry
// ---------------------------------------------------------------------------

test("loadRegistry: valid registry round-trips", () => {
  const reg = tmpFile("registry.json");
  const data = { schema_version: 1, skills: [] };
  fs.writeFileSync(reg, JSON.stringify(data));
  assert.deepEqual(loadRegistry(reg), data);
});

test("loadRegistry: malformed JSON → throws 'Invalid JSON'", () => {
  const reg = tmpFile("registry.json");
  fs.writeFileSync(reg, "not json {{{");
  assert.throws(() => loadRegistry(reg), /Invalid JSON/);
});

test("loadRegistry: missing file → throws 'Invalid JSON'", () => {
  assert.throws(() => loadRegistry(tmpFile("absent.json")), /Invalid JSON/);
});

test("loadRegistry: wrong schema_version → throws 'Unsupported schema_version'", () => {
  const reg = tmpFile("registry.json");
  fs.writeFileSync(reg, JSON.stringify({ schema_version: 99 }));
  assert.throws(() => loadRegistry(reg), /Unsupported schema_version/);
});

test("loadRegistry: non-object JSON → throws 'must be a JSON object'", () => {
  const reg = tmpFile("registry.json");
  fs.writeFileSync(reg, JSON.stringify([1, 2, 3]));
  assert.throws(() => loadRegistry(reg), /must be a JSON object/);
});
