"""End-to-end integration tests for GitHub Projects V2.

Requires real GitHub API access via stark-claude app.
Run manually: RUN_INTEGRATION=1 pytest scripts/test_github_projects_e2e.py -v -s

These tests verify the GraphQL operations work against the real GitHub API.
They require a test project to exist (create with setup_project.py first).
"""
import os
import pytest
import sys

sys.path.insert(0, os.path.dirname(__file__))

pytestmark = pytest.mark.skipif(
    os.environ.get("RUN_INTEGRATION") != "1",
    reason="Set RUN_INTEGRATION=1 to run integration tests",
)

TEST_ORG = "GetEvinced"
TEST_PROJECT = "Integration Test Board"


class TestProjectDiscovery:
    def test_find_project(self):
        import github_app
        import github_projects

        github_app.select_app("stark-claude")
        try:
            project = github_projects.find_project(TEST_ORG, TEST_PROJECT)
            assert project["id"]
            assert project["title"] == TEST_PROJECT
            print(f"Found project: {project['title']} (ID: {project['id']})")
        except ValueError:
            pytest.skip(f"Test project '{TEST_PROJECT}' not found — run setup_project.py first")

    def test_find_project_not_found(self):
        import github_app
        import github_projects

        github_app.select_app("stark-claude")
        with pytest.raises(ValueError, match="not found"):
            github_projects.find_project(TEST_ORG, "Nonexistent Project 12345")


class TestFieldCache:
    def test_get_field_ids(self):
        import github_app
        import github_projects

        github_app.select_app("stark-claude")
        try:
            project = github_projects.find_project(TEST_ORG, TEST_PROJECT)
        except ValueError:
            pytest.skip("Test project not found")

        fields = github_projects.get_field_ids(project["id"])
        assert "Status" in fields
        assert "options" in fields["Status"]
        assert "backlog" in fields["Status"]["options"]
        print(f"Fields: {list(fields.keys())}")


class TestLegalTransitions:
    """These don't need API access but verify the state machine is consistent."""

    def test_all_states_have_at_least_one_outgoing_transition(self):
        import github_projects
        for state in github_projects.LEGAL_TRANSITIONS:
            assert len(github_projects.LEGAL_TRANSITIONS[state]) > 0, f"{state} has no outgoing transitions"

    def test_done_has_no_outgoing_transitions(self):
        import github_projects
        assert "done" not in github_projects.LEGAL_TRANSITIONS

    def test_blocked_can_return_to_any_active_state(self):
        import github_projects
        blocked_targets = github_projects.LEGAL_TRANSITIONS["blocked"]
        assert "backlog" in blocked_targets
        assert "needs spec" in blocked_targets
        assert "ready for agent" in blocked_targets
