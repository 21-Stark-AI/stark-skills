#!/usr/bin/env python3
"""GitHub Projects V2 utility module.

Wraps all GraphQL complexity for project operations.
Used by stark-skills pipeline (plan-to-tasks, phase-execute, review, session).

Follows the same module-level function pattern as github_app.py — no classes.
Calls github_app.graphql() for all API operations.

API constraints:
- get_items() filters are client-side (no server-side filtering by field value)
- Single-field mutations only (one updateProjectV2ItemFieldValue per call)
- Owner is Text field, not Assignees (API limitation)
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any

import github_app

log = logging.getLogger(__name__)

# ── Module state ───────────────────────────────────────────────────────

_field_cache: dict[str, dict[str, dict[str, Any]]] = {}  # project_id -> {field_name -> {id, type, options}}

MUTATION_DELAY = 0.1  # 100ms between mutations to avoid rate limits

# ── Legal transitions (from spec state machine) ───────────────────────

LEGAL_TRANSITIONS: dict[str, set[str]] = {
    "backlog": {"needs spec"},
    "needs spec": {"ready for agent", "human working", "blocked"},
    "ready for agent": {"agent working", "blocked"},
    "agent working": {"human review", "needs clarification", "blocked"},
    "human working": {"human review", "blocked"},
    "needs clarification": {"ready for agent", "blocked"},
    "human review": {"agent working", "human working", "ready to merge", "blocked"},
    "ready to merge": {"ready to release", "human review", "blocked"},
    "ready to release": {"done", "human review", "blocked"},
    "blocked": {
        "backlog", "needs spec", "ready for agent", "agent working",
        "human working", "needs clarification", "human review",
        "ready to merge", "ready to release",
    },
}

# ── GraphQL queries ────────────────────────────────────────────────────

_FIND_PROJECT = """
query($org: String!, $first: Int!) {
  organization(login: $org) {
    projectsV2(first: $first) {
      nodes { id title number }
    }
  }
}
"""

_ADD_ITEM = """
mutation($projectId: ID!, $contentId: ID!) {
  addProjectV2ItemById(input: {projectId: $projectId, contentId: $contentId}) {
    item { id }
  }
}
"""

_GET_FIELD_IDS = """
query($projectId: ID!) {
  node(id: $projectId) {
    ... on ProjectV2 {
      fields(first: 30) {
        nodes {
          ... on ProjectV2Field { id name dataType }
          ... on ProjectV2SingleSelectField {
            id name dataType
            options { id name }
          }
          ... on ProjectV2IterationField { id name dataType }
        }
      }
    }
  }
}
"""

_SET_FIELD = """
mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: $value
  }) {
    projectV2Item { id }
  }
}
"""

_GET_ITEMS = """
query($projectId: ID!, $cursor: String) {
  node(id: $projectId) {
    ... on ProjectV2 {
      items(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          content {
            ... on Issue {
              number title state
              repository { nameWithOwner }
            }
          }
          fieldValues(first: 20) {
            nodes {
              ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2Field { name } } }
              ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2Field { name } } }
              ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { name } } }
              ... on ProjectV2ItemFieldIterationValue { title field { ... on ProjectV2IterationField { name } } }
            }
          }
        }
      }
    }
  }
}
"""

_GET_SINGLE_ITEM = """
query($itemId: ID!) {
  node(id: $itemId) {
    ... on ProjectV2Item {
      id
      content {
        ... on Issue { number title state repository { nameWithOwner } }
      }
      fieldValues(first: 20) {
        nodes {
          ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2Field { name } } }
          ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2Field { name } } }
          ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { name } } }
          ... on ProjectV2ItemFieldIterationValue { title field { ... on ProjectV2IterationField { name } } }
        }
      }
    }
  }
}
"""

_ISSUE_PROJECT_ITEMS = """
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      id
      projectItems(first: 10) {
        nodes { id project { id title } }
      }
    }
  }
}
"""


# ── Public API ─────────────────────────────────────────────────────────


def find_project(org: str, name: str) -> dict:
    """Find a project by name in an org. Returns {id, title, number}."""
    data = github_app.graphql(_FIND_PROJECT, variables={"org": org, "first": 50})
    for node in data["organization"]["projectsV2"]["nodes"]:
        if node["title"] == name:
            return node
    raise ValueError(f"Project '{name}' not found in org '{org}'")


def add_issue_to_project(project_id: str, issue_node_id: str) -> str:
    """Add an issue to a project. Returns the project item ID."""
    data = github_app.graphql(
        _ADD_ITEM,
        variables={"projectId": project_id, "contentId": issue_node_id},
    )
    time.sleep(MUTATION_DELAY)
    return data["addProjectV2ItemById"]["item"]["id"]


def get_field_ids(project_id: str, *, refresh: bool = False) -> dict[str, dict[str, Any]]:
    """Get field definitions for a project. Cached per project_id.

    Returns: {field_name: {id, type, options: {option_name: option_id}}}
    """
    if not refresh and project_id in _field_cache:
        return _field_cache[project_id]

    data = github_app.graphql(_GET_FIELD_IDS, variables={"projectId": project_id})
    fields: dict[str, dict[str, Any]] = {}
    for node in data["node"]["fields"]["nodes"]:
        name = node.get("name")
        if not name:
            continue
        entry: dict[str, Any] = {"id": node["id"], "type": node.get("dataType")}
        if "options" in node:
            entry["options"] = {opt["name"]: opt["id"] for opt in node["options"]}
        fields[name] = entry

    _field_cache[project_id] = fields
    return fields


def set_field(project_id: str, item_id: str, field_name: str, value: Any) -> None:
    """Set a custom field on a project item.

    Resolves field/option IDs automatically from cache.
    Raises RuntimeError on GraphQL failure (fail-closed for mutations).
    Raises ValueError if field or option not found.
    """
    fields = get_field_ids(project_id)
    field = fields.get(field_name)
    if not field:
        raise ValueError(
            f"Field '{field_name}' not found. Available: {list(fields.keys())}"
        )

    field_id = field["id"]
    field_type = field.get("type")

    if field_type == "SINGLE_SELECT":
        options = field.get("options", {})
        option_id = options.get(value)
        if not option_id:
            raise ValueError(
                f"Option '{value}' not found for '{field_name}'. "
                f"Available: {list(options.keys())}"
            )
        gql_value = {"singleSelectOptionId": option_id}
    elif field_type == "NUMBER":
        gql_value = {"number": float(value)}
    elif field_type == "TEXT":
        gql_value = {"text": str(value)}
    elif field_type == "ITERATION":
        gql_value = {"iterationId": str(value)}
    else:
        gql_value = {"text": str(value)}

    github_app.graphql(
        _SET_FIELD,
        variables={
            "projectId": project_id,
            "itemId": item_id,
            "fieldId": field_id,
            "value": gql_value,
        },
    )
    time.sleep(MUTATION_DELAY)


def set_fields(project_id: str, item_id: str, fields: dict[str, Any]) -> None:
    """Set multiple fields on a project item. 100ms delay between calls."""
    for name, value in fields.items():
        set_field(project_id, item_id, name, value)


def get_item_fields(item_id: str) -> dict[str, Any]:
    """Get field values for a single project item (by item ID).

    Returns: {field_name: value}. More efficient than get_items() for single lookups.
    """
    data = github_app.graphql(_GET_SINGLE_ITEM, variables={"itemId": item_id})
    node = data["node"]
    fields: dict[str, Any] = {}
    for fv in (node.get("fieldValues") or {}).get("nodes", []):
        fname = (fv.get("field") or {}).get("name")
        if fname:
            for key in ("text", "name", "number", "title"):
                val = fv.get(key)
                if val is not None:
                    fields[fname] = val
                    break
    return fields


def get_items(project_id: str, **filters: Any) -> list[dict]:
    """Get items from a project with optional client-side filtering.

    Filters are applied in Python (GitHub API has no server-side field filtering).
    Returns list of {item_id, issue_number, title, repo, state, fields}.
    """
    all_items: list[dict] = []
    cursor = None

    while True:
        data = github_app.graphql(
            _GET_ITEMS,
            variables={"projectId": project_id, "cursor": cursor},
        )
        page = data["node"]["items"]

        for node in page["nodes"]:
            content = node.get("content") or {}
            fields: dict[str, Any] = {}
            for fv in (node.get("fieldValues") or {}).get("nodes", []):
                fname = (fv.get("field") or {}).get("name")
                if fname:
                    for key in ("text", "name", "number", "title"):
                        val = fv.get(key)
                        if val is not None:
                            fields[fname] = val
                            break
            all_items.append({
                "item_id": node["id"],
                "issue_number": content.get("number"),
                "title": content.get("title"),
                "repo": (content.get("repository") or {}).get("nameWithOwner"),
                "state": content.get("state"),
                "fields": fields,
            })

        if not page["pageInfo"]["hasNextPage"]:
            break
        cursor = page["pageInfo"]["endCursor"]

    if not filters:
        return all_items

    filtered = []
    for item in all_items:
        match = True
        for key, val in filters.items():
            item_val = item["fields"].get(key)
            if isinstance(val, (list, tuple, set)):
                if item_val not in val:
                    match = False
            elif item_val != val:
                match = False
        if match:
            filtered.append(item)
    return filtered


def find_item_for_issue(
    org: str, repo: str, issue_number: int, project_id: str
) -> str | None:
    """Find the project item ID for an issue. Returns None if not in project."""
    data = github_app.graphql(
        _ISSUE_PROJECT_ITEMS,
        variables={"owner": org, "repo": repo, "number": issue_number},
    )
    items = data["repository"]["issue"]["projectItems"]["nodes"]
    for item in items:
        if item["project"]["id"] == project_id:
            return item["id"]
    return None


def get_issue_node_id(org: str, repo: str, issue_number: int) -> str:
    """Get the GraphQL node ID for an issue."""
    data = github_app.graphql(
        _ISSUE_PROJECT_ITEMS,
        variables={"owner": org, "repo": repo, "number": issue_number},
    )
    return data["repository"]["issue"]["id"]


def transition_status(
    project_id: str,
    item_id: str,
    new_status: str,
    *,
    validate: bool = True,
) -> bool:
    """Transition an item's Status field.

    If validate=True, reads current status (single-item query, not full list)
    and checks legality. Returns True if transitioned, False if already in
    target status (idempotent).

    Raises ValueError on illegal transition.
    Raises RuntimeError on GraphQL failure (fail-closed).
    """
    if validate:
        current_fields = get_item_fields(item_id)
        current_status = current_fields.get("Status")

        if current_status == new_status:
            return False

        if current_status and not is_legal_transition(current_status, new_status):
            raise ValueError(
                f"Illegal transition: {current_status} → {new_status}"
            )

    set_field(project_id, item_id, "Status", new_status)
    return True


def is_legal_transition(from_status: str, to_status: str) -> bool:
    """Check if a status transition is legal per the state machine."""
    allowed = LEGAL_TRANSITIONS.get(from_status, set())
    return to_status in allowed


def check_spec_completeness(item_fields: dict[str, Any]) -> tuple[bool, list[str]]:
    """Validate spec completeness gate.

    Returns (passed, list_of_missing_fields).
    Checks: AI Suitability set, Risk set, Status prerequisites.
    Note: issue body field checks (objective, scope, acceptance criteria)
    must be done by the caller since they require issue body parsing.
    """
    missing = []
    if not item_fields.get("Risk"):
        missing.append("Risk")
    if not item_fields.get("AI Suitability"):
        missing.append("AI Suitability")
    risk = item_fields.get("Risk", "")
    if risk in ("high",) and item_fields.get("Spec Approval") != "approved":
        missing.append("Spec Approval (required for high-risk)")
    return len(missing) == 0, missing


def load_project_config(repo_root: str = ".") -> dict | None:
    """Load .github/project-config.json. Returns None if not found."""
    config_path = Path(repo_root) / ".github" / "project-config.json"
    if not config_path.exists():
        log.warning("No project config at %s", config_path)
        return None
    return json.loads(config_path.read_text())
