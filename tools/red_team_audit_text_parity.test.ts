// Phase 5a parity test: TS `applyToField` vs Python `apply_to_field`.
//
// Feeds identical inputs through both implementations and asserts the
// resulting RetainedText shape (stored + hash) matches byte-for-byte.
// Catches regression if either side's redaction patterns / excerpt
// truncation / hash algorithm drifts.

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  applyToField,
  policyFromConfig,
  type AuditRetentionPolicy,
} from "./red_team_audit_text_lib.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

function pythonApplyToField(
  text: string | null,
  policy: AuditRetentionPolicy,
): { stored: string | null; hash: string | null } {
  // Shell into Python red_team_audit_text with the same inputs.
  const script = `
import sys, json
sys.path.insert(0, ${JSON.stringify(path.join(REPO_ROOT, "scripts"))})
from red_team_audit_text import apply_to_field, AuditRetentionPolicy
payload = json.loads(sys.stdin.read())
policy = AuditRetentionPolicy(
    retain_full_text=payload["retain_full_text"],
    excerpt_max_chars=payload["excerpt_max_chars"],
)
out = apply_to_field(payload["text"], policy)
json.dump({"stored": out.stored, "hash": out.hash}, sys.stdout)
`;
  const proc = spawnSync("python3", ["-c", script], {
    input: JSON.stringify({
      text,
      retain_full_text: policy.retainFullText,
      excerpt_max_chars: policy.excerptMaxChars,
    }),
    encoding: "utf8",
  });
  if (proc.status !== 0) {
    throw new Error(
      `python apply_to_field failed (exit=${proc.status}): ${proc.stderr}`,
    );
  }
  return JSON.parse(proc.stdout) as { stored: string | null; hash: string | null };
}

const FIXTURES: Array<{ name: string; text: string | null; cfg: Record<string, unknown> }> = [
  { name: "null input", text: null, cfg: {} },
  { name: "empty string", text: "", cfg: {} },
  {
    name: "excerpt mode (default), short clean text",
    text: "All good, nothing sensitive.",
    cfg: {},
  },
  {
    name: "excerpt mode, long text gets truncated",
    text: "x".repeat(500),
    cfg: { excerpt_max_chars: 100 },
  },
  {
    name: "excerpt mode, email + IP get redacted before hash",
    text: "alice@evinced.com from 192.168.1.42 reported the issue",
    cfg: {},
  },
  {
    name: "excerpt mode, OpenAI token + GitHub token redacted",
    text: "leak: sk-abcdefghijklmnopqrst plus ghp_xxxxxxxxxxxxxxxxx",
    cfg: {},
  },
  {
    name: "excerpt mode, SSN / CC / phone PII",
    text: "ssn 123-45-6789 card 1234-5678-9012-3456 phone 555-123-4567",
    cfg: {},
  },
  {
    name: "full-text retention, secrets still redacted",
    text: "leak: sk-zzzzzzzzzzzzzzzzzzzz user@evinced.com",
    cfg: { retain_full_text: true },
  },
  {
    name: "excerpt mode with custom excerpt_max_chars",
    text: "A medium-length finding concern that needs trimming for audit retention",
    cfg: { excerpt_max_chars: 30 },
  },
];

for (const fx of FIXTURES) {
  test(`parity: ${fx.name}`, () => {
    const policy = policyFromConfig(fx.cfg);
    const tsOut = applyToField(fx.text, policy);
    const pyOut = pythonApplyToField(fx.text, policy);
    assert.deepEqual(
      tsOut,
      pyOut,
      `divergence on "${fx.name}":\n  TS:     ${JSON.stringify(tsOut)}\n  Python: ${JSON.stringify(pyOut)}`,
    );
  });
}

test("policyFromConfig defaults match Python (excerpt mode, 240 cap)", () => {
  const policy = policyFromConfig(null);
  assert.equal(policy.retainFullText, false);
  assert.equal(policy.excerptMaxChars, 240);
});

test("policyFromConfig honors retain_full_text + excerpt_max_chars overrides", () => {
  const policy = policyFromConfig({ retain_full_text: true, excerpt_max_chars: 80 });
  assert.equal(policy.retainFullText, true);
  assert.equal(policy.excerptMaxChars, 80);
});
