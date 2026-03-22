import pytest
from unittest.mock import patch, MagicMock
import sys
import os
import requests

sys.path.insert(0, os.path.dirname(__file__))


class TestGraphQL:
    @patch("github_app.requests.post")
    @patch("github_app.get_token", return_value="test-token")
    def test_graphql_sends_post_to_graphql_endpoint(self, mock_token, mock_post):
        mock_post.return_value = MagicMock(
            status_code=200,
            json=lambda: {"data": {"viewer": {"login": "test"}}},
            raise_for_status=lambda: None,
        )
        import github_app
        result = github_app.graphql("query { viewer { login } }")
        mock_post.assert_called_once()
        call_args = mock_post.call_args
        assert call_args[0][0] == "https://api.github.com/graphql"
        assert call_args[1]["json"] == {"query": "query { viewer { login } }"}
        assert result == {"viewer": {"login": "test"}}

    @patch("github_app.requests.post")
    @patch("github_app.get_token", return_value="test-token")
    def test_graphql_raises_on_errors(self, mock_token, mock_post):
        mock_post.return_value = MagicMock(
            status_code=200,
            json=lambda: {"errors": [{"message": "bad query"}]},
            raise_for_status=lambda: None,
        )
        import github_app
        with pytest.raises(RuntimeError, match="bad query"):
            github_app.graphql("query { bad }")

    @patch("github_app.requests.post")
    @patch("github_app.get_token", return_value="test-token")
    def test_graphql_passes_variables(self, mock_token, mock_post):
        mock_post.return_value = MagicMock(
            status_code=200,
            json=lambda: {"data": {"node": {"id": "123"}}},
            raise_for_status=lambda: None,
        )
        import github_app
        github_app.graphql("query($id: ID!) { node(id: $id) { id } }", variables={"id": "123"})
        call_args = mock_post.call_args
        assert call_args[1]["json"]["variables"] == {"id": "123"}

    @patch("github_app.requests.post")
    @patch("github_app.get_token", return_value="test-token")
    def test_graphql_retries_once_on_connection_error(self, mock_token, mock_post):
        mock_post.side_effect = [
            requests.exceptions.ConnectionError("timeout"),
            MagicMock(
                status_code=200,
                json=lambda: {"data": {"ok": True}},
                raise_for_status=lambda: None,
            ),
        ]
        import github_app
        result = github_app.graphql("query { ok }")
        assert result == {"ok": True}
        assert mock_post.call_count == 2


import github_projects


class TestFindProject:
    @patch("github_app.graphql")
    def test_find_project_by_name(self, mock_gql):
        mock_gql.return_value = {
            "organization": {
                "projectsV2": {
                    "nodes": [
                        {"id": "PVT_1", "title": "Platform Board", "number": 1}
                    ]
                }
            }
        }
        result = github_projects.find_project("GetEvinced", "Platform Board")
        assert result["id"] == "PVT_1"

    @patch("github_app.graphql")
    def test_find_project_not_found_raises(self, mock_gql):
        mock_gql.return_value = {
            "organization": {"projectsV2": {"nodes": []}}
        }
        with pytest.raises(ValueError, match="not found"):
            github_projects.find_project("GetEvinced", "Nonexistent")


class TestAddIssueToProject:
    @patch("github_app.graphql")
    def test_add_issue_returns_item_id(self, mock_gql):
        mock_gql.return_value = {
            "addProjectV2ItemById": {"item": {"id": "PVTI_123"}}
        }
        item_id = github_projects.add_issue_to_project("PVT_1", "I_456")
        assert item_id == "PVTI_123"


