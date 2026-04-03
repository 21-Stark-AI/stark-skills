"""
failure_classifier.py — classify stderr output into canonical failure categories.

CLI: python3 scripts/failure_classifier.py --stderr-file PATH [--json]
"""

import sys
import re
import json
import argparse
import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

# ---------------------------------------------------------------------------
# Category definitions (priority order: index 0 = highest priority)
# ---------------------------------------------------------------------------

CATEGORIES = [
    {
        "name": "AUTH_STALE",
        "pattern_id": "auth-stale",
        "recommended_action": "refresh GitHub App token",
        "patterns": [
            {"text": "401", "is_regex": False},
            {"text": "403 Forbidden", "is_regex": False},
            {"text": "token expired", "is_regex": False},
            {"text": "Bad credentials", "is_regex": False},
        ],
    },
    {
        "name": "MISSING_IMPORT",
        "pattern_id": "missing-import",
        "recommended_action": "add missing import or install package",
        "patterns": [
            {"text": "ModuleNotFoundError", "is_regex": False},
            {"text": "ImportError", "is_regex": False},
            {"text": "No module named", "is_regex": False},
        ],
    },
    {
        "name": "TYPE_ERROR",
        "pattern_id": None,
        "recommended_action": "fix type mismatch in code",
        "patterns": [
            {"text": "TypeError", "is_regex": False},
            {"text": r"type.*mismatch", "is_regex": True},
            {"text": "incompatible type", "is_regex": False},
        ],
    },
    {
        "name": "SYNTAX_ERROR",
        "pattern_id": "syntax-error",
        "recommended_action": "fix syntax error in file",
        "patterns": [
            {"text": "SyntaxError", "is_regex": False},
            {"text": "IndentationError", "is_regex": False},
            {"text": "unexpected token", "is_regex": False},
        ],
    },
    {
        "name": "MIGRATION_CONFLICT",
        "pattern_id": "migration-conflict",
        "recommended_action": "resolve migration head conflict",
        "patterns": [
            {"text": r"alembic.*revision", "is_regex": True},
            {"text": r"migration.*conflict", "is_regex": True},
            {"text": r"duplicate.*migration", "is_regex": True},
        ],
    },
    {
        "name": "DEPENDENCY_MISMATCH",
        "pattern_id": None,
        "recommended_action": "resolve dependency version conflict",
        "patterns": [
            {"text": r"version.*conflict", "is_regex": True},
            {"text": r"dependency.*resolution", "is_regex": True},
            {"text": r"peer.*required", "is_regex": True},
        ],
    },
    {
        "name": "RESOURCE_EXHAUSTED",
        "pattern_id": "stale-lock",
        "recommended_action": "wait for rate limit or free resources",
        "patterns": [
            {"text": "rate limit", "is_regex": False},
            {"text": "quota exceeded", "is_regex": False},
            {"text": "429", "is_regex": False},
            {"text": "OOM", "is_regex": False},
            {"text": "MemoryError", "is_regex": False},
        ],
    },
]

UNCLASSIFIED = {
    "name": "UNCLASSIFIED",
    "pattern_id": None,
    "recommended_action": "inspect stderr manually",
    "confidence": 0.5,
}


def _line_matches(line: str, pattern: dict) -> bool:
    """Return True if the line matches the given pattern dict."""
    if pattern["is_regex"]:
        return bool(re.search(pattern["text"], line, re.IGNORECASE))
    return pattern["text"] in line


def classify(stderr_content: str) -> dict:
    """Classify stderr content and return result dict."""
    if not stderr_content.strip():
        return {
            "category": "UNCLASSIFIED",
            "confidence": 0.5,
            "pattern_id": None,
            "recommended_action": "inspect stderr manually",
        }

    lines = stderr_content.splitlines()

    for category in CATEGORIES:
        for pattern in category["patterns"]:
            for line in lines:
                if _line_matches(line, pattern):
                    confidence = 0.7 if pattern["is_regex"] else 1.0
                    return {
                        "category": category["name"],
                        "confidence": confidence,
                        "pattern_id": category["pattern_id"],
                        "recommended_action": category["recommended_action"],
                    }

    return {
        "category": "UNCLASSIFIED",
        "confidence": 0.5,
        "pattern_id": None,
        "recommended_action": "inspect stderr manually",
    }


def _log_result(result: dict, stderr_file: str) -> None:
    """Append classification result to healer.jsonl log."""
    try:
        log_dir = Path.home() / ".claude" / "code-review"
        log_dir.mkdir(parents=True, exist_ok=True)
        log_path = log_dir / "healer.jsonl"
        entry = {
            "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
            "category": result["category"],
            "confidence": result["confidence"],
            "pattern_id": result["pattern_id"],
            "stderr_file": str(stderr_file),
        }
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception:
        pass  # Never fail on logging errors


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Classify failure stderr into canonical categories."
    )
    parser.add_argument("--stderr-file", required=True, help="Path to stderr file")
    parser.add_argument(
        "--json", action="store_true", help="Output result as JSON (default: human)"
    )
    args = parser.parse_args()

    stderr_path = Path(args.stderr_file)
    if not stderr_path.exists():
        print(f"Error: stderr file not found: {stderr_path}", file=sys.stderr)
        sys.exit(1)

    stderr_content = stderr_path.read_text(encoding="utf-8", errors="replace")
    stderr_excerpt = stderr_content[:500]

    result = classify(stderr_content)
    result["stderr_excerpt"] = stderr_excerpt

    _log_result(result, args.stderr_file)

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(f"Category:           {result['category']}")
        print(f"Confidence:         {result['confidence']}")
        print(f"Pattern ID:         {result['pattern_id']}")
        print(f"Recommended action: {result['recommended_action']}")
        if result['stderr_excerpt']:
            print(f"Stderr excerpt:\n{result['stderr_excerpt']}")


if __name__ == "__main__":
    main()
