#!/usr/bin/env python3
"""TUI rendering for the triage review workflow.

Domain-specific render functions for banner, triage table, dispatch
progress, summary, insights, and zero-domain messages.  Shared
primitives are imported from tui_core.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Any

from tui_core import (
    BANNER_WIDTH,
    TUIConfig,
    ansi,
    format_banner,
    icon,
    make_config,
    render_checklist_item,
    render_kv_line,
    sanitize_text,
    section_header,
    strip_ansi,
)

if TYPE_CHECKING:
    from domain_triage import DomainVerdict, TriageResult

# Re-export for backward compatibility — existing importers (e.g.
# triage_orchestrator) use ``from triage_tui import TUIConfig, make_config``.
__all__ = [
    "TUIConfig",
    "make_config",
    "render_banner",
    "render_triage",
    "render_dispatch_progress",
    "render_summary",
    "render_insights",
    "render_zero_domains",
]


# ── Triage-specific label / style dicts ──────────────────────────────

_REVIEW_LABELS = {
    "pr": ("PR Review", "32", "\U0001f50d", "[PR REVIEW]"),
    "design": ("Design Review", "35", "\U0001f4d0", "[DESIGN REVIEW]"),
    "plan": ("Plan Review", "34", "\U0001f4cb", "[PLAN REVIEW]"),
}

_MODE_LABELS = {
    "aggressive": ("33", "\u26a1", "aggressive"),
    "conservative": ("36", "\U0001f6e1\ufe0f", "conservative"),
    "full": ("2", "\U0001f513", "full"),
}

_SEVERITY_LABELS = {
    "critical": ("1;31", "\U0001f534", "critical"),
    "high": ("1;33", "\U0001f7e1", "high"),
    "medium": ("37", "\U0001f7e0", "medium"),
    "low": ("2", "\u26aa", "low"),
}

_STATUS_STYLE = {
    True: ("32", "\u2705", "[OK]"),
    False: ("31", "\u23ed\ufe0f", "[SKIP]"),
}

_DISPATCH_STYLE = {
    "success": ("32", "\u2705", "[OK]"),
    "failure": ("31", "\u274c", "[FAIL]"),
    "running": ("33", "\u00b7\u00b7\u00b7", "[RUN]"),
}


# ── Internal helpers ─────────────────────────────────────────────────

def _review_meta(review_type: str) -> tuple[str, str, str, str]:
    return _REVIEW_LABELS.get(review_type, (review_type.title(), "37", "\U0001f50d", f"[{review_type.upper()}]"))


def _mode_meta(mode: str) -> tuple[str, str, str]:
    return _MODE_LABELS.get(mode, ("37", mode, mode))


def _severity_meta(severity: str) -> tuple[str, str, str]:
    return _SEVERITY_LABELS.get(severity, ("37", severity, severity))


def _format_duration(duration: float | None) -> str:
    if duration is None:
        return ""
    return f"({duration:.1f}s)"


def _normalize_dispatch_status(status: str) -> str:
    normalized = status.strip().lower()
    if normalized in {"success", "succeeded", "ok", "done", "completed"}:
        return "success"
    if normalized in {"failure", "failed", "error", "timeout", "timed_out"}:
        return "failure"
    return "running"


def _dispatch_detail(status: str, findings_count: int | None) -> str:
    normalized = status.strip().lower()
    if normalized in {"success", "succeeded", "ok", "done", "completed"}:
        if findings_count is None:
            return "completed"
        noun = "finding" if findings_count == 1 else "findings"
        return f"{findings_count} {noun}"
    if normalized in {"timeout", "timed_out"}:
        return "timeout"
    if normalized in {"failure", "failed", "error"}:
        return normalized
    return "running..."


def _get_verdicts(triage_result: Any) -> list[Any]:
    return list(getattr(triage_result, "verdicts", []))


def _get_domains(triage_result: Any, name: str) -> list[str]:
    return list(getattr(triage_result, name, []))


# ── Render functions ─────────────────────────────────────────────────

def render_banner(
    config: TUIConfig,
    review_type: str,
    repo: str,
    pr_number: int | None,
    mode: str,
    agent: str,
    model: str,
) -> str:
    """Render the top banner for a triage session."""
    if config.json_mode:
        return ""

    review_label, review_color, review_emoji, review_plain = _review_meta(review_type)
    mode_color, mode_emoji, mode_plain = _mode_meta(mode)

    repo_safe = sanitize_text(repo)
    repo_label = f"{repo_safe} #{pr_number}" if pr_number is not None else repo_safe
    review_prefix = ansi(review_color, icon(review_emoji, review_plain, config), config)
    mode_prefix = ansi(mode_color, icon(mode_emoji, mode_plain, config), config)

    line_one = f"{review_prefix}  stark-triage \u00b7 {review_label} \u00b7 {repo_label}"
    if config.plain:
        line_two = f"Mode: {mode_plain} \u00b7 Agent: {agent} \u00b7 Model: {model}"
    else:
        line_two = f"{mode_prefix}  Mode: {mode} \u00b7 Agent: {agent} \u00b7 Model: {model}"

    return format_banner(config, [line_one, line_two])


def render_triage(config: TUIConfig, triage_result: Any) -> str:
    """Render the triage verdict table and footer."""
    if config.json_mode:
        return ""

    verdicts = _get_verdicts(triage_result)
    dispatched_domains = _get_domains(triage_result, "dispatched_domains")
    skipped_domains = _get_domains(triage_result, "skipped_domains")
    domain_width = max((len(getattr(verdict, "domain", "")) for verdict in verdicts), default=12)

    lines = [section_header(config, "Triage", "\U0001f3af", "[TRIAGE]")]
    for verdict in verdicts:
        relevant = bool(getattr(verdict, "relevant", False))
        color, emoji_char, plain_text = _STATUS_STYLE[relevant]
        ico = ansi(color, icon(emoji_char, plain_text, config), config)
        status_text = "relevant" if relevant else "skip"
        domain = sanitize_text(str(getattr(verdict, "domain", ""))).ljust(domain_width)
        confidence = f"({float(getattr(verdict, 'confidence', 0.0)):.2f})"
        reason = sanitize_text(str(getattr(verdict, "reason", "")).strip())
        line = f"  {ico} {domain}  {status_text:<9} {confidence}"
        if reason:
            line += f" {reason}"
        lines.append(line)

    total = len(verdicts)
    dispatched = len(dispatched_domains)
    saved = len(skipped_domains)
    dispatch_icon = icon("\U0001f680", "[TRIAGE]", config)
    time_icon = icon("\u23f1\ufe0f", "", config)
    footer_one = f"{dispatch_icon} Dispatching {dispatched}/{total} domains  \u00b7  Saving ~{saved} sub-agent runs"
    footer_two = f"{time_icon} Triage completed in {float(getattr(triage_result, 'duration_s', 0.0)):.1f}s".strip()
    lines.append(footer_one)
    lines.append(ansi("2", footer_two, config))
    return "\n".join(lines)


def render_dispatch_progress(
    config: TUIConfig,
    index: int,
    total: int,
    agent: str,
    domain: str,
    status: str,
    findings_count: int | None = None,
    duration: float | None = None,
) -> str:
    """Render a single dispatch progress line."""
    if config.json_mode:
        return ""

    normalized = _normalize_dispatch_status(status)
    color, emoji_char, plain_text = _DISPATCH_STYLE[normalized]
    ico = ansi(color, icon(emoji_char, plain_text, config), config)
    detail = _dispatch_detail(status, findings_count)
    digits = max(1, len(str(total)))
    prefix = f"[{index:>{digits}}/{total}]"
    actor = f"{sanitize_text(agent)}:{sanitize_text(domain)}"
    actor_width = max(20, min(34, len(actor) + 2))
    line = f"{prefix} {ico} {actor.ljust(actor_width)} {detail}"
    if duration is not None:
        line += f"    {ansi('2', _format_duration(duration), config)}"
    return line


def render_summary(
    config: TUIConfig,
    total_findings: int,
    by_severity: dict[str, int],
    succeeded: int,
    failed: int,
    total_duration: float,
    triage_duration: float,
) -> str:
    """Render the final dispatch summary."""
    if config.json_mode:
        return ""

    lines = [section_header(config, "Summary", "\U0001f4ca", "[SUMMARY]")]
    severity_parts = [f"{total_findings} findings"]
    for severity in ("critical", "high", "medium", "low"):
        count = int(by_severity.get(severity, 0))
        color, emoji_char, plain_text = _severity_meta(severity)
        if config.plain:
            severity_parts.append(f"{count} {severity}")
        else:
            token = ansi(color, icon(emoji_char, plain_text, config), config)
            severity_parts.append(f"{token} {count} {severity}")
    lines.append("  \u00b7  ".join(severity_parts))

    success_icon = ansi("32", icon("\u2705", "[OK]", config), config)
    failure_icon = ansi("31", icon("\u274c", "[FAIL]", config), config)
    total_runs = succeeded + failed
    failure_label = "failure" if failed == 1 else "failures"
    lines.append(f"{success_icon} {succeeded}/{total_runs} sub-agents succeeded  \u00b7  {failure_icon} {failed} {failure_label}")
    dispatch_duration = max(0.0, total_duration - triage_duration)
    timing_icon = icon("\u23f1\ufe0f", "", config)
    timing_line = f"{timing_icon} Total: {total_duration:.1f}s (triage: {triage_duration:.1f}s + dispatch: {dispatch_duration:.1f}s)".strip()
    lines.append(ansi("2", timing_line, config))
    return "\n".join(lines)


def render_insights(config: TUIConfig, success: bool, error: str | None = None) -> str:
    """Render the insights emission status section."""
    if config.json_mode:
        return ""

    lines = [section_header(config, "Insights", "\U0001f4e1", "[INSIGHTS]")]
    if success:
        arrow = icon("\u2192", "->", config)
        lines.append(f"{arrow} triage_decision event emitted to stark-insights")
    else:
        warning = ansi("33", icon("\u26a0", "[WARN]", config), config)
        detail = sanitize_text(error) if error else "unknown error"
        lines.append(f"{warning} stark-insights unavailable: {detail}")
    return "\n".join(lines)


def render_zero_domains(config: TUIConfig) -> str:
    """Render the empty-dispatch message when no domains were selected."""
    if config.json_mode:
        return ""
    marker = ansi("31", icon("\U0001f6ab", "[SKIP]", config), config)
    return f"{marker} Triage found no relevant domains - skipping review"