class TestSetField:
    @patch("github_app.graphql")
    def test_set_single_select_field(self, mock_gql):
        mock_gql.side_effect = [
            # get_field_ids
            {"node": {"fields": {"nodes": [
                {"id": "F_1", "name": "Status", "dataType": "SINGLE_SELECT",
                 "options": [{"id": "O_1", "name": "backlog"}, {"id": "O_2", "name": "done"}]}
            ]}}},
            # set_field
            {"updateProjectV2ItemFieldValue": {"projectV2Item": {"id": "PVTI_1"}}},
        ]
        github_projects._field_cache.clear()
        github_projects.set_field("PVT_1", "PVTI_1", "Status", "done")
        set_call = mock_gql.call_args_list[1]
        assert set_call[1]["variables"]["value"] == {"singleSelectOptionId": "O_2"}

    @patch("github_app.graphql")
    def test_set_number_field(self, mock_gql):
        mock_gql.side_effect = [
            {"node": {"fields": {"nodes": [
                {"id": "F_2", "name": "Story Points", "dataType": "NUMBER"}
            ]}}},
            {"updateProjectV2ItemFieldValue": {"projectV2Item": {"id": "PVTI_1"}}},
        ]
        github_projects._field_cache.clear()
        github_projects.set_field("PVT_1", "PVTI_1", "Story Points", 5)
        set_call = mock_gql.call_args_list[1]
        assert set_call[1]["variables"]["value"] == {"number": 5.0}

    @patch("github_app.graphql")
    def test_set_invalid_option_raises(self, mock_gql):
        mock_gql.return_value = {"node": {"fields": {"nodes": [
            {"id": "F_1", "name": "Status", "dataType": "SINGLE_SELECT",
             "options": [{"id": "O_1", "name": "backlog"}]}
        ]}}}
        github_projects._field_cache.clear()
        with pytest.raises(ValueError, match="not found for"):
            github_projects.set_field("PVT_1", "PVTI_1", "Status", "nonexistent")

    @patch("github_app.graphql")
    def test_set_field_mutation_failure_raises(self, mock_gql):
        mock_gql.side_effect = [
            {"node": {"fields": {"nodes": [
                {"id": "F_1", "name": "Status", "dataType": "SINGLE_SELECT",
                 "options": [{"id": "O_1", "name": "backlog"}]}
            ]}}},
            RuntimeError("GraphQL error: mutation failed"),
        ]
        github_projects._field_cache.clear()
        with pytest.raises(RuntimeError):
            github_projects.set_field("PVT_1", "PVTI_1", "Status", "backlog")


class TestTransitionStatus:
    @patch("github_app.graphql")
    def test_legal_transition(self, mock_gql):
        mock_gql.side_effect = [
            # get_item_fields
            {"node": {"id": "PVTI_1", "content": {}, "fieldValues": {"nodes": [
                {"field": {"name": "Status"}, "name": "ready for agent"}
            ]}}},
            # get_field_ids (for set_field)
            {"node": {"fields": {"nodes": [
                {"id": "F_1", "name": "Status", "dataType": "SINGLE_SELECT",
                 "options": [{"id": "O_1", "name": "ready for agent"}, {"id": "O_2", "name": "agent working"}]}
            ]}}},
            # set_field mutation
            {"updateProjectV2ItemFieldValue": {"projectV2Item": {"id": "PVTI_1"}}},
        ]
        github_projects._field_cache.clear()
        result = github_projects.transition_status("PVT_1", "PVTI_1", "agent working")
        assert result is True

    @patch("github_app.graphql")
    def test_idempotent_noop(self, mock_gql):
        mock_gql.return_value = {"node": {"id": "PVTI_1", "content": {}, "fieldValues": {"nodes": [
            {"field": {"name": "Status"}, "name": "agent working"}
        ]}}}
        result = github_projects.transition_status("PVT_1", "PVTI_1", "agent working")
        assert result is False

    @patch("github_app.graphql")
    def test_illegal_transition_raises(self, mock_gql):
        mock_gql.return_value = {"node": {"id": "PVTI_1", "content": {}, "fieldValues": {"nodes": [
            {"field": {"name": "Status"}, "name": "backlog"}
        ]}}}
        with pytest.raises(ValueError, match="Illegal transition"):
            github_projects.transition_status("PVT_1", "PVTI_1", "done")


class TestIsLegalTransition:
    @pytest.mark.parametrize("from_s,to_s,expected", [
        ("backlog", "needs spec", True),
        ("backlog", "done", False),
        ("needs spec", "ready for agent", True),
        ("needs spec", "human working", True),
        ("ready for agent", "agent working", True),
        ("agent working", "human review", True),
        ("agent working", "needs clarification", True),
        ("human working", "human review", True),
        ("human review", "ready to merge", True),
        ("human review", "agent working", True),
        ("human review", "human working", True),
        ("ready to merge", "ready to release", True),
        ("ready to release", "done", True),
        ("blocked", "backlog", True),
        ("blocked", "ready for agent", True),
        ("done", "backlog", False),
    ])
    def test_transitions(self, from_s, to_s, expected):
        assert github_projects.is_legal_transition(from_s, to_s) == expected


class TestSpecCompleteness:
    def test_passes_with_all_fields(self):
        fields = {"Risk": "medium", "AI Suitability": "autonomous"}
        ok, missing = github_projects.check_spec_completeness(fields)
        assert ok is True
        assert missing == []

    def test_fails_missing_risk(self):
        fields = {"AI Suitability": "autonomous"}
        ok, missing = github_projects.check_spec_completeness(fields)
        assert ok is False
        assert "Risk" in missing

    def test_high_risk_requires_spec_approval(self):
        fields = {"Risk": "high", "AI Suitability": "autonomous"}
        ok, missing = github_projects.check_spec_completeness(fields)
        assert ok is False
        assert "Spec Approval" in missing[0]

    def test_high_risk_with_approval_passes(self):
        fields = {"Risk": "high", "AI Suitability": "autonomous", "Spec Approval": "approved"}
        ok, missing = github_projects.check_spec_completeness(fields)
        assert ok is True
