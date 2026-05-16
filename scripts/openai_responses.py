"""OpenAI Responses API transport helpers used by preflight.

Extracted from the former `stark_red_team.py` so the red-team Python
dispatcher can be deleted (Phase 4 of the TS migration) while preflight
still has the constant + key resolver it depends on.

The live red-team dispatcher is now `tools/red_team_lib.ts`; this module
is read-only / preflight-only.
"""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path

# Models that route through the OpenAI Responses API (HTTP) instead of the
# codex CLI. The codex CLI in ChatGPT-auth mode rejects o3 and the *-pro
# tiers, but the org has Responses-API entitlement to the same models — this
# parallel transport is what restores the locked `red_team.model` (default
# `o3`) to working order without weakening the lock or changing codex auth.
RESPONSES_API_MODELS: frozenset[str] = frozenset({
    "o3",
    "o3-mini",
    "gpt-5.5-pro",
    "gpt-5.4-pro",
})


def resolve_openai_api_key(env: Mapping[str, str]) -> str | None:
    """Resolve an OpenAI API key from a mapping (typically os.environ).

    Resolution order:
      1. ``OPENAI_API_KEY`` if non-empty.
      2. ``OPENAI_API_KEY_FILE`` + ``OPENAI_API_KEY_LABEL``: read the file and
         return the value for the matching ``LABEL=value`` line.
      3. ``None`` if neither path yields a key.
    """
    direct = env.get("OPENAI_API_KEY")
    if direct:
        return direct
    file_path = env.get("OPENAI_API_KEY_FILE")
    label = env.get("OPENAI_API_KEY_LABEL")
    if not file_path or not label:
        return None
    try:
        text = Path(file_path).read_text(encoding="utf-8")
    except OSError:
        return None
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        if key.strip() == label:
            return value.strip()
    return None
