#!/usr/bin/env python3
"""Unit tests for tui_core.py — shared TUI rendering primitives."""

from __future__ import annotations

import re
import unittest
from unittest.mock import patch

import tui_core
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
    slugify,
    strip_ansi,
    truncate,
)


ANSI_RE = re.compile(r"\033\[")


class TestMakeConfig(unittest.TestCase):
    """Tests 1-5: make_config environment detection."""

    def test_make_config_detects_tty(self) -> None:
        """TTY -> color=True, non-TTY -> color=False."""
        with patch.dict("os.environ", {}, clear=True), patch("sys.stdout") as mock_out:
            mock_out.isatty.return_value = True
            cfg = make_config()
            self.assertTrue(cfg.color)

        with patch.dict("os.environ", {}, clear=True), patch("sys.stdout") as mock_out:
            mock_out.isatty.return_value = False
            cfg = make_config()
            self.assertFalse(cfg.color)

    def test_make_config_respects_no_color(self) -> None:
        """NO_COLOR=1 -> color=False even on a TTY."""
        with patch.dict("os.environ", {"NO_COLOR": "1"}, clear=True), \
             patch("sys.stdout") as mock_out:
            mock_out.isatty.return_value = True
            cfg = make_config()
            self.assertFalse(cfg.color)

    def test_make_config_respects_term_dumb(self) -> None:
        """TERM=dumb -> color=False even on a TTY."""
        with patch.dict("os.environ", {"TERM": "dumb"}, clear=True), \
             patch("sys.stdout") as mock_out:
            mock_out.isatty.return_value = True
            cfg = make_config()
            self.assertFalse(cfg.color)

    def test_make_config_plain_forces_no_color(self) -> None:
        """plain=True -> color=False regardless of TTY."""
        with patch.dict("os.environ", {}, clear=True), \
             patch("sys.stdout") as mock_out:
            mock_out.isatty.return_value = True
            cfg = make_config(plain=True)
            self.assertFalse(cfg.color)
            self.assertTrue(cfg.plain)

    def test_make_config_respects_stark_plain(self) -> None:
        """STARK_PLAIN=1 -> plain=True."""
        with patch.dict("os.environ", {"STARK_PLAIN": "1"}, clear=True), \
             patch("sys.stdout") as mock_out:
            mock_out.isatty.return_value = True
            cfg = make_config()
            self.assertTrue(cfg.plain)
            # plain forces color off
            self.assertFalse(cfg.color)


class TestAnsiHelpers(unittest.TestCase):
    """Tests 6-9: ansi, icon, strip_ansi."""

    def test_ansi_wraps_when_color(self) -> None:
        """color=True -> ANSI codes present."""
        cfg = TUIConfig(color=True, plain=False, json_mode=False)
        result = ansi("32", "hello", cfg)
        self.assertRegex(result, r"\033\[32m")
        self.assertRegex(result, r"\033\[0m")

    def test_ansi_skips_when_no_color(self) -> None:
        """color=False -> no ANSI codes."""
        cfg = TUIConfig(color=False, plain=False, json_mode=False)
        result = ansi("32", "hello", cfg)
        self.assertEqual(result, "hello")
        self.assertNotRegex(result, r"\033\[")

    def test_icon_emoji_vs_plain(self) -> None:
        """plain=False -> emoji, plain=True -> text."""
        cfg_rich = TUIConfig(color=True, plain=False, json_mode=False)
        cfg_plain = TUIConfig(color=False, plain=True, json_mode=False)
        self.assertEqual(icon("\u2705", "[OK]", cfg_rich), "\u2705")
        self.assertEqual(icon("\u2705", "[OK]", cfg_plain), "[OK]")

    def test_strip_ansi_removes_codes(self) -> None:
        """ANSI-wrapped input -> clean output."""
        colored = "\033[32mhello\033[0m \033[1;31mworld\033[0m"
        self.assertEqual(strip_ansi(colored), "hello world")


class TestSanitize(unittest.TestCase):
    """Tests 10-13: sanitize_text."""

    def test_sanitize_strips_control_chars(self) -> None:
        """C0/C1 control chars stripped."""
        # \x00 (NUL), \x1b (ESC), \x7f (DEL), \x80 (C1)
        text = "hello\x00world\x1bfoo\x7fbar\x80baz"
        result = sanitize_text(text)
        self.assertEqual(result, "helloworldfoobarbaz")

    def test_sanitize_preserves_newline_tab(self) -> None:
        """\\n and \\t are preserved."""
        text = "line1\nline2\tcol"
        self.assertEqual(sanitize_text(text), text)

    def test_sanitize_strips_bidi_overrides(self) -> None:
        """U+202E (RLO) and U+2066 (LRI) removed."""
        text = "hello\u202eworld\u2066foo"
        result = sanitize_text(text)
        self.assertEqual(result, "helloworldfoo")

    def test_sanitize_strips_zero_width_chars(self) -> None:
        """U+200B (ZWSP) and U+FEFF (BOM) removed."""
        text = "hello\u200bworld\ufeffend"
        result = sanitize_text(text)
        self.assertEqual(result, "helloworldend")


