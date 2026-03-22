#!/usr/bin/env python3
"""One-time setup script for GitHub Projects V2.

Creates a project with all 14 custom fields and writes
.github/project-config.json with the field/option IDs.

Usage:
    python scripts/setup_project.py --org GetEvinced --name "Stark Tasks"
    python scripts/setup_project.py --org GetEvinced --name "Stark Tasks" --dry-run
    python scripts/setup_project.py --org GetEvinced --name "Stark Tasks" --app stark-codex
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

# Allow running from repo root or scripts/
_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

import github_app
import github_projects

# ── Field definitions ─────────────────────────────────────────────────

SINGLE_SELECT_FIELDS: dict[str, list[str]] = {
    "Status": [
        "backlog",
        "needs spec",
        "ready for agent",
        "agent working",
        "human working",
        "needs clarification",
        "human review",
        "ready to merge",
        "ready to release",
        "done",
        "blocked",
    ],
    "Priority": ["critical", "high", "medium", "low"],
    "Risk": ["high", "medium", "low"],
    "AI Suitability": ["high", "medium", "low"],
    "Spec Approval": ["approved", "needs revision", "pending", "not required"],
    "Release Approval": ["approved", "needs revision", "pending", "not required"],
    "Documentation State": ["complete", "partial", "missing", "not required"],
    "Agent": ["claude", "codex", "gemini", "human"],
}

NUMBER_FIELDS: list[str] = ["Story Points", "Review Rounds"]
TEXT_FIELDS: list[str] = ["Phase", "Blocked Reason", "Owner"]

# ── GraphQL mutations ─────────────────────────────────────────────────

_CREATE_PROJECT = """
mutation($ownerId: ID!, $title: String!) {
  createProjectV2(input: {ownerId: $ownerId, title: $title}) {
    projectV2 { id title number }
  }
}
"""

_GET_ORG_ID = """
query($org: String!) {
  organization(login: $org) { id }
}
"""

_CREATE_FIELD = """
mutation($projectId: ID!, $name: String!, $dataType: ProjectV2CustomFieldType!) {
  createProjectV2Field(input: {projectId: $projectId, name: $name, dataType: $dataType}) {
    projectV2Field {
      ... on ProjectV2Field { id name dataType }
      ... on ProjectV2SingleSelectField { id name dataType }
    }
  }
}
"""

_CREATE_SELECT_OPTION = """
mutation($projectId: ID!, $fieldId: ID!, $name: String!, $color: ProjectV2SingleSelectFieldOptionColor!) {
  createProjectV2SingleSelectFieldOption(input: {projectId: $projectId, fieldId: $fieldId, name: $name, color: $color}) {
    projectV2SingleSelectFieldOption { id name }
  }
}
"""

# Cycle through colors for select options
_COLORS = [
    "BLUE", "GREEN", "YELLOW", "ORANGE", "RED", "PURPLE", "PINK", "GRAY",
]


def _get_org_id(org: str) -> str:
    """Get the GraphQL node ID for an org."""
    data = github_app.graphql(_GET_ORG_ID, variables={"org": org})
    return data["organization"]["id"]


def _create_project(org_id: str, title: str) -> dict:
    """Create a new GitHub Project V2."""
    data = github_app.graphql(
        _CREATE_PROJECT,
        variables={"ownerId": org_id, "title": title},
    )
    return data["createProjectV2"]["projectV2"]


def _create_field(project_id: str, name: str, data_type: str) -> str:
    """Create a custom field. Returns field ID."""
    data = github_app.graphql(
        _CREATE_FIELD,
        variables={
            "projectId": project_id,
            "name": name,
            "dataType": data_type,
        },
    )
    time.sleep(github_projects.MUTATION_DELAY)
    return data["createProjectV2Field"]["projectV2Field"]["id"]


def _create_select_option(project_id: str, field_id: str, name: str, color: str) -> str:
    """Create a single-select option. Returns option ID."""
    data = github_app.graphql(
        _CREATE_SELECT_OPTION,
        variables={
            "projectId": project_id,
            "fieldId": field_id,
            "name": name,
            "color": color,
        },
    )
    time.sleep(github_projects.MUTATION_DELAY)
    return data["createProjectV2SingleSelectFieldOption"]["projectV2SingleSelectFieldOption"]["id"]


def setup_project(
    org: str,
    name: str,
    *,
    dry_run: bool = False,
) -> dict:
    """Create a project with all custom fields. Returns config dict.

    If the project already exists, uses the existing one and adds missing fields.
    """
    if dry_run:
        print("\n[DRY RUN] Would create project and fields:")
        print(f"  Organization: {org}")
        print(f"  Project name: {name}")
        print(f"  Single-select fields ({len(SINGLE_SELECT_FIELDS)}):")
        for field_name, options in SINGLE_SELECT_FIELDS.items():
            print(f"    {field_name}: {', '.join(options)}")
        print(f"  Number fields ({len(NUMBER_FIELDS)}): {', '.join(NUMBER_FIELDS)}")
        print(f"  Text fields ({len(TEXT_FIELDS)}): {', '.join(TEXT_FIELDS)}")
        total = len(SINGLE_SELECT_FIELDS) + len(NUMBER_FIELDS) + len(TEXT_FIELDS)
        print(f"  Total custom fields: {total}")
        return {"dry_run": True}

    # Check if project already exists
    project = None
    try:
        project = github_projects.find_project(org, name)
        print(f"Found existing project: {name} (#{project['number']})")
    except ValueError:
        print(f"Project '{name}' not found, will create.")

    # Get org ID and create project if needed
    if not project:
        org_id = _get_org_id(org)
        project = _create_project(org_id, name)
        print(f"Created project: {name} (#{project['number']})")

    project_id = project["id"]

    # Check existing fields
    existing = github_projects.get_field_ids(project_id, refresh=True)
    existing_names = set(existing.keys())

    config: dict = {
        "project_id": project_id,
        "project_number": project["number"],
        "org": org,
        "fields": {},
    }

    # Create single-select fields
    for field_name, options in SINGLE_SELECT_FIELDS.items():
        if field_name in existing_names:
            print(f"  Field '{field_name}' already exists, skipping creation.")
            field_id = existing[field_name]["id"]
            option_ids = existing[field_name].get("options", {})
        else:
            print(f"  Creating field: {field_name} (SINGLE_SELECT)")
            field_id = _create_field(project_id, field_name, "SINGLE_SELECT")
            option_ids = {}

        # Create missing options
        for i, opt_name in enumerate(options):
            if opt_name in option_ids:
                continue
            color = _COLORS[i % len(_COLORS)]
            print(f"    Adding option: {opt_name}")
            opt_id = _create_select_option(project_id, field_id, opt_name, color)
            option_ids[opt_name] = opt_id

        config["fields"][field_name] = {
            "id": field_id,
            "type": "SINGLE_SELECT",
            "options": option_ids,
        }

    # Create number fields
    for field_name in NUMBER_FIELDS:
        if field_name in existing_names:
            print(f"  Field '{field_name}' already exists, skipping.")
            field_id = existing[field_name]["id"]
        else:
            print(f"  Creating field: {field_name} (NUMBER)")
            field_id = _create_field(project_id, field_name, "NUMBER")

        config["fields"][field_name] = {"id": field_id, "type": "NUMBER"}

    # Create text fields
    for field_name in TEXT_FIELDS:
        if field_name in existing_names:
            print(f"  Field '{field_name}' already exists, skipping.")
            field_id = existing[field_name]["id"]
        else:
            print(f"  Creating field: {field_name} (TEXT)")
            field_id = _create_field(project_id, field_name, "TEXT")

        config["fields"][field_name] = {"id": field_id, "type": "TEXT"}

    # Write config
    repo_root = _SCRIPT_DIR.parent
    config_dir = repo_root / ".github"
    config_dir.mkdir(parents=True, exist_ok=True)
    config_path = config_dir / "project-config.json"
    config_path.write_text(json.dumps(config, indent=2) + "\n")
    print(f"\nConfig written to {config_path}")

    return config


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Create a GitHub Project V2 with custom fields for stark-skills.",
    )
    parser.add_argument("--org", required=True, help="GitHub organization (e.g. GetEvinced)")
    parser.add_argument("--name", required=True, help="Project name (e.g. 'Stark Tasks')")
    parser.add_argument("--app", default="stark-claude", help="GitHub App to use (default: stark-claude)")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be created without calling API")

    args = parser.parse_args()

    github_app.select_app(args.app)

    config = setup_project(args.org, args.name, dry_run=args.dry_run)

    if not args.dry_run:
        print(f"\nProject setup complete. {len(config['fields'])} fields configured.")


if __name__ == "__main__":
    main()
