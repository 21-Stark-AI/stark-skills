# Terragrunt CLI checks

Run for **evidence** before the manual pass. Skip on `--no-tools` and say so.
Probe first:

```bash
command -v terragrunt >/dev/null 2>&1 && terragrunt --version || echo "missing: terragrunt"
command -v tofu >/dev/null 2>&1 || command -v terraform >/dev/null 2>&1 || echo "missing: tofu/terraform"
```

These are **read-only / offline** checks. Do **not** run `terragrunt apply`,
`run-all apply`, or anything that touches a real backend during review.

---

## Map the dependency graph (do this first)

```bash
terragrunt find --dag --dependencies --json     # units + edges, machine-readable
terragrunt list --tree                          # human tree of units/stacks
terragrunt dag graph | dot -Tsvg > dag.svg       # optional visual (needs graphviz)
```

Read for: **cycles**, orphan units, and edges that don't match the `dependency`
blocks you see in the HCL (declared-but-unused or used-but-undeclared).

## Validate HCL (offline)

```bash
terragrunt hcl validate                          # validates terragrunt HCL across the tree
terragrunt hcl fmt --check                        # formatting (low severity)
```

On older Terragrunt the subcommands are `terragrunt validate-inputs` /
`terragrunt hclfmt` — adapt to the installed version (check `--version`).

## Render / introspect a unit (offline)

```bash
terragrunt render --json                          # the fully-resolved config for one unit
                                                  # (older: `terragrunt terragrunt-info` / `render-json`)
```

Use the rendered config to confirm: the resolved `source`, the merged `inputs`,
the backend `key`, and that `dependency` mocks are wired — without running a plan.

## Changed-set targeting (for `--changed`)

```bash
terragrunt find --filter '[main...HEAD]' --json   # units affected since main
```

---

## Reading order

1. `find --dag --dependencies` → the graph. Cycles / undeclared edges are the
   highest-value Terragrunt-only findings.
2. `hcl validate` + `hcl fmt --check` → structural sanity.
3. `render --json` per suspicious unit → confirm resolution (source/inputs/key/mocks)
   without touching infra.
4. Manual pass (the checklist) → mock-schema match, state-key uniqueness, include
   chain, generate `if_exists`, refspec order, values/DRY.

> For the Terraform inside each unit (resources, variables, provider hardening),
> hand off to `stark-terraform-review` and its scanners (trivy/checkov/tflint).
