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
