import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CONTRACT_HEADER,
  NO_TOOLS,
  SECTION_IDS,
  buildLeadCmd,
  buildWingCmd,
  composePrompt,
  computeDone,
  deriveSlugFromOut,
  extractContractVerdictJson,
  loadContractText,
  normalizeContractVerdict,
  parseClaudeJson,
} from "./write_spec_lib.ts";
import { DECIDER_DISALLOWED_TOOLS } from "./red_team_fold_lib.ts";
import { assetPromptsDir } from "./asset_root_lib.ts";

// Route the drift check through the real asset resolver (the runtime seam),
// NOT a hardcoded source-relative path, so it validates the same contract.md
// that the flat vendored plugin layout resolves.
const CONTRACT_MD = path.join(assetPromptsDir(), "write-spec", "contract.md");

function fenced(obj: unknown): string {
  return "some preamble\n\n```json\n" + JSON.stringify(obj, null, 2) + "\n```\n";
}

// test_contract_verdict_extracted
test("test_contract_verdict_extracted", () => {
  const contract = {
    items: [{ section: "intent", status: "satisfied", note: "ok" }],
    done: false,
    summary: "wip",
  };
  const text = fenced(contract);
  const got = extractContractVerdictJson(text);
  assert.ok(got, "expected a contract verdict object");
  assert.deepEqual(got!["items"], contract.items);
  assert.equal(got!["done"], false);
  assert.equal("verdict" in got!, false);

  // A copilot-shaped {verdict: approve} control must NOT be grabbed.
  const control = extractContractVerdictJson(fenced({ verdict: "approve" }));
  assert.equal(control, null);
});

// test_parser_drops_unknown_sections
test("test_parser_drops_unknown_sections", () => {
  const items = [
    ...SECTION_IDS.map((section) => ({ section, status: "satisfied", note: "x" })),
    { section: "totally-new-tenth", status: "satisfied", note: "sneaky" },
  ];
  const { verdict, droppedSections } = normalizeContractVerdict({
    items,
    done: true,
    summary: "s",
  });
  assert.deepEqual(droppedSections, ["totally-new-tenth"]);
  assert.equal(verdict.items.length, SECTION_IDS.length);
  assert.deepEqual(
    verdict.items.map((i) => i.section),
    [...SECTION_IDS],
  );
  // done computed from the 9 known sections, all satisfied.
  assert.equal(verdict.done, true);
});

// test_status_enum_rejects_unknown
test("test_status_enum_rejects_unknown", () => {
  const { verdict } = normalizeContractVerdict({
    items: [{ section: "intent", status: "brilliant", note: "n" }],
    done: true,
    summary: "",
  });
  const intent = verdict.items.find((i) => i.section === "intent")!;
  assert.equal(intent.status, "underspecified");
  // Unknown status coerced to a blocking status → done is false.
  assert.equal(verdict.done, false);
});

// over_scoped is a valid status: it survives normalization (not coerced to
// underspecified) and blocks done just like missing/underspecified.
test("test_over_scoped_status_survives_and_blocks_done", () => {
  const { verdict } = normalizeContractVerdict({
    items: SECTION_IDS.map((section, i) => ({
      section,
      status: i === 0 ? "over_scoped" : "satisfied",
      note: i === 0 ? "cut the extra auth machinery" : "x",
    })),
    done: true, // wing lies
    summary: "",
  });
  const intent = verdict.items.find((i) => i.section === "intent")!;
  assert.equal(intent.status, "over_scoped");
  // over_scoped does not count toward done.
  assert.equal(verdict.done, false);
});

// extractContractVerdictJson returns the LAST contract-shaped candidate in
// DOCUMENT order: an earlier inline object must lose to a later fenced one.
test("test_last_candidate_precedence", () => {
  const early = { items: [{ section: "intent", status: "underspecified", note: "draft" }], done: false, summary: "draft" };
  const late = { items: [{ section: "intent", status: "satisfied", note: "final" }], done: true, summary: "final" };
  const text =
    "first pass: " + JSON.stringify(early) +
    "\n\ncorrected:\n\n```json\n" + JSON.stringify(late, null, 2) + "\n```\n";
  const got = extractContractVerdictJson(text);
  assert.ok(got, "expected a contract verdict object");
  assert.equal(got!["summary"], "final");
  assert.deepEqual(got!["items"], late.items);
});

// test_done_recomputed_from_items
test("test_done_recomputed_from_items", () => {
  // Wing lies: claims done:true but a section is missing/underspecified.
  const items = SECTION_IDS.map((section, i) => ({
    section,
    status: i === 0 ? "underspecified" : "satisfied",
    note: "x",
  }));
  const { verdict } = normalizeContractVerdict({
    items,
    done: true, // never trusted
    summary: "",
  });
  assert.equal(verdict.done, false);

  // Flip that section to satisfied → done recomputes true.
  const allGood = normalizeContractVerdict({
    items: SECTION_IDS.map((section) => ({ section, status: "satisfied", note: "x" })),
    done: false, // wing under-reports; host still computes true
    summary: "",
  });
  assert.equal(allGood.verdict.done, true);

  // Reasoned n_a counts as satisfied; reason-less n_a is downgraded → blocks.
  const reasonedNa = computeDone(
    SECTION_IDS.map((section) => ({ section, status: "n_a" as const, note: "not relevant" })),
  );
  assert.equal(reasonedNa, true);
});