class TestTruncate(unittest.TestCase):
    """Tests 14-16: truncate."""

    def test_truncate_short_text_unchanged(self) -> None:
        """Text shorter than max -> no change."""
        self.assertEqual(truncate("hello", 10), "hello")

    def test_truncate_long_text_with_ellipsis(self) -> None:
        """Text longer than max -> truncated with ellipsis."""
        result = truncate("abcdefghij", 5)
        visible = strip_ansi(result)
        self.assertTrue(visible.endswith("\u2026"))
        # 4 chars + ellipsis = 5 visible
        self.assertEqual(len(visible), 5)

    def test_truncate_ignores_ansi_in_length(self) -> None:
        """ANSI codes not counted toward visible length."""
        colored = "\033[32mabcdefghij\033[0m"
        result = truncate(colored, 5)
        visible = strip_ansi(result)
        self.assertTrue(visible.endswith("\u2026"))
        self.assertEqual(len(visible), 5)
        # ANSI codes should still be present in the non-stripped result
        self.assertRegex(result, r"\033\[")


class TestSlugify(unittest.TestCase):
    """Tests 17-18: slugify."""

    def test_slugify_basic(self) -> None:
        """Mixed case, parens, slash -> clean slug."""
        self.assertEqual(slugify("Feat/Session TUI (April)"), "feat-session-tui-april")

    def test_slugify_max_len(self) -> None:
        """Long input truncated to max_len."""
        long_input = "a" * 100
        result = slugify(long_input, max_len=50)
        self.assertLessEqual(len(result), 50)


class TestSectionHeader(unittest.TestCase):
    """Tests 19-20: section_header."""

    def test_section_header_formats(self) -> None:
        """Rich mode: em-dash format with title."""
        cfg = TUIConfig(color=False, plain=False, json_mode=False)
        result = section_header(cfg, "Triage", "\U0001f3af", "[TRIAGE]")
        self.assertIn("\u2500\u2500", result)
        self.assertIn("Triage", result)
        self.assertIn("\U0001f3af", result)

    def test_section_header_plain(self) -> None:
        """Plain mode: === [LABEL] Title ==="""
        cfg = TUIConfig(color=False, plain=True, json_mode=False)
        result = section_header(cfg, "Triage", "\U0001f3af", "[TRIAGE]")
        self.assertEqual(result, "=== [TRIAGE] Triage ===")


class TestFormatBanner(unittest.TestCase):
    """Tests 21-23: format_banner."""

    def test_format_banner_box_drawing(self) -> None:
        """Rich mode: box-drawing borders."""
        cfg = TUIConfig(color=False, plain=False, json_mode=False)
        result = format_banner(cfg, ["Line one", "Line two"])
        self.assertIn("\u2554", result)  # top-left
        self.assertIn("\u2550", result)  # horizontal
        self.assertIn("\u2557", result)  # top-right
        self.assertIn("\u2551", result)  # vertical
        self.assertIn("\u255a", result)  # bottom-left
        self.assertIn("\u255d", result)  # bottom-right
        self.assertIn("Line one", result)
        self.assertIn("Line two", result)

    def test_format_banner_plain(self) -> None:
        """Plain mode: = dividers instead of box drawing."""
        cfg = TUIConfig(color=False, plain=True, json_mode=False)
        result = format_banner(cfg, ["Line one", "Line two"])
        self.assertIn("=" * BANNER_WIDTH, result)
        self.assertNotIn("\u2554", result)
        self.assertNotIn("\u2551", result)
        self.assertIn("Line one", result)

    def test_format_banner_truncates_long_lines(self) -> None:
        """Lines wider than inner width are truncated."""
        cfg = TUIConfig(color=False, plain=False, json_mode=False)
        long_line = "x" * 200
        result = format_banner(cfg, [long_line])
        # Each line in the banner should fit within the box
        for line in result.split("\n"):
            if "\u2551" in line:
                # inner content between bars
                inner = line[2:-2]  # strip "║ " and " ║"
                self.assertLessEqual(len(inner), BANNER_WIDTH - 4)


class TestRenderChecklistItem(unittest.TestCase):
    """Bonus: render_checklist_item."""

    def test_pass_item(self) -> None:
        cfg = TUIConfig(color=False, plain=True, json_mode=False)
        result = render_checklist_item(cfg, True, "Auth", "token valid", duration=1.5)
        self.assertIn("[OK]", result)
        self.assertIn("Auth", result)
        self.assertIn("(1.5s)", result)

    def test_fail_item(self) -> None:
        cfg = TUIConfig(color=False, plain=True, json_mode=False)
        result = render_checklist_item(cfg, False, "Auth", "token expired")
        self.assertIn("[FAIL]", result)

    def test_warn_item(self) -> None:
        cfg = TUIConfig(color=False, plain=True, json_mode=False)
        result = render_checklist_item(cfg, None, "Auth", "token near expiry")
        self.assertIn("[WARN]", result)


class TestRenderKvLine(unittest.TestCase):
    """Bonus: render_kv_line."""

    def test_kv_no_color(self) -> None:
        cfg = TUIConfig(color=False, plain=False, json_mode=False)
        result = render_kv_line(cfg, "Repo", "org/foo")
        self.assertEqual(result, "Repo: org/foo")

    def test_kv_with_color(self) -> None:
        cfg = TUIConfig(color=True, plain=False, json_mode=False)
        result = render_kv_line(cfg, "Repo", "org/foo", color="32")
        self.assertRegex(result, r"\033\[32m")


if __name__ == "__main__":
    unittest.main()
