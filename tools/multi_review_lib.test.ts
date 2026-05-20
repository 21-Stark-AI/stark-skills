// Tests for `tools/multi_review_lib.ts` — the pure logic of the
// multi-agent PR review orchestrator ported from `scripts/multi_review.py`.
// The subprocess dispatch / GitHub posting is verified live, not here.

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  allFindings,
  applySeverityOverrides,
  deduplicateFindings,
  extractSpecLink,
  filterOutOfDiffFindings,
  type Finding,
  FindingsParseError,
  formatAgentReviewBody,
  formatSummaryTable,
  hasActionableFindings,
  makeFinding,
  parseFindings,
  resolveBaseRef,
  resolveDomainAgents,
  resolveSpecContent,
  type ReviewRound,
} from "./multi_review_lib.ts";

function f(over: Partial<Finding> & { agent?: string; domain?: string }): Finding {
  return makeFinding({
    agent: over.agent ?? "claude",
    domain: over.domain ?? "behavior",
    severity: over.severity ?? "high",
    file: over.file ?? "src/a.ts",
    line: over.line ?? 10,
    title: over.title ?? "Some bug",
    description: over.description ?? "desc",
    suggestion: over.suggestion ?? "",
  });
}

// ---------------------------------------------------------------------------
// extractSpecLink
// ---------------------------------------------------------------------------

test("extractSpecLink: pulls the value after '## Spec:'", () => {
  assert.equal(extractSpecLink("## Spec: docs/spec.md\nother"), "docs/spec.md");
});

test("extractSpecLink: null body / no match / comment placeholder → null", () => {
  assert.equal(extractSpecLink(null), null);
  assert.equal(extractSpecLink("no spec here"), null);
  assert.equal(extractSpecLink("## Spec: <!-- fill me -->"), null);
});

test("extractSpecLink: 'N/A' is returned verbatim", () => {
  assert.equal(extractSpecLink("## Spec: N/A"), "N/A");
});

test("extractSpecLink: empty value → null; URL is returned verbatim", () => {
  assert.equal(extractSpecLink("## Spec: "), null);
  assert.equal(
    extractSpecLink("## Spec: https://github.com/Org/repo/blob/main/spec.md"),
    "https://github.com/Org/repo/blob/main/spec.md",
  );
});

// ---------------------------------------------------------------------------
// resolveSpecContent
// ---------------------------------------------------------------------------

test("resolveSpecContent: N/A and URLs resolve to null", () => {
  assert.equal(resolveSpecContent("N/A", "/tmp"), null);
  assert.equal(resolveSpecContent("https://example.com/spec.md", "/tmp"), null);
});

test("resolveSpecContent: reads a real file relative to cwd", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spec-test-"));
  try {
    fs.mkdirSync(path.join(dir, "docs", "specs"), { recursive: true });
    fs.writeFileSync(path.join(dir, "docs", "specs", "s.md"), "# Test Spec\nGoals");
    assert.equal(resolveSpecContent("docs/specs/s.md", dir), "# Test Spec\nGoals");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSpecContent: missing file → null", () => {
  assert.equal(resolveSpecContent("docs/specs/nonexistent.md", "/tmp"), null);
});

// ---------------------------------------------------------------------------
// parseFindings
// ---------------------------------------------------------------------------

test("parseFindings: plain JSON array", () => {
  const raw = JSON.stringify([
    { severity: "HIGH", file: "x.ts", line: 3, title: "T", description: "D", suggestion: "S" },
  ]);
  const got = parseFindings("claude", "security", raw);
  assert.equal(got.length, 1);
  assert.equal(got[0].severity, "high"); // lowercased
  assert.equal(got[0].agent, "claude");
  assert.equal(got[0].domain, "security");
  assert.equal(got[0].line, 3);
});

test("parseFindings: empty array", () => {
  assert.deepEqual(parseFindings("codex", "behavior", "[]"), []);
});

test("parseFindings: strips ```json fences", () => {
  const raw = "```json\n[{\"severity\":\"low\",\"file\":\"a\",\"line\":1,\"title\":\"t\",\"description\":\"d\",\"suggestion\":\"\"}]\n```";
  const got = parseFindings("claude", "x", raw);
  assert.equal(got.length, 1);
  assert.equal(got[0].severity, "low");
});

test("parseFindings: extracts an array embedded in prose", () => {
  const raw = 'Here are my findings:\n[{"severity":"medium","file":"a","line":1,"title":"t","description":"d","suggestion":""}]\nDone.';
  const got = parseFindings("claude", "x", raw);
  assert.equal(got.length, 1);
  assert.equal(got[0].severity, "medium");
});

test("parseFindings: missing fields fall back to defaults", () => {
  const got = parseFindings("claude", "x", JSON.stringify([{}]));
  assert.equal(got[0].severity, "medium");
  assert.equal(got[0].file, "unknown");
  assert.equal(got[0].title, "Untitled");
  assert.equal(got[0].line, 0);
});

test("parseFindings: no array anywhere → FindingsParseError", () => {
  assert.throws(() => parseFindings("claude", "x", "just prose, no json"), FindingsParseError);
});

// ---------------------------------------------------------------------------
// resolveDomainAgents
// ---------------------------------------------------------------------------

test("resolveDomainAgents: override applies to every domain", () => {
  const got = resolveDomainAgents({}, ["a", "b"], "claude");
  assert.deepEqual(got, { a: "claude", b: "claude" });
});

