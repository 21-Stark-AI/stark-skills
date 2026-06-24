# Terragrunt review checklist

The orchestration-layer failure catalog. Resource/module HCL is **not** here —
hand that to `stark-terraform-review`. Each item: what to look for, the
consequence, the fix shape.

---

## 1. Dependency blocks & the DAG  `high`

- ❌ **Circular dependency** (e.g. `vpc ↔ security_groups`). Confirm with
  `terragrunt find --dag --dependencies` / `terragrunt dag graph`.
- ❌ Unit **uses a dependency output but doesn't declare** the `dependency` block →
  ordering not enforced, races. ✅ Declare every consumed dependency.
- ❌ Missing `mock_outputs` → `plan`/`validate` fail when the dependency isn't
  applied yet. ✅
  ```hcl
  dependency "vpc" {
    config_path  = try(values.vpc_path, "../vpc")
    mock_outputs = { vpc_id = "vpc-mock", private_subnets = ["subnet-mock"] }
    mock_outputs_allowed_terraform_commands = ["validate", "plan"]
  }
  ```
- ❌ **Mock schema ≠ real outputs** (wrong keys/types) → green plan, red apply.
  ✅ Mocks mirror the dependency's actual output names/shapes.
- ❌ **Duplicate `dependency` names** (two blocks same label). ✅ One per name.
- ◐ `skip_outputs = true` / `enabled` not used where outputs aren't needed →
  slower plans. ✅ Prune with `skip_outputs` / conditional `enabled`.

## 2. State isolation  `critical`/`high`

- ❌ Same state **key** across units, or shared state across environments.
  ✅ `key = "${path_relative_to_include()}/terraform.tfstate"` — unique per unit.
- ❌ Same bucket for all envs/accounts. ✅ Per-env/account bucket suffix
  (`tfstate-${account}-${env}-${region}` via `env.hcl`).
- ❌ Missing locking on a shared/CI/prod backend. ✅ `use_lockfile = true`
  (OpenTofu/TF 1.10+) or `dynamodb_table` below that floor.
- ❌ **Terraform workspaces** (`terraform workspace select dev`) for env separation.
  ✅ Separate directories — Terragrunt's model is dir-per-env, not workspaces.

## 3. include hierarchy  `medium`/`high`

- ❌ Missing `include "root"` in a unit → no inherited backend/provider/inputs.
  ✅ `include "root" { path = find_in_parent_folders("root.hcl") }` at the top.
- ❌ Hardcoded parent path (`../../../root.hcl`). ✅ `find_in_parent_folders()`.
- ❌ Classic `_envcommon` pulled without `expose = true` when the child needs its
  locals. ✅ `include "envcommon" { path = ...; expose = true }`.
- ❌ Inputs merged in the wrong precedence. ✅ `inputs = merge(account, region,
  env)` via `read_terragrunt_config(find_in_parent_folders(...))`.
- Classic vs explicit: in a **classic** live repo check the root+envcommon chain;
  in an **explicit** catalog check that units carry no boilerplate and all config
  flows from the `*.stack.hcl`.

## 4. generate blocks  `critical`/`medium`

- ❌ `if_exists = "overwrite"` clobbering a hand-written file → silent loss.
  ✅ `if_exists = "overwrite_terragrunt"` (only overwrites Terragrunt-generated
  files) or `"skip"` to preserve manual edits.
- ❌ Heredoc inside a ternary without parens → parse error:
  `cond ? <<EOF ... EOF : ""`. ✅ wrap: `cond ? (<<EOF\n...\nEOF\n) : ""`.

## 5. Module source (git URL)  `high`/`medium`

- ❌ **Refspec before the `//path`**: `repo.git?ref=main//units/acm` → git refspec
  error. ✅ Refspec **after**: `repo.git//units/acm?ref=main`.
- ❌ Hardcoded `?ref=` instead of parameterized version. ✅ `?ref=${values.catalog_version}`
  (or module version via `values.version` through inputs).
- ◐ HTTP source URLs. ✅ SSH (`git::git@github.com:ORG/...`) — easier CI auth, safer.

## 6. DRY values pattern  `medium`

- ❌ Hardcoded inputs in a unit instead of `values.*`. ✅ All inputs flow through
  the stack's `values = { ... }` → unit reads `values.key`.
- ❌ Optional input read without a default → error when unset. ✅ `try(values.key,
  default)`.
- ❌ Reference not resolved: `values.acm_arn == "../acm"` left literal. ✅ resolve
  to `dependency.acm.outputs.acm_certificate_arn`.
- ◐ Catalog `source` not versionable (no `?ref`). ✅ parameterize the catalog version.

## 7. Stacks (`terragrunt.stack.hcl`)  `high`/`medium`

- ❌ `terraform { source = ... }` inside a stack file → invalid; stacks declare
  **`unit`** blocks. ✅
  ```hcl
  unit "service" {
    source = "git::...//units/service?ref=${values.catalog_version}"
    path   = "service"            # unique per unit
    values = { name = "my-service", version = "v1.0.0" }
  }
  ```
- ❌ Duplicate `path` across units in a stack. ✅ Unique paths.
- ❌ Circular references among stack units (DAG violation).

## 8. Targeting / run flags  `low`/`medium`

- ◐ Deprecated `--queue-include-dir` / `--queue-exclude-dir`. ✅ Modern `--filter`
  (`--filter '.terragrunt-stack/rds'`, `...api...` for deps, `[main...HEAD]` for
  changed-since-git).

---

## Quick verdict matrix

| Signal | Severity |
|--------|----------|
| Shared state key across envs, no lock on shared backend, `generate` overwriting hand-written files | critical |
| Circular dep, missing/ mismatched `mock_outputs`, undeclared-but-used dependency, git refspec order bug | high |
| Hardcoded inputs/parent paths, duplicate dependency names, DynamoDB lock when use_lockfile available, deprecated `--queue-*` | medium |
| Missing `try()`, naming, skip_outputs opportunity, unversioned catalog source | low |
