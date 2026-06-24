# Scope boundary: Terragrunt review vs Terraform review

Terragrunt wraps Terraform/OpenTofu. Keep the two reviews on their own layer so
findings don't double-count and nothing falls through the crack.

## stark-terragrunt-review owns (this skill)

The **orchestration / wiring** layer:

- `include` blocks, `find_in_parent_folders`, root/account/region/env hierarchy
- `dependency` blocks, `mock_outputs`, `skip_outputs`, `enabled`, the DAG, cycles
- `generate` blocks (`if_exists`, heredoc-in-ternary)
- `remote_state` config: backend key (`path_relative_to_include()`), per-env
  bucket isolation, `use_lockfile` vs DynamoDB
- The DRY **values pattern**: `values.*`, `try()`, reference resolution (`"../x"`)
- Module `source` URL syntax (refspec ordering, version parameterization, SSH)
- `terragrunt.stack.hcl` unit composition, unique paths
- `--filter` / targeting hygiene
- State **isolation** strategy (dir-per-env, no workspaces)

## stark-terraform-review owns (hand off)

The **resource / module** layer — the Terraform that lives inside each unit's
source module, and the generated `provider.tf`/`backend.tf` *contents*:

- `resource` / `data` definitions (`aws_*`, `azurerm_*`, `google_*`)
- Variable contracts (`type`, `description`, `validation`, `optional()`)
- Output contracts, `sensitive`, naming, file layout
- IAM least-privilege, security groups, encryption, public access
- `for_each` vs `count` and `moved` blocks **inside the module**
- Provider version pinning, `required_version`
- `.tftest.hcl` tests (plan-vs-apply mode, set indexing, mocks)

## Gray areas — call it explicitly

- **`inputs` / `values` values themselves:** *Terragrunt review* checks they flow
  through `values` + `try()` and resolve references. Whether a given value is
  *appropriate for the module* (right type, valid range) is the **module's**
  contract → Terraform review (or the module's own `validation`).
- **Generated `provider`/`backend` blocks:** the *`generate` mechanics*
  (`if_exists`, overwrite safety) are Terragrunt; the *provider hardening* inside
  the heredoc (assume-role, default tags, encryption) is Terraform.
- **State backend:** *Terragrunt* owns the key/isolation/lock wiring;
  *Terraform* owns whether the backend bucket itself is encrypted/versioned/private
  (if that bucket is also Terraform-managed).

## In the report

End the Terragrunt review with an explicit count:
`Terraform-layer items handed to stark-terraform-review: N` — and list them as
one-liners so nothing is silently dropped. If the user only ran this skill,
recommend running `stark-terraform-review` on the underlying modules.
