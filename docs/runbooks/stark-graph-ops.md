# stark-graph Operations Runbook

This runbook covers the rollout controls and common failure modes for the `stark-graph` CI pipeline. All commands are copy-paste ready. Replace the repo name if you are operating on a deployment target other than `GetEvinced/stark-showcase`.

## Quick Checks

Print the current local graph config:

```bash
python3 - <<'PY'
import json
from pathlib import Path

config = json.loads(Path("global/config.json").read_text())
for key in (
    "graph_gate_mode",
    "graph_max_parse_workers",
    "graph_coverage_threshold",
    "graph_enriched_domains",
):
    print(f"{key}={config.get(key)}")
PY
```

Print the current GitHub Actions rollout variables:

```bash
gh variable list --repo GetEvinced/stark-showcase | rg '^STARK_GRAPH_'
```

## Failure Modes

### Graph gate blocks all reviews

Kill-switch the local orchestrator gate:

```bash
python3 - <<'PY'
import json
from pathlib import Path

path = Path("global/config.json")
config = json.loads(path.read_text())
config["graph_gate_mode"] = "disabled"
path.write_text(json.dumps(config, indent=2) + "\n")
print("graph_gate_mode=disabled")
PY
```

If the CI workflow itself is blocking because strict mode is enabled, drop back to warn mode immediately:

```bash
gh variable set STARK_GRAPH_STRICT --repo GetEvinced/stark-showcase --body false
```

Verify the change:

```bash
gh variable get STARK_GRAPH_STRICT --repo GetEvinced/stark-showcase
```

### Comment posting fails

Check whether the GitHub App credentials are present in the runner environment:

```bash
python3 - <<'PY'
import os
for key in ("STARK_APP_ID", "STARK_INSTALL_ID", "STARK_PRIVATE_KEY_B64"):
    print(f"{key}={'set' if os.environ.get(key) else 'missing'}")
PY
```

Run the same auth canary the scheduled audit uses:

```bash
python3 - <<'PY'
import sys
from pathlib import Path

sys.path.insert(0, str(Path("scripts").resolve()))
import github_app

token = github_app.get_token()
print(f"token_length={len(token)}")
PY
```

Check GitHub API rate limits:

```bash
gh api rate_limit --jq '.resources.core'
```

If the token canary fails, rotate the App credentials using the procedure below. If rate limits are exhausted, wait for reset or temporarily disable comment posting by skipping the comment job in the deployment repo until quota recovers.

### Worktree creation fails

Prune stale worktrees and retry:

```bash
git worktree prune
find .stark-graph -type d -name worktrees -prune -print
```

If a specific orphaned worktree path is stuck, remove it forcibly:

```bash
git worktree list
git worktree remove --force .stark-graph/pr-123/worktrees/abcdef123456
git worktree prune
```

### Parse timeout

Increase the parser worker limit in local config:

```bash
python3 - <<'PY'
import json
from pathlib import Path

path = Path("global/config.json")
config = json.loads(path.read_text())
config["graph_max_parse_workers"] = 2
path.write_text(json.dumps(config, indent=2) + "\n")
print(f"graph_max_parse_workers={config['graph_max_parse_workers']}")
PY
```

Re-run the graph validator locally:

```bash
scripts/.venv/bin/python3 scripts/stark_graph.py --repo . --repo-name GetEvinced/stark-skills --stage validate --warn
```

### False-positive rate spike

Move CI back to warn mode immediately:

```bash
gh variable set STARK_GRAPH_STRICT --repo GetEvinced/stark-showcase --body false
```

Confirm the variable and trigger a rerun:

```bash
gh variable get STARK_GRAPH_STRICT --repo GetEvinced/stark-showcase
gh run list --repo GetEvinced/stark-showcase --workflow graph-review.yml --limit 5
```

If you need to stop the local review gate as well:

```bash
python3 - <<'PY'
import json
from pathlib import Path

path = Path("global/config.json")
config = json.loads(path.read_text())
config["graph_gate_mode"] = "disabled"
path.write_text(json.dumps(config, indent=2) + "\n")
print("graph_gate_mode=disabled")
PY
```

## Credential Rotation

Generate a fresh base64 payload from the GitHub App private key PEM:

```bash
base64 < stark-codex.private-key.pem | tr -d '\n'
```

Update the deployment repo secrets:

```bash
gh secret set STARK_PRIVATE_KEY_B64 --repo GetEvinced/stark-showcase < <(base64 < stark-codex.private-key.pem | tr -d '\n')
gh secret set STARK_APP_ID --repo GetEvinced/stark-showcase --body '3066834'
gh secret set STARK_INSTALL_ID --repo GetEvinced/stark-showcase --body '115648800'
```

Validate the rotated credentials with an installation-token canary:

```bash
STARK_APP_ID='3066834' \
STARK_INSTALL_ID='115648800' \
STARK_PRIVATE_KEY_B64="$(base64 < stark-codex.private-key.pem | tr -d '\n')" \
python3 - <<'PY'
import sys
from pathlib import Path

sys.path.insert(0, str(Path("scripts").resolve()))
import github_app

print(bool(github_app.get_token()))
PY
```

## Key Extraction For CI

Print the exact key material needed by the CI workflow:

```bash
printf 'STARK_APP_ID=%s\n' '3066834'
printf 'STARK_INSTALL_ID=%s\n' '115648800'
printf 'STARK_PRIVATE_KEY_B64=%s\n' "$(base64 < stark-codex.private-key.pem | tr -d '\n')"
```

Load the values into GitHub Actions:

```bash
gh secret set STARK_APP_ID --repo GetEvinced/stark-showcase --body '3066834'
gh secret set STARK_INSTALL_ID --repo GetEvinced/stark-showcase --body '115648800'
gh secret set STARK_PRIVATE_KEY_B64 --repo GetEvinced/stark-showcase < <(base64 < stark-codex.private-key.pem | tr -d '\n')
```

## Coverage Tracking Issue

If the weekly audit opens or updates a coverage issue, inspect the latest artifact first:

```bash
gh run list --repo GetEvinced/stark-showcase --workflow graph-audit.yml --limit 5
gh run download --repo GetEvinced/stark-showcase <run-id> -D /tmp/graph-audit
ls -R /tmp/graph-audit
```

Only disable strict mode after confirming the issue is real:

```bash
gh variable set STARK_GRAPH_STRICT --repo GetEvinced/stark-showcase --body false
```
