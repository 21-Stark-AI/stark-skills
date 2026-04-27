#!/usr/bin/env python3
from __future__ import annotations

from unittest.mock import patch

import preflight


def _patch_models_and_dispatch(models: dict, agents: list[str] | None):
    """Helper: stub both knobs preflight reads (models config + dispatch rotation)."""
    cfg = {"agents": agents} if agents is not None else {}
    return (
        patch("preflight.get_models_config", return_value=models),
        patch("dispatcher_base.discover_config", return_value=cfg),
    )


def test_check_model_resolution_passes_when_dispatch_matches_enabled() -> None:
    models = {
        "claude": {"enabled": True, "model_id": "claude-opus-4-7"},
        "codex": {"enabled": True, "model_id": "gpt-5.4"},
        "gemini": {"enabled": False, "model_id": "gemini-2.5-pro"},
    }
    p1, p2 = _patch_models_and_dispatch(models, ["claude", "codex"])
    with p1, p2:
        status, message = preflight.check_model_resolution()
    assert status == "pass"
    assert "dispatched agents: ['claude', 'codex']" in message
    # Disabled gemini should be reported but not as a misalignment warning.
    assert "disabled in models: ['gemini']" in message


def test_check_model_resolution_warns_when_enabled_agent_excluded_from_rotation() -> None:
    """Regression: gemini was reported as enabled but ``config.agents``
    excluded it, so team review produced 0 gemini runs while preflight
    advertised gemini as ready. Misalignment must surface as 'warn'."""
    models = {
        "claude": {"enabled": True, "model_id": "claude-opus-4-7"},
        "codex": {"enabled": True, "model_id": "gpt-5.4"},
        "gemini": {"enabled": True, "model_id": "gemini-3.1-pro-preview"},
    }
    p1, p2 = _patch_models_and_dispatch(models, ["claude", "codex"])
    with p1, p2:
        status, message = preflight.check_model_resolution()
    assert status == "warn"
    assert "dispatched agents: ['claude', 'codex']" in message
    assert "enabled but excluded from config.agents (silently skipped): ['gemini']" in message


def test_check_model_resolution_warns_when_rotation_lists_disabled_agent() -> None:
    models = {
        "claude": {"enabled": True, "model_id": "claude-opus-4-7"},
        "codex": {"enabled": False, "model_id": "gpt-5.4"},
    }
    p1, p2 = _patch_models_and_dispatch(models, ["claude", "codex"])
    with p1, p2:
        status, message = preflight.check_model_resolution()
    assert status == "warn"
    assert "dispatched agents: ['claude']" in message
    assert "in config.agents but not enabled in models" in message


def test_check_model_resolution_warns_when_intersection_is_empty() -> None:
    """Empty rotation/enabled overlap is a misalignment but not a hard
    block — single-agent flows (``--agent`` or ``domain_agents``) can
    still dispatch without going through ``config.agents``. Surface
    the misalignment as ``warn`` and let the dispatcher itself error
    if there's truly no agent to run."""
    models = {
        "claude": {"enabled": True, "model_id": "claude-opus-4-7"},
        "codex": {"enabled": True, "model_id": "gpt-5.4"},
    }
    # Rotation lists only gemini; intersection with enabled is empty.
    p1, p2 = _patch_models_and_dispatch(models, ["gemini"])
    with p1, p2:
        status, message = preflight.check_model_resolution()
    assert status == "warn"
    assert "no agents in the team-review intersection" in message
    assert "single-agent dispatch may still work" in message


def test_check_model_resolution_warns_on_malformed_config_agents() -> None:
    """A misformatted ``config.agents`` (string instead of list, etc.)
    must not silently fall through to the legacy "all enabled" report;
    it should surface as a warning so the operator sees something is wrong."""
    models = {
        "claude": {"enabled": True, "model_id": "claude-opus-4-7"},
        "codex": {"enabled": True, "model_id": "gpt-5.4"},
    }
    p1, p2 = _patch_models_and_dispatch(models, "claude,codex")  # type: ignore[arg-type]
    with p1, p2:
        status, message = preflight.check_model_resolution()
    assert status == "warn"
    assert "config.agents is malformed" in message


def test_check_model_resolution_warns_on_discover_config_failure() -> None:
    """A non-ImportError raised by ``discover_config`` (e.g. malformed
    JSON, unreadable file) must not be swallowed."""
    models = {
        "claude": {"enabled": True, "model_id": "claude-opus-4-7"},
        "codex": {"enabled": True, "model_id": "gpt-5.4"},
    }
    with patch("preflight.get_models_config", return_value=models), \
         patch("dispatcher_base.discover_config", side_effect=RuntimeError("bad config")):
        status, message = preflight.check_model_resolution()
    assert status == "warn"
    assert "could not load review config" in message
    assert "bad config" in message


