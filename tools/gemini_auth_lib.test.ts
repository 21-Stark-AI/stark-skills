import test from "node:test";
import assert from "node:assert/strict";

import { geminiAuthSettings, resolveGeminiAuthMode } from "./gemini_auth_lib.ts";

test("resolveGeminiAuthMode: env var wins", () => {
  assert.equal(resolveGeminiAuthMode({ STARK_GEMINI_AUTH: "vertex" }), "vertex");
  assert.equal(resolveGeminiAuthMode({ STARK_GEMINI_AUTH: "oauth" }), "oauth");
  assert.equal(resolveGeminiAuthMode({ STARK_GEMINI_AUTH: "api-key" }), "api-key");
});

test("resolveGeminiAuthMode: invalid env value falls through (never throws)", () => {
  const mode = resolveGeminiAuthMode({ STARK_GEMINI_AUTH: "banana" });
  assert.ok(["oauth", "vertex", "api-key"].includes(mode));
});

test("geminiAuthSettings: oauth → oauth-personal, no vertexAi block", () => {
  const s = geminiAuthSettings("oauth", { projectId: "p1", region: "global" });
  assert.equal(s.selectedType, "oauth-personal");
  assert.equal(s.vertexAi, undefined);
});

test("geminiAuthSettings: vertex → vertex-ai with project + region", () => {
  const s = geminiAuthSettings("vertex", { projectId: "p1", region: "global" });
  assert.equal(s.selectedType, "vertex-ai");
  assert.deepEqual(s.vertexAi, { region: "global", projectId: "p1" });
});

test("geminiAuthSettings: vertex without project omits projectId", () => {
  const s = geminiAuthSettings("vertex", { region: "global" });
  assert.deepEqual(s.vertexAi, { region: "global" });
});

test("geminiAuthSettings: api-key → gemini-api-key", () => {
  const s = geminiAuthSettings("api-key", { region: "global" });
  assert.equal(s.selectedType, "gemini-api-key");
  assert.equal(s.vertexAi, undefined);
});