// test_partial_verdict_fails_closed
test("test_partial_verdict_fails_closed", () => {
  // Only one section reported; the other 8 are synthesized as `missing`.
  const { verdict } = normalizeContractVerdict({
    items: [{ section: "intent", status: "satisfied", note: "ok" }],
    done: true,
    summary: "partial",
  });
  assert.equal(verdict.items.length, SECTION_IDS.length);
  const missing = verdict.items.filter((i) => i.status === "missing");
  assert.equal(missing.length, SECTION_IDS.length - 1);
  assert.equal(verdict.done, false);

  // Reason-less n_a is downgraded to underspecified and blocks.
  const naNoReason = normalizeContractVerdict({
    items: SECTION_IDS.map((section) => ({ section, status: "n_a", note: "" })),
    done: true,
    summary: "",
  });
  assert.ok(naNoReason.verdict.items.every((i) => i.status === "underspecified"));
  assert.equal(naNoReason.verdict.done, false);
});

// Duplicate sections: first occurrence of a known section wins; a later
// contradictory duplicate cannot flip the recorded status nor fabricate a
// false done. Each SECTION_ID is counted once by computeDone.
test("test_duplicate_section_first_occurrence_wins", () => {
  // intent appears twice: satisfied then missing. First wins → intent stays
  // satisfied, but the other 8 sections are absent → done still false.
  const { verdict } = normalizeContractVerdict({
    items: [
      { section: "intent", status: "satisfied", note: "ok" },
      { section: "intent", status: "missing", note: "no" },
    ],
    done: true,
    summary: "",
  });
  const intents = verdict.items.filter((i) => i.section === "intent");
  assert.equal(intents.length, 1, "intent counted exactly once");
  assert.equal(intents[0]!.status, "satisfied");
  assert.equal(verdict.done, false);

  // All 9 satisfied, then a trailing missing duplicate of one → cannot flip
  // the completed verdict to false (first-occurrence-wins), and cannot inflate
  // beyond 9 items.
  const dupAllGood = normalizeContractVerdict({
    items: [
      ...SECTION_IDS.map((section) => ({ section, status: "satisfied", note: "x" })),
      { section: "intent", status: "missing", note: "late flip attempt" },
    ],
    done: false,
    summary: "",
  });
  assert.equal(dupAllGood.verdict.items.length, SECTION_IDS.length);
  assert.equal(dupAllGood.verdict.done, true);
});

// Reasoned n_a exercised THROUGH normalizeContractVerdict (not computeDone
// directly): a reasoned n_a survives normalization and counts toward done.
test("test_reasoned_na_through_normalization", () => {
  const { verdict } = normalizeContractVerdict({
    items: SECTION_IDS.map((section) => ({
      section,
      status: "n_a",
      note: "not relevant to this spec",
    })),
    done: false,
    summary: "",
  });
  assert.ok(
    verdict.items.every((i) => i.status === "n_a"),
    "reasoned n_a not downgraded",
  );
  assert.equal(verdict.done, true);
});

// test_prompts_reference_canonical_ids — every write-spec generate/verify/revise
// prompt (claude AND codex) must mention each SECTION_IDS id at least once, so a
// drifted canonical id fails the prompt set, not just the parser.
test("test_prompts_reference_canonical_ids", () => {
  // Resolve from the source repo (tools/ -> ../global/prompts), not the
  // published asset dir — these prompts may be branch-new and not yet vendored.
  const promptsDir = path.join(import.meta.dirname, "..", "global", "prompts", "write-spec");
  const agents = ["claude", "codex"];
  const roles = ["generate", "verify", "revise"];
  for (const agent of agents) {
    for (const role of roles) {
      const file = path.join(promptsDir, agent, `${role}.md`);
      const text = readFileSync(file, "utf8");
      for (const id of SECTION_IDS) {
        assert.ok(
          text.includes(id),
          `${agent}/${role}.md is missing canonical id "${id}"`,
        );
      }
    }
  }
});

// ── Dispatch primitives (#699) ───────────────────────────────────────────

// test_derive_slug_from_out
test("test_derive_slug_from_out", () => {
  // canonical path -> slug
  assert.equal(
    deriveSlugFromOut("docs/specs/2026-07-18-write-spec-dispatch-spec.md"),
    "write-spec-dispatch",
  );
  // multi-word slug round-trips (bare basename too)
  assert.equal(
    deriveSlugFromOut("2026-01-02-a-b-c-spec.md"),
    "a-b-c",
  );
  // non-conforming path throws the documented error
  assert.throws(
    () => deriveSlugFromOut("docs/specs/not-a-spec.md"),
    /out path must match docs\/specs\/YYYY-MM-DD-<slug>-spec\.md; got not-a-spec\.md/,
  );
  // no --slug escape hatch: a path missing the -spec.md suffix throws.
  assert.throws(
    () => deriveSlugFromOut("2026-07-18-write-spec-dispatch.md"),
    /out path must match/,
  );
});