def test_check_model_resolution_passes_when_config_agents_absent() -> None:
    """No ``agents`` key in merged config means "use all enabled" — a
    valid steady state, not a misalignment."""
    models = {
        "claude": {"enabled": True, "model_id": "claude-opus-4-7"},
        "codex": {"enabled": True, "model_id": "gpt-5.4"},
    }
    p1, p2 = _patch_models_and_dispatch(models, None)
    with p1, p2:
        status, message = preflight.check_model_resolution()
    assert status == "pass"
    assert "dispatched agents: ['claude', 'codex']" in message


# ---------------------------------------------------------------------------
# run_preflight() integration — verifies the warn status from
# check_model_resolution propagates to overall=degraded /
# recommended_mode=single-agent. Without this, a wiring regression that
# stopped translating "warn" to "degraded" would still pass the
# function-level tests above.
# ---------------------------------------------------------------------------


def _replace_checks_with_target(
    monkeypatch, target_name: str, target_fn, target_critical: bool
):
    """Monkey-patch ``_CHECKS`` to a 2-element list: a stubbed pass-only
    check plus the test target. Patching individual check function names
    on the preflight module isn't enough — _CHECKS holds direct
    references to the original callables, not name lookups."""
    stub_checks = [
        ("check_stub_pass", lambda: ("pass", "stubbed"), False),
        (target_name, target_fn, target_critical),
    ]
    monkeypatch.setattr(preflight, "_CHECKS", stub_checks)


def test_run_preflight_propagates_warn_to_degraded(monkeypatch) -> None:
    """Misalignment warn at the check level → overall=degraded at the
    aggregate level → recommended_mode=single-agent."""
    _replace_checks_with_target(
        monkeypatch,
        "check_model_resolution",
        lambda: ("warn", "dispatched agents: ['claude']; enabled but excluded ['gemini']"),
        True,
    )
    result = preflight.run_preflight("stark-review")
    assert result.overall == "degraded"
    assert result.recommended_mode == "single-agent"
    mr = next(c for c in result.checks if c["name"] == "check_model_resolution")
    assert mr["status"] == "warn"


def test_run_preflight_propagates_critical_fail_to_blocked(monkeypatch) -> None:
    """check_model_resolution is critical=True; a fail blocks the run."""
    _replace_checks_with_target(
        monkeypatch,
        "check_model_resolution",
        lambda: ("fail", "missing agent config: ['codex']"),
        True,
    )
    result = preflight.run_preflight("stark-team-review")
    assert result.overall == "blocked"
    assert result.recommended_mode == "abort"
    mr = next(c for c in result.checks if c["name"] == "check_model_resolution")
    assert mr["status"] == "fail"


def test_check_model_resolution_fails_when_required_agent_missing() -> None:
    with patch(
        "preflight.get_models_config",
        return_value={"claude": {"enabled": True, "model_id": "claude-opus-4-7"}},
    ):
        status, message = preflight.check_model_resolution()
    assert status == "fail"
    assert "codex" in message


def test_check_model_resolution_fails_when_all_agents_disabled() -> None:
    models = {
        "claude": {"enabled": False, "model_id": "claude-opus-4-7"},
        "codex": {"enabled": False, "model_id": "gpt-5.4"},
    }
    p1, p2 = _patch_models_and_dispatch(models, ["claude", "codex"])
    with p1, p2:
        status, message = preflight.check_model_resolution()
    assert status == "fail"
    assert message == "no enabled agents in config"


def test_check_model_resolution_falls_back_when_discover_config_unavailable(monkeypatch) -> None:
    """If ``dispatcher_base`` can't be imported (older install), report
    legacy format. The ``import dispatcher_base`` happens inside the
    function under test, so we have to perturb ``sys.modules`` rather
    than patch the attribute."""
    import sys
    models = {
        "claude": {"enabled": True, "model_id": "claude-opus-4-7"},
        "codex": {"enabled": True, "model_id": "gpt-5.4"},
        "gemini": {"enabled": False, "model_id": "gemini-2.5-pro"},
    }

    # Force a fresh ImportError on the in-function import.
    saved = sys.modules.pop("dispatcher_base", None)

    class _Blocker:
        def find_spec(self, name, *_args, **_kwargs):
            if name == "dispatcher_base":
                raise ImportError("simulated absence")
            return None

    blocker = _Blocker()
    sys.meta_path.insert(0, blocker)
    try:
        with patch("preflight.get_models_config", return_value=models):
            status, message = preflight.check_model_resolution()
    finally:
        sys.meta_path.remove(blocker)
        if saved is not None:
            sys.modules["dispatcher_base"] = saved
    assert status == "pass"
    assert message == "enabled agents: ['claude', 'codex']; disabled agents: ['gemini']"
