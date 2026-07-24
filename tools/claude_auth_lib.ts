/**
 * claude_auth_lib.ts — single source of truth for how headless `claude -p`
 * subprocesses authenticate.
 *
 * One mode: subscription. NO `ANTHROPIC_API_KEY` is ever injected. The Claude
 * CLI falls back to the logged-in account's OAuth credentials (macOS Keychain
 * / `~/.claude`), so dispatches bill the seat's subscription. The subprocess
 * env must carry `HOME` for the CLI to find those credentials — every dispatch
 * site already allowlists it.
 *
 * The metered-API mode is gone (2026-07-24). It was a standing footgun: a
 * revoked `ANTHROPIC_AGENTS` key surfaced only as a generic `cli_error` after
 * ~370s with no 401 anywhere in the subprocess output, and a *missing* one
 * hard-failed dispatch even though the CLI itself authenticates fine on OAuth.
 * `STARK_CLAUDE_AUTH` and `models.claude.auth` are accepted-and-ignored so old
 * configs don't break; anything other than "subscription" warns.
 */

import { getModelsConfig } from "./stark_config_lib.ts";

export type ClaudeAuthMode = "subscription";

const MODE_ENV_VAR = "STARK_CLAUDE_AUTH";

function warnIgnored(label: string, v: unknown): void {
  process.stderr.write(
    `claude_auth: warning: ${label}=${JSON.stringify(v)} ignored — headless claude ` +
      `dispatch is subscription-only (the metered-API mode was removed)\n`,
  );
}

/**
 * Always "subscription". A non-"subscription" `STARK_CLAUDE_AUTH` or
 * `models.claude.auth` warns to stderr and is otherwise ignored.
 */
export function resolveClaudeAuthMode(
  source: NodeJS.ProcessEnv = process.env,
): ClaudeAuthMode {
  const fromEnv = source[MODE_ENV_VAR];
  if (fromEnv !== undefined && fromEnv !== "" && fromEnv !== "subscription") {
    warnIgnored(MODE_ENV_VAR, fromEnv);
  }
  let fromConfig: unknown;
  try {
    fromConfig = getModelsConfig()["claude"]?.["auth"];
  } catch {
    fromConfig = undefined;
  }
  if (fromConfig !== undefined && fromConfig !== "subscription") {
    warnIgnored("models.claude.auth", fromConfig);
  }
  return "subscription";
}

/**
 * Apply the auth mode to a subprocess env being assembled: guarantee
 * `ANTHROPIC_API_KEY` is ABSENT, so a stale allowlisted value can never
 * silently re-enable API billing. `ANTHROPIC_AGENTS` is never forwarded.
 */
export function applyClaudeAuth(
  env: Record<string, string | undefined>,
  opts: { source?: NodeJS.ProcessEnv } = {},
): ClaudeAuthMode {
  const mode = resolveClaudeAuthMode(opts.source ?? process.env);
  delete env["ANTHROPIC_API_KEY"];
  delete env["ANTHROPIC_AGENTS"];
  return mode;
}
