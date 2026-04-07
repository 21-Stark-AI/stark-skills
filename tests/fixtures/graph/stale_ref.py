"""Module with a stale internal dependency reference.

Depends: valid_module
"""

# Intentionally does NOT import valid_module — the docstring dep is stale.