// test_agent_commands_expose_no_tools
test("test_agent_commands_expose_no_tools", () => {
  // NO_TOOLS is the fold decider's disallowed set, verbatim.
  assert.deepEqual([...NO_TOOLS], [...DECIDER_DISALLOWED_TOOLS]);

  for (const build of [buildLeadCmd, buildWingCmd]) {
    // claude builder: no-tools, empty allowedTools (never grantable).
    const claude = build("claude");
    assert.equal(claude.cmd, "claude");
    const di = claude.args.indexOf("--disallowedTools");
    assert.ok(di >= 0, "claude cmd carries --disallowedTools");
    assert.deepEqual(claude.args.slice(di + 1, di + 1 + NO_TOOLS.length), [...NO_TOOLS]);
    // Nothing grantable: no --allowedTools flag, and no tool name is granted.
    assert.equal(claude.args.includes("--allowedTools"), false);
    for (const t of ["Read", "Glob", "Grep", "Bash", "Write"]) {
      assert.equal(
        claude.args.includes(`--allowedTools`) && claude.args.includes(t) &&
          claude.args.indexOf(t) < di,
        false,
        `${t} must not be grantable`,
      );
    }
    assert.equal(claude.args.includes("--output-format"), true);
    assert.equal(claude.args[claude.args.indexOf("--output-format") + 1], "json");

    // codex builder: read-only.
    const codex = build("codex");
    assert.equal(codex.cmd, "codex");
    assert.equal(codex.args.includes("exec"), true);
    const si = codex.args.indexOf("-s");
    assert.ok(si >= 0 && codex.args[si + 1] === "read-only", "codex cmd is -s read-only");
  }

  // wing codex gets the higher xhigh reasoning effort; lead codex is high.
  assert.ok(buildWingCmd("codex").args.some((a) => a.includes('model_reasoning_effort="xhigh"')));
  assert.ok(buildLeadCmd("codex").args.some((a) => a.includes('model_reasoning_effort="high"')));
});

// test_parse_claude_json_envelope
test("test_parse_claude_json_envelope", () => {
  const canned = JSON.stringify({
    type: "result",
    result: "the spec text",
    usage: { input_tokens: 12, output_tokens: 34 },
  });
  const got = parseClaudeJson(canned);
  assert.equal(got.text, "the spec text");
  assert.deepEqual(got.usage, { input_tokens: 12, output_tokens: 34 });

  // Missing usage / result → empty text, null usage.
  const bare = parseClaudeJson(JSON.stringify({ type: "result" }));
  assert.equal(bare.text, "");
  assert.equal(bare.usage, null);

  // Non-JSON stdout → raw passthrough, null usage.
  const raw = parseClaudeJson("not json at all");
  assert.equal(raw.text, "not json at all");
  assert.equal(raw.usage, null);
});

// test_contract_text_reaches_agents
test("test_contract_text_reaches_agents", () => {
  const SENTINEL = "SENTINEL-CONTRACT-LINE-42";
  const contract = `## intent — bar\n${SENTINEL}\n`;
  // A generate, a verify, and a revise template each carry the sentinel.
  for (const tmpl of ["GENERATE template", "VERIFY template", "REVISE template"]) {
    const out = composePrompt(tmpl, contract, "the brief");
    assert.ok(out.includes(SENTINEL), `${tmpl} output carries contract sentinel`);
    assert.ok(out.includes(CONTRACT_HEADER), "contract header present");
    assert.ok(out.includes(tmpl), "per-agent template present");
    assert.ok(out.includes("the brief"), "brief present");
    // composePrompt is pure — contract precedes template precedes brief.
    assert.ok(out.indexOf(SENTINEL) < out.indexOf(tmpl));
    assert.ok(out.indexOf(tmpl) < out.indexOf("the brief"));
  }

  // loadContractText reads the real asset once and returns non-empty text.
  const loaded = loadContractText();
  assert.ok(loaded.trim().length > 0, "contract.md is non-empty");

  // Missing/empty contract → throws (fail-closed). Point the asset resolver
  // at an empty temp tree.
  const prevAssetRoot = process.env.STARK_ASSET_ROOT;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "write-spec-contract-"));
  try {
    process.env.STARK_ASSET_ROOT = tmp;
    assert.throws(() => loadContractText(), /spec contract not found|is empty/);
  } finally {
    if (prevAssetRoot === undefined) delete process.env.STARK_ASSET_ROOT;
    else process.env.STARK_ASSET_ROOT = prevAssetRoot;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// test_contract_ids_match_asset
test("test_contract_ids_match_asset", () => {
  const md = readFileSync(CONTRACT_MD, "utf8");
  const ids: string[] = [];
  for (const m of md.matchAll(/^## ([a-z-]+) —/gm)) {
    if (m[1]) ids.push(m[1]);
  }
  assert.deepEqual(
    ids,
    [...SECTION_IDS],
    "contract.md section headers drifted from SECTION_IDS",
  );
});
