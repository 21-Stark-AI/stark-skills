"""Audit-text retention policy for red-team findings (FU-rt6).

Raw finding text can quote requirements, PR diffs, customer data, secrets, or
security architecture details verbatim. The audit DB shares
``forged_review_metrics.db`` with the wider metrics surface, so storing raw
text indefinitely turns the metrics database into a sensitive-document store.

This module provides the single canonical knob between full-text retention
(``retain_full_text=True``, opt-in) and excerpt-only retention (default). In
excerpt mode the audit row stores a short redacted excerpt plus a SHA-256
hash of the original; the hash is what links a redacted row back to a finding
the operator may also see in a sidecar / PR comment.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

from emit_queue import _redact

_DEFAULT_EXCERPT_MAX_CHARS = 240
_TRUNCATION_MARKER = "…"


@dataclass(frozen=True)
class RetainedText:
    """A retained-for-audit value with optional pairing hash."""

    stored: str | None
    hash: str | None


@dataclass(frozen=True)
class AuditRetentionPolicy:
    """Resolved retention posture for one finding insert.

    Build via :func:`policy_from_config` and pass to :func:`apply_to_field`.
    """

    retain_full_text: bool
    excerpt_max_chars: int

    @property
    def mode(self) -> str:
        return "full" if self.retain_full_text else "excerpt"


def policy_from_config(cfg_audit: dict | None) -> AuditRetentionPolicy:
    """Build a policy from the ``red_team.audit`` config sub-dict.

    Missing config falls back to excerpt mode — the secure default. Only an
    explicit ``retain_full_text: true`` opens full-text retention.
    """
    cfg_audit = cfg_audit or {}
    return AuditRetentionPolicy(
        retain_full_text=bool(cfg_audit.get("retain_full_text", False)),
        excerpt_max_chars=int(
            cfg_audit.get("excerpt_max_chars", _DEFAULT_EXCERPT_MAX_CHARS)
        ),
    )


def hash_text(text: str | None) -> str | None:
    """Return SHA-256 hex of ``text`` or ``None`` for empty values.

    The hash is content-only and never includes per-finding salt, so two
    findings with identical concern text produce the same hash. That's the
    point — operators triaging "did this concern recur?" can match by hash
    without re-disclosing the underlying text.
    """
    if not text:
        return None
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _excerpt(text: str, max_chars: int) -> str:
    """Truncate to ``max_chars`` with a single-character ellipsis suffix."""
    if max_chars <= 0:
        return ""
    if len(text) <= max_chars:
        return text
    if max_chars <= len(_TRUNCATION_MARKER):
        return text[:max_chars]
    return text[: max_chars - len(_TRUNCATION_MARKER)] + _TRUNCATION_MARKER


def apply_to_field(
    text: str | None,
    policy: AuditRetentionPolicy,
) -> RetainedText:
    """Apply the retention policy to one free-text field.

    - ``None`` / empty → ``RetainedText(None, None)`` (preserves SQL NULL).
    - Full-text mode → store the original (still redacted via ``_redact``
      so accidental secret echoes are scrubbed even at full retention).
    - Excerpt mode → store a redacted excerpt and pair it with a SHA-256
      of the *original* (pre-redaction, pre-truncation) text so two reruns
      of the same finding still hash-match.
    """
    if not text:
        return RetainedText(stored=None, hash=None)

    if policy.retain_full_text:
        return RetainedText(stored=_redact(text), hash=None)

    redacted = _redact(text)
    excerpt = _excerpt(redacted, policy.excerpt_max_chars)
    return RetainedText(stored=excerpt, hash=hash_text(text))
