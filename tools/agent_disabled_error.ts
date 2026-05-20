/**
 * Shared `AgentDisabledError` — raised when a dispatch helper is asked to
 * build a command for an agent that is disabled in config.
 *
 * The Python dispatch infra defined this separately in `codex_utils.py`,
 * `claude_utils.py`, and `gemini_utils.py`. The TS port consolidates it
 * into one class so `instanceof` checks work across all three utils.
 */

export class AgentDisabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentDisabledError";
  }
}
