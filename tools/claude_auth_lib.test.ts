import test from "node:test";
import assert from "node:assert/strict";

import { applyClaudeAuth, resolveClaudeAuthMode } from "./claude_auth_lib.ts";

test("resolveClaudeAuthMode: env var wins", () => {
  assert.equal(resolveClaudeAuthMode({ STARK_CLAUDE_AUTH: "api" }), "api");
  assert.equal(resolveClaudeAuthMode({ STARK_CLAUDE_AUTH: "subscription" }), "subscription");
});

test("resolveClaudeAuthMode: invalid env value falls through (never throws)", () => {
  // Config layer may return anything; the invalid env value must not win.
  const mode = resolveClaudeAuthMode({ STARK_CLAUDE_AUTH: "banana" });
  assert.ok(mode === "subscription" || mode === "api");
});

test("applyClaudeAuth: subscription strips any pre-existing key", () => {
  const env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: "sk-stale" };
  const mode = applyClaudeAuth(env, {
    mode: "subscription",
    source: { ANTHROPIC_AGENTS: "sk-fresh" },
  });
  assert.equal(mode, "subscription");
  assert.ok(!("ANTHROPIC_API_KEY" in env));
});

test("applyClaudeAuth: api injects from ANTHROPIC_AGENTS, prefers it over host key", () => {
  const env: Record<string, string | undefined> = {};
  applyClaudeAuth(env, {
    mode: "api",
    source: { ANTHROPIC_AGENTS: "sk-agents", ANTHROPIC_API_KEY: "sk-host" },
  });
  assert.equal(env.ANTHROPIC_API_KEY, "sk-agents");
  assert.ok(!("ANTHROPIC_AGENTS" in env), "source var never forwarded");
});

test("applyClaudeAuth: api falls back to host ANTHROPIC_API_KEY", () => {
  const env: Record<string, string | undefined> = {};
  applyClaudeAuth(env, { mode: "api", source: { ANTHROPIC_API_KEY: "sk-host" } });
  assert.equal(env.ANTHROPIC_API_KEY, "sk-host");
});

test("applyClaudeAuth: api + require + no key → throws sourcing error", () => {
  assert.throws(
    () => applyClaudeAuth({}, { mode: "api", source: {}, require: true }),
    /ANTHROPIC_AGENTS not set/,
  );
});

test("applyClaudeAuth: api + no require + no key → silent skip", () => {
  const env: Record<string, string | undefined> = {};
  applyClaudeAuth(env, { mode: "api", source: {} });
  assert.ok(!("ANTHROPIC_API_KEY" in env));
});

test("applyClaudeAuth: mode resolved from source env when not pinned", () => {
  const env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: "sk-stale" };
  const mode = applyClaudeAuth(env, {
    source: { STARK_CLAUDE_AUTH: "subscription", ANTHROPIC_AGENTS: "sk-x" },
  });
  assert.equal(mode, "subscription");
  assert.ok(!("ANTHROPIC_API_KEY" in env));
});