test("resolveDomainAgents: config map with codex fallback", () => {
  const got = resolveDomainAgents({ domain_agents: { security: "claude" } }, ["security", "behavior"]);
  assert.deepEqual(got, { security: "claude", behavior: "codex" });
});

test("resolveDomainAgents: empty override string throws", () => {
  assert.throws(() => resolveDomainAgents({}, ["a"], "  "), /non-empty string/);
});

// ---------------------------------------------------------------------------
// filterOutOfDiffFindings
// ---------------------------------------------------------------------------

test("filterOutOfDiffFindings: empty changed set keeps everything", () => {
  const findings = [f({ file: "a.ts" }), f({ file: "b.ts" })];
  const [kept, dropped] = filterOutOfDiffFindings(findings, new Set());
  assert.equal(kept.length, 2);
  assert.equal(dropped.length, 0);
});

test("filterOutOfDiffFindings: drops findings outside the diff, keeps file-less ones", () => {
  const findings = [f({ file: "in.ts" }), f({ file: "out.ts" }), f({ file: "" })];
  const [kept, dropped] = filterOutOfDiffFindings(findings, new Set(["in.ts"]));
  assert.deepEqual(kept.map((x) => x.file).sort(), ["", "in.ts"]);
  assert.deepEqual(dropped.map((x) => x.file), ["out.ts"]);
});

// ---------------------------------------------------------------------------
// deduplicateFindings
// ---------------------------------------------------------------------------

test("deduplicateFindings: exact-location duplicates collapse, keep highest severity", () => {
  const findings = [
    f({ agent: "claude", domain: "behavior", file: "a.ts", line: 10, title: "Null deref", severity: "medium" }),
    f({ agent: "codex", domain: "security", file: "a.ts", line: 10, title: "Null deref", severity: "critical" }),
  ];
  const got = deduplicateFindings(findings);
  assert.equal(got.length, 1);
  assert.equal(got[0].severity, "critical");
  assert.ok(got[0].description.includes("also flagged by"));
});

test("deduplicateFindings: distinct findings are not merged", () => {
  const findings = [
    f({ file: "a.ts", line: 10, title: "Null deref" }),
    f({ file: "b.ts", line: 99, title: "Race condition" }),
  ];
  assert.equal(deduplicateFindings(findings).length, 2);
});

// ---------------------------------------------------------------------------
// applySeverityOverrides
// ---------------------------------------------------------------------------

test("applySeverityOverrides: min_severity downgrades findings below the floor", () => {
  const findings = [f({ domain: "style", severity: "low" })];
  applySeverityOverrides(findings, { style: { min_severity: "high" } });
  assert.equal(findings[0].severity, "low");
});

test("applySeverityOverrides: title_patterns caps a matching finding", () => {
  const findings = [f({ domain: "perf", severity: "critical", title: "unbounded memory growth" })];
  applySeverityOverrides(findings, {
    perf: { title_patterns: { "unbounded memory": { max_severity: "low" } } },
  });
  assert.equal(findings[0].severity, "low");
});

// ---------------------------------------------------------------------------
// allFindings / hasActionableFindings
// ---------------------------------------------------------------------------

test("hasActionableFindings: true with a high finding, false when all low", () => {
  const round = (sev: string): ReviewRound => ({
    round_num: 1,
    results: [
      {
        agent: "claude",
        domain: "x",
        raw_output: "",
        model: "",
        findings: [f({ severity: sev })],
        error: null,
        duration_s: 1,
        api_key_fallback: false,
      },
    ],
  });
  assert.equal(hasActionableFindings(round("high")), true);
  assert.equal(hasActionableFindings(round("low")), false);
  assert.equal(allFindings(round("high")).length, 1);
});

// ---------------------------------------------------------------------------
// formatAgentReviewBody / formatSummaryTable
// ---------------------------------------------------------------------------

test("formatAgentReviewBody: clean review renders the no-issues line", () => {
  const rnd: ReviewRound = {
    round_num: 1,
    results: [
      {
        agent: "claude",
        domain: "behavior",
        raw_output: "",
        model: "",
        findings: [],
        error: null,
        duration_s: 1,
        api_key_fallback: false,
      },
    ],
  };
  const body = formatAgentReviewBody("claude", rnd);
  assert.match(body, /No issues found/);
});

test("formatSummaryTable: renders a markdown table with a TOTAL row", () => {
  const rnd: ReviewRound = {
    round_num: 1,
    results: [
      {
        agent: "claude",
        domain: "behavior",
        raw_output: "",
        model: "",
        findings: [f({ severity: "high" })],
        error: null,
        duration_s: 2.5,
        api_key_fallback: false,
      },
    ],
  };
  const table = formatSummaryTable([rnd]);
  assert.match(table, /\| Round \| Agent \| Domain \|/);
  assert.match(table, /\*\*TOTAL\*\*/);
});

// ---------------------------------------------------------------------------
// resolveBaseRef
// ---------------------------------------------------------------------------

test("resolveBaseRef: passes through qualified refs / keywords / expressions", () => {
  assert.equal(resolveBaseRef("origin/main"), "origin/main");
  assert.equal(resolveBaseRef("refs/heads/x"), "refs/heads/x");
  assert.equal(resolveBaseRef("HEAD"), "HEAD");
  assert.equal(resolveBaseRef("HEAD~3"), "HEAD~3");
  assert.equal(resolveBaseRef("main^"), "main^");
  assert.equal(resolveBaseRef(""), "");
});
