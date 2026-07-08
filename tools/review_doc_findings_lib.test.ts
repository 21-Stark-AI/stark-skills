import { test, describe } from "node:test";
import * as assert from "node:assert/strict";

import {
  anchorLine,
  collectFindings,
  findingMarker,
  openFindings,
  parseFindingMarker,
  type Receipt,
  renderAutofixReply,
  renderFindingComment,
  renderManualFixReply,
  type ReceiptFinding,
} from "./review_doc_findings_lib.ts";

function mkFinding(over: Partial<ReceiptFinding> & { id: string }): ReceiptFinding {
  return {
    agent: "codex",
    domain: "security",
    severity: "high",
    section: "Auth",
    title: "missing rate limit",
    description: "no throttle on login",
    suggestion: "add a limiter",
    ...over,
  };
}

// ─── collectFindings ─────────────────────────────────────────────────────

describe("collectFindings", () => {
  test("autofixed: applied in a round and absent from the final review", () => {
    const receipt: Receipt = {
      rounds: [
        {
          round: 1,
          kind: "review-fix",
          findings: [mkFinding({ id: "a", classification: "fix" })],
          fix: { applied_finding_ids: ["a"], skipped_finding_ids: [], patch_failures: [] },
        },
        { round: 2, kind: "final-review", findings: [] },
      ],
      unresolved: [],
    };
    const out = collectFindings(receipt);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.status, "autofixed");
    assert.equal(out[0]!.resolved_by_wing, true);
    assert.equal(openFindings(out).length, 0);
  });

  test("unresolved wins even when a prior round marked it applied", () => {
    const receipt: Receipt = {
      rounds: [
        {
          round: 1,
          kind: "review-fix",
          findings: [mkFinding({ id: "a", classification: "fix" })],
          fix: { applied_finding_ids: ["a"], skipped_finding_ids: [], patch_failures: [] },
        },
        {
          round: 2,
          kind: "final-review",
          findings: [mkFinding({ id: "a", classification: "fix" })],
        },
      ],
      unresolved: [mkFinding({ id: "a", classification: "fix" })],
    };
    const out = collectFindings(receipt);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.status, "unresolved");
    assert.equal(out[0]!.resolved_by_wing, false);
  });

  test("skipped and patch_failed are surfaced as open", () => {
    const receipt: Receipt = {
      rounds: [
        {
          round: 1,
          kind: "review-fix",
          findings: [
            mkFinding({ id: "skip", classification: "fix" }),
            mkFinding({ id: "fail", classification: "fix" }),
          ],
          fix: {
            applied_finding_ids: [],
            skipped_finding_ids: ["skip"],
            patch_failures: [{ finding_id: "fail" }],
          },
        },
        { round: 2, kind: "final-review", findings: [] },
      ],
    };
    const out = collectFindings(receipt);
    const byId = Object.fromEntries(out.map((f) => [f.id, f.status]));
    assert.equal(byId["fail"], "patch_failed");
    assert.equal(byId["skip"], "skipped");
    assert.equal(openFindings(out).length, 2);
  });

  test("below-threshold (noise/ignored) findings are still collected as open", () => {
    const receipt: Receipt = {
      rounds: [
        {
          round: 1,
          kind: "review-fix",
          findings: [mkFinding({ id: "n", severity: "low", classification: "ignored" })],
          fix: { applied_finding_ids: [], skipped_finding_ids: [], patch_failures: [] },
        },
      ],
    };
    const out = collectFindings(receipt);
    assert.equal(out[0]!.status, "below_threshold");
    assert.equal(openFindings(out).length, 1);
  });

  test("dedupes the same finding id across rounds", () => {
    const receipt: Receipt = {
      rounds: [
        { round: 1, kind: "review-fix", findings: [mkFinding({ id: "a" })], fix: { applied_finding_ids: ["a"] } },
        { round: 2, kind: "final-review", findings: [mkFinding({ id: "a", classification: "fix" })] },
      ],
      unresolved: [mkFinding({ id: "a", classification: "fix" })],
    };
    const out = collectFindings(receipt);
    assert.equal(out.length, 1);
  });
});

// ─── anchorLine ────────────────────────────────────────────────────────────

describe("anchorLine", () => {
  const doc = ["# Title", "", "intro text", "", "## Auth", "", "some Auth detail here"].join("\n");

  test("matches an exact heading (1-based)", () => {
    assert.equal(anchorLine(doc, "Auth"), 5);
  });
  test("matches a section given with its # prefix", () => {
    assert.equal(anchorLine(doc, "## Auth"), 5);
  });
  test("falls back to a line containing the text", () => {
    assert.equal(anchorLine(doc, "intro text"), 3);
  });
  test("returns null when nothing matches", () => {
    assert.equal(anchorLine(doc, "Nonexistent"), null);
  });
});

// ─── markers + rendering ─────────────────────────────────────────────────

describe("markers and rendering", () => {
  test("marker round-trips", () => {
    const body = `some comment\n${findingMarker("dom:codex:sec:title")}`;
    assert.equal(parseFindingMarker(body), "dom:codex:sec:title");
  });
  test("no marker → null", () => {
    assert.equal(parseFindingMarker("plain comment"), null);
  });
  test("finding comment embeds the marker and title", () => {
    const [f] = collectFindings({
      rounds: [{ round: 1, kind: "review-fix", findings: [mkFinding({ id: "x" })] }],
    });
    const body = renderFindingComment(f!, { line: 12 });
    assert.match(body, /missing rate limit/);
    assert.match(body, /near line 12/);
    assert.equal(parseFindingMarker(body), "x");
  });
  test("reply renderers include the short sha", () => {
    assert.match(renderAutofixReply("abcdef1234567890"), /abcdef12/);
    assert.match(renderManualFixReply({ summary: "added limiter", commitSha: "abcdef1234567890" }), /abcdef12/);
    assert.match(renderManualFixReply({ summary: "added limiter" }), /added limiter/);
  });
});
