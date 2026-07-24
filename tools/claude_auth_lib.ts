/**
 * claude_auth_lib.ts — single source of truth for how headless `claude -p`
 * subprocesses authenticate.
 *
 * Two modes:
 *   - "subscription" (default): NO `ANTHROPIC_API_KEY` is injected. The
 *     Claude CLI falls back to the logged-in account's OAuth credentials
 *     (macOS Keychain / `~/.claude`), so dispatches bill the seat's
 *     subscription instead of the metered API. The subprocess env must
 *     carry `HOME` for the CLI to find those credentials — every dispatch
 *     site already allowlists it.
 *   - "api": legacy behavior — inject `ANTHROPIC_API_KEY` sourced from
 *     `ANTHROPIC_AGENTS` (the keychain-loaded source var; never forwarded
 *     under its own name) with `ANTHROPIC_API_KEY` itself as fallback.
 *
 * Resolution precedence: `STARK_CLAUDE_AUTH` env > `models.claude.auth`
 * config > "subscription".
 */

import { getModelsConfig } from "./stark_config_lib.ts";

export type ClaudeAuthMode = "subscription" | "api";

const MODE_ENV_VAR = "STARK_CLAUDE_AUTH";

function isMode(v: unknown): v is ClaudeAuthMode {
  return v === "subscription" || v === "api";
}

/**
 * Resolve the active auth mode. Invalid values warn to stderr and fall
 * through to the next tier.
 */
export function resolveClaudeAuthMode(
  source: NodeJS.ProcessEnv = process.env,
): ClaudeAuthMode {
  const fromEnv = source[MODE_ENV_VAR];
  if (fromEnv !== undefined && fromEnv !== "") {
    if (isMode(fromEnv)) return fromEnv;
    process.stderr.write(
      `claude_auth: warning: ${MODE_ENV_VAR}=${JSON.stringify(fromEnv)} is not ` +
        `"subscription" | "api"; ignoring\n`,
    );
  }
  let fromConfig: unknown;
  try {
    fromConfig = getModelsConfig()["claude"]?.["auth"];
  } catch {
    fromConfig = undefined;
  }
  if (fromConfig !== undefined) {
    if (isMode(fromConfig)) return fromConfig;
    process.stderr.write(
      `claude_auth: warning: models.claude.auth=${JSON.stringify(fromConfig)} is not ` +
        `"subscription" | "api"; ignoring\n`,
    );
  }
  return "subscription";
}

/**
 * Apply the resolved auth mode to a subprocess env being assembled.
 *
 * - subscription: guarantees `ANTHROPIC_API_KEY` is ABSENT (a stale
 *   allowlisted value would silently re-enable API billing).
 * - api: injects the key from `ANTHROPIC_AGENTS` (fallback: the host's own
 *   `ANTHROPIC_API_KEY`). With `require: true`, a missing key throws the
 *   site-standard sourcing error; otherwise it is silently skipped and the
 *   CLI degrades to whatever credentials `HOME` provides.
 *
 * Never forwards `ANTHROPIC_AGENTS` under its own name.
 */
export function applyClaudeAuth(
  env: Record<string, string | undefined>,
  opts: { source?: NodeJS.ProcessEnv; require?: boolean; mode?: ClaudeAuthMode } = {},
): ClaudeAuthMode {
  const source = opts.source ?? process.env;
  const mode = opts.mode ?? resolveClaudeAuthMode(source);
  if (mode === "subscription") {
    delete env["ANTHROPIC_API_KEY"];
    return mode;
  }
  const apiKey = source.ANTHROPIC_AGENTS ?? source.ANTHROPIC_API_KEY;
  if (typeof apiKey === "string" && apiKey.length > 0) {
    env["ANTHROPIC_API_KEY"] = apiKey;
  } else if (opts.require) {
    throw new Error(
      "ANTHROPIC_AGENTS not set in environment (models.claude.auth is \"api\"). " +
        'Source your Anthropic key file (e.g. `source "$HOME/Code/.private/API Keys/.anthropic.key"`) ' +
        'before dispatching claude, or switch to auth: "subscription".',
    );
  }
  return mode;
}
