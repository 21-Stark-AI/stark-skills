# rename-project Skill Design

## Overview

Shell-based skill that renames a project both locally and on GitHub, then propagates the name change across sibling repos and reinstalls symlinks.

## Inputs

Two positional arguments: `<old-name> <new-name>` (e.g., `stark-review stark-skills`).

Context is inferred: org from git remote, sibling repos from parent directory.

## Execution Sequence

### Step 1: Validate

- Confirm current directory is the project being renamed (git remote matches `old-name`)
- Confirm no uncommitted changes in target project
- Confirm `new-name` doesn't already exist locally as a sibling directory
- Confirm `new-name` doesn't already exist on GitHub (API check)
- Scan sibling repos for uncommitted changes — refuse if any modified repo contains references to old name

### Step 2: GitHub Rename

- Call GitHub API via `github_app.py`: `PATCH /repos/{org}/{old-name}` with `{"name": "new-name"}`
- GitHub automatically creates a redirect from old URL to new URL

### Step 3: Update Git Remote

- `git remote set-url origin` to new repo URL (both SSH and HTTPS patterns)

### Step 4: Rename Local Directory

- `mv {parent}/{old-name} {parent}/{new-name}`
- Note: caller's cwd becomes invalid — skill must inform user to `cd` to new path

### Step 5: Self-Update

Grep-and-replace within the renamed project for path/repo references:

- `~/git/Evinced/{old-name}` → `~/git/Evinced/{new-name}` (and any parent path variations)
- `GetEvinced/{old-name}` → `GetEvinced/{new-name}`
- `github.com:GetEvinced/{old-name}` → `github.com:GetEvinced/{new-name}`
- `github.com/GetEvinced/{old-name}` → `github.com/GetEvinced/{new-name}`
- Title/header references like `# CLAUDE.md — {old-name}` → `# CLAUDE.md — {new-name}`

**Excluded from replacement:**
- Skill `name:` frontmatter fields
- Skill invocation names (e.g., `/stark-review`)
- GitHub App names (`stark-claude`, `stark-codex`, `stark-gemini`)
- Historical document filenames (e.g., `2026-03-16-stark-review-skill-design.md`)
- Content inside `.git/` directory

### Step 6: Cross-Repo Update

- Discover sibling repos: all directories under the same parent that contain a `.git/` subdirectory
- For each sibling repo, search text files for references to `old-name` in path/repo contexts
- Apply the same replacement patterns as Step 5
- Skip: `.git/`, `node_modules/`, `.venv/`, `__pycache__/`, binary files
- Track every file modified for the summary

### Step 7: Reinstall

- Run `install.sh` from the new project location to recreate symlinks
- If install.sh doesn't exist or fails, report the error but don't rollback

### Step 8: Summary

- List every file changed, grouped by repo
- Remind user to `cd` to the new directory path
- Note that GitHub redirects are in place for old URLs

## Replacement Rules

| Pattern | Replace? | Reason |
|---------|----------|--------|
| Folder paths containing old name | Yes | Paths must resolve |
| GitHub repo references (`org/name`) | Yes | API/clone URLs must work |
| Git clone/remote URLs | Yes | Git operations must work |
| Skill `name:` frontmatter | No | Skill identity preserved |
| Skill invocation names in text | No | User muscle memory preserved |
| GitHub App names | No | Independent of project name |
| Historical doc filenames | No | Historical record preserved |

## Edge Cases

- **cwd invalidation** — After `mv`, the shell's working directory is gone. Skill prints a clear message telling the user to `cd` to the new path.
- **Uncommitted changes** — Skill refuses to run if target project or affected sibling repos have uncommitted changes.
- **install.sh failure** — Reported but not rolled back. The GitHub rename and local rename are already done; partial failure is better than a complex rollback that could leave things worse.
- **Org detection** — Parsed from `git remote get-url origin`. Supports both SSH (`git@github.com:Org/repo.git`) and HTTPS (`https://github.com/Org/repo.git`) formats.
- **Parent directory detection** — `dirname` of the current project path. Only sibling directories (same parent) are scanned.

## What This Skill Does NOT Do

- Rename skills or their invocation commands
- Update CI/CD pipelines, GitHub Actions, or external systems
- Handle repos outside the parent directory
- Rename GitHub Apps or their credentials
- Modify binary files
- Create backups (git history serves as the backup)
