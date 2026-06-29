// Contract test for the doc-convention layout (PR #617): stark-init-docs'
// scaffolding + spec stub paths and the mkdocs nav template must use the
// docs/{adr, specs, plans, retros} layout — `adr` stays the established singular
// acronym (docs/adr/), the full-word types are plural. Guards against drift back
// to singular docs/spec|plan paths. node built-ins only — runs under `npm test`
// and the smoke harness.
import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

test("stark-init-docs scaffolds docs/{adr,specs,plans,retros}", () => {
  const s = read("skill/stark-init-docs/SKILL.md");
  assert.match(s, /docs\/\{adr,specs,plans,retros/, "mkdir line must use adr + plural specs/plans/retros");
  assert.doesNotMatch(s, /docs\/spec\//, "no singular docs/spec/ paths (use docs/specs/)");
  assert.doesNotMatch(s, /docs\/plan\//, "no singular docs/plan/ paths (use docs/plans/)");
});

test("mkdocs template nav uses adr/ + plural specs/plans/retros", () => {
  const m = read("standards/templates/mkdocs.yml");
  for (const p of ["adr/", "specs/", "plans/", "retros/"]) {
    assert.ok(m.includes(p), `mkdocs nav missing ${p}`);
  }
  assert.doesNotMatch(m, /:\s*spec\//, "no singular spec/ nav target (use specs/)");
  assert.doesNotMatch(m, /:\s*plan\//, "no singular plan/ nav target (use plans/)");
});

test("adr-template matches `brain adr` render (bullet Status/Date)", () => {
  const t = read("standards/templates/adr-template.md");
  assert.match(t, /^- \*\*Status:\*\*/m, "Status must be a `- **Status:**` bullet so `brain adr list` parses it");
  assert.match(t, /^- \*\*Date:\*\*/m, "Date must be a `- **Date:**` bullet");
});
