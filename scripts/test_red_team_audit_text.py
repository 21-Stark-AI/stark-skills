"""Tests for red_team_audit_text — FU-rt6 retention policy."""

from __future__ import annotations

import red_team_audit_text as rta


def _policy(retain_full_text: bool = False, excerpt_max_chars: int = 60):
    return rta.AuditRetentionPolicy(
        retain_full_text=retain_full_text,
        excerpt_max_chars=excerpt_max_chars,
    )


def test_policy_from_config_defaults_to_excerpt():
    pol = rta.policy_from_config(None)
    assert pol.retain_full_text is False
    assert pol.mode == "excerpt"


def test_policy_from_config_respects_explicit_full_text():
    pol = rta.policy_from_config({"retain_full_text": True})
    assert pol.retain_full_text is True
    assert pol.mode == "full"


def test_apply_to_field_returns_null_for_empty_text():
    out = rta.apply_to_field(None, _policy())
    assert out.stored is None
    assert out.hash is None
    out_empty = rta.apply_to_field("", _policy())
    assert out_empty.stored is None


def test_excerpt_mode_truncates_and_pairs_with_hash():
    pol = _policy(excerpt_max_chars=20)
    # Mix of words avoids the >40-char base64-secret regex catching the input.
    text = "the quick brown fox jumps over the lazy dog several times in the meadow"
    out = rta.apply_to_field(text, pol)
    assert out.stored is not None
    assert len(out.stored) <= 20
    assert out.stored.endswith("…")
    assert out.hash == rta.hash_text(text)


def test_excerpt_mode_redacts_secrets_before_truncating():
    pol = _policy(excerpt_max_chars=80)
    text = "Found token sk-deadbeefdeadbeefdeadbeefdeadbeef in config"
    out = rta.apply_to_field(text, pol)
    assert out.stored is not None
    assert "sk-deadbeefdeadbeefdeadbeefdeadbeef" not in out.stored
    assert "[REDACTED]" in out.stored
    # The hash is over the ORIGINAL text so two reruns of the same finding
    # match even after redaction obscures the token.
    assert out.hash == rta.hash_text(text)


def test_full_text_mode_skips_excerpt_hash():
    pol = _policy(retain_full_text=True)
    text = "long full-text concern that should be retained verbatim"
    out = rta.apply_to_field(text, pol)
    assert out.stored == text
    # No paired hash in full-text mode — the row IS the source of truth.
    assert out.hash is None


def test_full_text_mode_still_redacts_secrets():
    """Full-text retention does NOT mean store-secrets-verbatim. Defense in
    depth: even when the policy permits raw text, accidental secret echoes
    must be scrubbed."""
    pol = _policy(retain_full_text=True)
    text = "ghp_abcdefghijklmnopqrstuvwxyz1234567890 leaked"
    out = rta.apply_to_field(text, pol)
    assert out.stored is not None
    assert "ghp_abcdefghijklmnopqrstuvwxyz1234567890" not in out.stored


def test_hash_text_is_deterministic():
    h1 = rta.hash_text("hello")
    h2 = rta.hash_text("hello")
    assert h1 == h2
    h3 = rta.hash_text("Hello")
    assert h1 != h3
