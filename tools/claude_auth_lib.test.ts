import test from "node:test";
import assert from "node:assert/strict";

import { applyClaudeAuth, resolveClaudeAuthMode } from "./claude_auth_lib.ts";

test("resolveClaudeAuthMode: always subscription", () => {
  assert.equal(resolveClaudeAuthMode({ STARK_CLAUDE_AUTH: "subscription" }), "subscription");
  assert.equal(resolveClaudeAuthMode({}), "subscription");
});

test("resolveClaudeAuthMode: legacy/invalid values are ignored, never throw", () => {
  // A stale `STARK_CLAUDE_AUTH=api` from an old shell must not resurrect
  // metered-API dispatch, and garbage must not blow up the caller.
  assert.equal(resolveClaudeAuthMode({ STARK_CLAUDE_AUTH: "api" }), "subscription");
  assert.equal(resolveClaudeAuthMode({ STARK_CLAUDE_AUTH: "banana" }), "subscription");
});

test("applyClaudeAuth: strips any pre-existing ANTHROPIC_API_KEY", () => {
  const env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: "sk-stale" };
  const mode = applyClaudeAuth(env, { source: { ANTHROPIC_AGENTS: "sk-fresh" } });
  assert.equal(mode, "subscription");
  assert.ok(!("ANTHROPIC_API_KEY" in env), "a stale key must never re-enable API billing");
});

test("applyClaudeAuth: never injects a key, even with ANTHROPIC_AGENTS set", () => {
  const env: Record<string, string | undefined> = {};
  applyClaudeAuth(env, {
    source: { STARK_CLAUDE_AUTH: "api", ANTHROPIC_AGENTS: "sk-agents", ANTHROPIC_API_KEY: "sk-host" },
  });
  assert.ok(!("ANTHROPIC_API_KEY" in env));
  assert.ok(!("ANTHROPIC_AGENTS" in env), "source var never forwarded");
});

test("applyClaudeAuth: no key anywhere → succeeds (OAuth dispatch), never throws", () => {
  const env: Record<string, string | undefined> = {};
  assert.equal(applyClaudeAuth(env, { source: {} }), "subscription");
  assert.ok(!("ANTHROPIC_API_KEY" in env));
});

test("applyClaudeAuth: scrubs an allowlisted ANTHROPIC_AGENTS already in the env", () => {
  const env: Record<string, string | undefined> = { ANTHROPIC_AGENTS: "sk-leaked" };
  applyClaudeAuth(env, { source: {} });
  assert.ok(!("ANTHROPIC_AGENTS" in env));
});
