import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  SECTION_IDS,
  computeDone,
  extractContractVerdictJson,
  normalizeContractVerdict,
} from "./write_spec_lib.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT_MD = path.join(
  here,
  "..",
  "global",
  "prompts",
  "write-spec",
  "contract.md",
);

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
