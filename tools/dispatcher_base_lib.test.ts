// Tests for `tools/dispatcher_base_lib.ts` — the shared config / model /
// domain / prompt utilities ported from `scripts/dispatcher_base.py`.
// Ported alongside the code from scripts/test_dispatcher_base.py.

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_CONFIG,
  discoverConfig,
  discoverDomains,
  resolveModel,
  resolvePrompt,
} from "./dispatcher_base_lib.ts";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dispatcher-base-test-"));
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

// ---------------------------------------------------------------------------
// discoverConfig
// ---------------------------------------------------------------------------

test("discoverConfig: defaults returned when no config files present", () => {
  const dir = tmp();
  try {
    const result = discoverConfig(dir, path.join(dir, "global"));
    assert.deepEqual(result["agents"], DEFAULT_CONFIG["agents"]);
    assert.equal(result["fix_threshold"], DEFAULT_CONFIG["fix_threshold"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverConfig: global config merges on top of defaults", () => {
  const dir = tmp();
  try {
    const globalDir = path.join(dir, "global");
    write(
      path.join(globalDir, "config.json"),
      JSON.stringify({ fix_threshold: "high", extra_domains: ["custom"] }),
    );
    const result = discoverConfig(dir, globalDir);
    assert.equal(result["fix_threshold"], "high");
    assert.ok((result["extra_domains"] as string[]).includes("custom"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverConfig: repo config wins over global", () => {
  const dir = tmp();
  try {
    const globalDir = path.join(dir, "global");
    write(path.join(globalDir, "config.json"), JSON.stringify({ fix_threshold: "low" }));
    const repoDir = path.join(dir, "repo");
    write(
      path.join(repoDir, ".code-review", "config.json"),
      JSON.stringify({ fix_threshold: "critical" }),
    );
    const result = discoverConfig(repoDir, globalDir);
    assert.equal(result["fix_threshold"], "critical");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverConfig: additive field (extra_domains) unions without duplicates", () => {
  const dir = tmp();
  try {
    const globalDir = path.join(dir, "global");
    write(path.join(globalDir, "config.json"), JSON.stringify({ extra_domains: ["security"] }));
    const repoDir = path.join(dir, "repo");
    write(
      path.join(repoDir, ".code-review", "config.json"),
      JSON.stringify({ extra_domains: ["security", "perf"] }),
    );
    const result = discoverConfig(repoDir, globalDir);
    assert.deepEqual(
      new Set(result["extra_domains"] as string[]),
      new Set(["security", "perf"]),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverConfig: deep-merge field preserves unoverridden sibling keys", () => {
  const dir = tmp();
  try {
    const globalDir = path.join(dir, "global");
    write(
      path.join(globalDir, "config.json"),
      JSON.stringify({ github_apps: { gemini: "custom-gemini-app" } }),
    );
    const result = discoverConfig(dir, globalDir);
    const apps = result["github_apps"] as Record<string, string>;
    assert.equal(apps.gemini, "custom-gemini-app");
    assert.equal(apps.claude, "stark-claude");
    assert.equal(apps.codex, "stark-codex");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverConfig: malformed JSON layer is skipped, defaults kept", () => {
  const dir = tmp();
  try {
    const globalDir = path.join(dir, "global");
    write(path.join(globalDir, "config.json"), "{not valid json}");
    const result = discoverConfig(dir, globalDir);
    assert.equal(result["fix_threshold"], DEFAULT_CONFIG["fix_threshold"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverConfig: multi-layer chain — repo beats org beats global", () => {
  const dir = tmp();
  try {
    const globalDir = path.join(dir, "global");
    write(path.join(globalDir, "config.json"), JSON.stringify({ fix_threshold: "low" }));
    const orgDir = path.join(dir, "org");
    write(
      path.join(orgDir, ".code-review", "config.json"),
      JSON.stringify({ fix_threshold: "medium" }),
    );
    const repoDir = path.join(orgDir, "repo");
    write(
      path.join(repoDir, ".code-review", "config.json"),
      JSON.stringify({ fix_threshold: "high" }),
    );
    const result = discoverConfig(repoDir, globalDir);
    assert.equal(result["fix_threshold"], "high");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// resolveModel
// ---------------------------------------------------------------------------

test("resolveModel: each known agent resolves to a non-empty string", () => {
  for (const agent of ["claude", "codex", "gemini"]) {
    const result = resolveModel(agent);
    assert.ok(typeof result === "string" && result.length > 0);
  }
});

test("resolveModel: unknown agent throws", () => {
  assert.throws(() => resolveModel("unknown-agent"), /Unknown agent/);
});

test("resolveModel: a configured model_id overrides the default", () => {
  const home = tmp();
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    write(
      path.join(home, ".claude", "code-review", "config.json"),
      JSON.stringify({ models: { claude: { model_id: "my-custom-model" } } }),
    );
    assert.equal(resolveModel("claude"), "my-custom-model");
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// discoverDomains
// ---------------------------------------------------------------------------

test("discoverDomains: discovers numbered files from the first agent dir", () => {
  const dir = tmp();
  try {
    write(path.join(dir, "claude", "01-architecture.md"), "arch");
    write(path.join(dir, "claude", "02-security.md"), "sec");
    write(path.join(dir, "claude", "agent.md"), "preamble");
    const result = discoverDomains(dir, ["claude", "codex"]);
    assert.ok("architecture" in result);
    assert.ok("security" in result);
    assert.equal(result.architecture.order, "01");
    assert.equal(result.architecture.filename, "01-architecture.md");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverDomains: falls back to the shared domains/ dir", () => {
  const dir = tmp();
  try {
    write(path.join(dir, "claude", "agent.md"), "preamble");
    write(path.join(dir, "domains", "01-completeness.md"), "completeness");
    const result = discoverDomains(dir, ["claude"]);
    assert.ok("completeness" in result);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverDomains: empty prompts dir → empty result", () => {
  const dir = tmp();
  try {
    assert.deepEqual(discoverDomains(dir, ["claude", "codex"]), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverDomains: slug is the part after the first dash; label title-cased", () => {
  const dir = tmp();
  try {
    write(path.join(dir, "claude", "07-spec-conformance.md"), "spec");
    const result = discoverDomains(dir, ["claude"]);
    assert.ok("spec-conformance" in result);
    assert.equal(result["spec-conformance"].label, "Spec Conformance");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverDomains: defaults to claude→codex→gemini order", () => {
  const dir = tmp();
  try {
    write(path.join(dir, "codex", "01-arch.md"), "codex arch");
    const result = discoverDomains(dir);
    assert.ok("arch" in result);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverDomains: merges agent-specific + shared domains", () => {
  const dir = tmp();
  try {
    write(path.join(dir, "claude", "07-accessibility.md"), "a11y");
    write(path.join(dir, "claude", "08-test-plan.md"), "tests");
    write(path.join(dir, "claude", "agent.md"), "preamble");
    write(path.join(dir, "domains", "01-completeness.md"), "completeness");
    write(path.join(dir, "domains", "02-security.md"), "security");
    write(path.join(dir, "domains", "06-consistency.md"), "consistency");
    const result = discoverDomains(dir, ["claude"]);
    assert.ok("accessibility" in result && "test-plan" in result);
    assert.ok("completeness" in result && "security" in result && "consistency" in result);
    assert.equal(Object.keys(result).length, 5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverDomains: agent-specific file wins over shared on slug collision", () => {
  const dir = tmp();
  try {
    write(path.join(dir, "claude", "01-arch.md"), "claude-specific arch");
    write(path.join(dir, "domains", "01-arch.md"), "shared arch");
    const result = discoverDomains(dir, ["claude"]);
    assert.ok("arch" in result);
    assert.equal(Object.keys(result).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// resolvePrompt
// ---------------------------------------------------------------------------

test("resolvePrompt: returns the global agent prompt when no repo override", () => {
  const dir = tmp();
  try {
    const promptsDir = path.join(dir, "prompts");
    write(path.join(promptsDir, "claude", "agent.md"), "Global claude preamble");
    assert.equal(resolvePrompt("claude", "agent.md", promptsDir), "Global claude preamble");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolvePrompt: repo override beats global", () => {
  const dir = tmp();
  try {
    const promptsDir = path.join(dir, "prompts");
    write(path.join(promptsDir, "claude", "01-arch.md"), "Global arch");
    const repoDir = path.join(dir, "repo");
    write(
      path.join(repoDir, ".code-review", "prompts", "claude", "01-arch.md"),
      "Repo arch override",
    );
    assert.equal(
      resolvePrompt("claude", "01-arch.md", promptsDir, repoDir),
      "Repo arch override",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolvePrompt: falls back to shared domains/ when agent dir lacks the file", () => {
  const dir = tmp();
  try {
    const promptsDir = path.join(dir, "prompts");
    fs.mkdirSync(path.join(promptsDir, "claude"), { recursive: true });
    write(path.join(promptsDir, "domains", "01-arch.md"), "Shared arch prompt");
    assert.equal(resolvePrompt("claude", "01-arch.md", promptsDir), "Shared arch prompt");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolvePrompt: agent-specific file beats shared domains/", () => {
  const dir = tmp();
  try {
    const promptsDir = path.join(dir, "prompts");
    write(path.join(promptsDir, "claude", "01-arch.md"), "Agent arch");
    write(path.join(promptsDir, "domains", "01-arch.md"), "Shared arch");
    assert.equal(resolvePrompt("claude", "01-arch.md", promptsDir), "Agent arch");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolvePrompt: missing file anywhere → empty string", () => {
  const dir = tmp();
  try {
    assert.equal(resolvePrompt("claude", "99-nope.md", dir), "");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolvePrompt: custom repoSubdir controls the override path", () => {
  const dir = tmp();
  try {
    const promptsDir = path.join(dir, "prompts");
    write(path.join(promptsDir, "claude", "agent.md"), "Global preamble");
    const repoDir = path.join(dir, "repo");
    write(
      path.join(repoDir, ".code-review", "plan-prompts", "claude", "agent.md"),
      "Repo plan preamble",
    );
    assert.equal(
      resolvePrompt("claude", "agent.md", promptsDir, repoDir, "plan-prompts"),
      "Repo plan preamble",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolvePrompt: null repoDir skips the repo override step", () => {
  const dir = tmp();
  try {
    const promptsDir = path.join(dir, "prompts");
    write(path.join(promptsDir, "claude", "agent.md"), "Global preamble");
    assert.equal(resolvePrompt("claude", "agent.md", promptsDir, null), "Global preamble");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolvePrompt: returned prompt text is trimmed", () => {
  const dir = tmp();
  try {
    const promptsDir = path.join(dir, "prompts");
    write(path.join(promptsDir, "claude", "agent.md"), "  \n  Hello World  \n  ");
    assert.equal(resolvePrompt("claude", "agent.md", promptsDir), "Hello World");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
