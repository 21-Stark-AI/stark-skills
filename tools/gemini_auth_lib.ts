/**
 * gemini_auth_lib.ts — single source of truth for how headless Gemini CLI
 * subprocesses authenticate. Sibling of `claude_auth_lib.ts`.
 *
 * Three modes:
 *   - "oauth" (default): ride the logged-in Google account's OAuth
 *     credentials (`oauth_creds.json`, copied into the isolated home by
 *     `setupGeminiHome`) with `selectedType: "oauth-personal"`. When the
 *     account carries a Gemini Code Assist seat, dispatches bill the seat —
 *     no per-token charge. Requires `GOOGLE_CLOUD_PROJECT` pointing at a
 *     Code-Assist-enabled project (resolved via `resolveVertexProject`,
 *     which already honors the ambient env var).
 *   - "vertex": legacy per-token Vertex AI billing (`selectedType:
 *     "vertex-ai"` + `GOOGLE_GENAI_USE_VERTEXAI` + ADC).
 *   - "api-key": Generative Language API key (`GEMINI_API_KEY`); also the
 *     automatic degrade path when the primary mode errors.
 *
 * Resolution precedence: `STARK_GEMINI_AUTH` env > `models.gemini.auth`
 * config > "oauth".
 */

import { getModelsConfig } from "./stark_config_lib.ts";

export type GeminiAuthMode = "oauth" | "vertex" | "api-key";

const MODE_ENV_VAR = "STARK_GEMINI_AUTH";

function isMode(v: unknown): v is GeminiAuthMode {
  return v === "oauth" || v === "vertex" || v === "api-key";
}

export function resolveGeminiAuthMode(
  source: NodeJS.ProcessEnv = process.env,
): GeminiAuthMode {
  const fromEnv = source[MODE_ENV_VAR];
  if (fromEnv !== undefined && fromEnv !== "") {
    if (isMode(fromEnv)) return fromEnv;
    process.stderr.write(
      `gemini_auth: warning: ${MODE_ENV_VAR}=${JSON.stringify(fromEnv)} is not ` +
        `"oauth" | "vertex" | "api-key"; ignoring\n`,
    );
  }
  let fromConfig: unknown;
  try {
    fromConfig = getModelsConfig()["gemini"]?.["auth"];
  } catch {
    fromConfig = undefined;
  }
  if (fromConfig !== undefined) {
    if (isMode(fromConfig)) return fromConfig;
    process.stderr.write(
      `gemini_auth: warning: models.gemini.auth=${JSON.stringify(fromConfig)} is not ` +
        `"oauth" | "vertex" | "api-key"; ignoring\n`,
    );
  }
  return "oauth";
}

/**
 * The `security.auth` settings block for the isolated home's settings.json,
 * per mode. Vertex mode carries the region/project block; oauth carries
 * only the type (creds come from the copied oauth files).
 */
export function geminiAuthSettings(
  mode: GeminiAuthMode,
  vertex: { projectId?: string; region: string },
): { selectedType: string; vertexAi?: Record<string, string> } {
  if (mode === "vertex") {
    const vertexAi: Record<string, string> = { region: vertex.region };
    if (vertex.projectId) vertexAi.projectId = vertex.projectId;
    return { selectedType: "vertex-ai", vertexAi };
  }
  if (mode === "api-key") return { selectedType: "gemini-api-key" };
  return { selectedType: "oauth-personal" };
}
