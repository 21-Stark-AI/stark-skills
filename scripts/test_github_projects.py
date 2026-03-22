"""Tests for graphql() function in github_app.py."""

from __future__ import annotations

import unittest
from unittest.mock import MagicMock, patch

import github_app


class TestGraphQL(unittest.TestCase):
    """Tests for github_app.graphql()."""

    @patch("github_app._headers", return_value={"Authorization": "Bearer fake", "Accept": "application/vnd.github+json"})
    @patch("github_app.requests.post")
    def test_sends_post_to_graphql_endpoint(self, mock_post: MagicMock, mock_headers: MagicMock) -> None:
        """graphql() POSTs to /graphql with correct headers and query body."""
        mock_post.return_value = MagicMock(status_code=200, json=lambda: {"data": {"viewer": {"login": "bot"}}})

        result = github_app.graphql("{ viewer { login } }")

        mock_post.assert_called_once_with(
            "https://api.github.com/graphql",
            headers={"Authorization": "Bearer fake", "Accept": "application/vnd.github+json"},
            json={"query": "{ viewer { login } }"},
            timeout=30,
        )
        self.assertEqual(result, {"data": {"viewer": {"login": "bot"}}})
        mock_headers.assert_called_once()

    @patch("github_app._headers", return_value={"Authorization": "Bearer fake", "Accept": "application/vnd.github+json"})
    @patch("github_app.requests.post")
    def test_raises_on_graphql_errors(self, mock_post: MagicMock, _mock_headers: MagicMock) -> None:
        """graphql() raises RuntimeError when response contains 'errors' key."""
        mock_post.return_value = MagicMock(
            status_code=200,
            json=lambda: {"errors": [{"message": "Field 'foo' not found"}]},
        )

        with self.assertRaises(RuntimeError) as ctx:
            github_app.graphql("{ bad }")

        self.assertIn("Field 'foo' not found", str(ctx.exception))

    @patch("github_app._headers", return_value={"Authorization": "Bearer fake", "Accept": "application/vnd.github+json"})
    @patch("github_app.requests.post")
    def test_includes_variables_in_body(self, mock_post: MagicMock, _mock_headers: MagicMock) -> None:
        """graphql() includes variables dict in request body when provided."""
        mock_post.return_value = MagicMock(status_code=200, json=lambda: {"data": {"node": {"id": "123"}}})

        github_app.graphql("query($id: ID!) { node(id: $id) { id } }", variables={"id": "123"})

        call_kwargs = mock_post.call_args[1]
        self.assertEqual(call_kwargs["json"]["variables"], {"id": "123"})

    @patch("github_app._headers", return_value={"Authorization": "Bearer fake", "Accept": "application/vnd.github+json"})
    @patch("github_app.requests.post")
    def test_retries_once_on_connection_error(self, mock_post: MagicMock, _mock_headers: MagicMock) -> None:
        """graphql() retries once on ConnectionError, then succeeds."""
        mock_post.side_effect = [
            ConnectionError("connection reset"),
            MagicMock(status_code=200, json=lambda: {"data": {"ok": True}}),
        ]

        result = github_app.graphql("{ viewer { login } }")

        self.assertEqual(mock_post.call_count, 2)
        self.assertEqual(result, {"data": {"ok": True}})

    @patch("github_app._headers", return_value={"Authorization": "Bearer fake", "Accept": "application/vnd.github+json"})
    @patch("github_app.requests.post")
    def test_raises_after_retry_exhausted(self, mock_post: MagicMock, _mock_headers: MagicMock) -> None:
        """graphql() raises ConnectionError after retry is exhausted."""
        mock_post.side_effect = [
            ConnectionError("first"),
            ConnectionError("second"),
        ]

        with self.assertRaises(ConnectionError):
            github_app.graphql("{ viewer { login } }")

        self.assertEqual(mock_post.call_count, 2)

    @patch("github_app._headers", return_value={"Authorization": "Bearer fake", "Accept": "application/vnd.github+json"})
    @patch("github_app.requests.post")
    def test_retry_false_disables_retry(self, mock_post: MagicMock, _mock_headers: MagicMock) -> None:
        """graphql(retry=False) does not retry on ConnectionError."""
        mock_post.side_effect = ConnectionError("no retry")

        with self.assertRaises(ConnectionError):
            github_app.graphql("{ viewer { login } }", retry=False)

        self.assertEqual(mock_post.call_count, 1)


if __name__ == "__main__":
    unittest.main()
