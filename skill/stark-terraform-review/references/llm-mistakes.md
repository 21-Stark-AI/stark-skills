# LLM-mistake scan list + version guard

Two jobs here:

1. **Scan list** — the specific errors models (and tired humans) make in
   hand-written Terraform. Use it as a checklist while reading the diff.
2. **Version guard** — never flag the *absence* of a feature the target's
   version floor can't use, and never *recommend* one it can't run. Wrong-version
   advice is the #1 reviewer false positive.

---

## Version → feature guard table

Detect the floor from `required_version` / `terraform.tf` (or the OpenTofu
equivalent) before applying any "you should use X" finding.

| Feature | Min version | If absent below floor |
|---------|-------------|------------------------|
| `moved {}` blocks (safe rename) | TF 1.1 / OpenTofu 1.6 | Don't demand `moved`; recommend `terraform state mv` with care |
| `nullable = false` on variables | TF 1.1 | — |
| `optional()` object attrs w/ defaults | TF 1.3 | Don't flag `map(any)` as fixable via `optional()` |
| `import {}` blocks + `-generate-config-out` | TF 1.5 | CLI `terraform import` only |
| `check {}` blocks (runtime assertions) | TF 1.5 | — |
| `removed {}` blocks | TF 1.7 | — |
| Native `terraform test` (`.tftest.hcl`) | TF 1.6 | Recommend Terratest instead |
| Mock providers in tests | TF 1.7 | No free PR tests; real infra only |
| S3 backend `use_lockfile` (native lock) | TF 1.10 / OpenTofu 1.10 | DynamoDB lock table is correct, not a smell |
| `write_only` (ephemeral) arguments | TF 1.11 | Use secret-manager data source pattern |
| Provider-defined functions | TF 1.8 / OpenTofu 1.7 | — |
| Cross-variable `validation` referencing other vars | TF 1.9 | Single-var validation only |

> OpenTofu tracks most of these but **diverges** — don't assume a TF version maps
> 1:1 to an OpenTofu version. Note which runtime you detected.

---

## The scan list (name the mistake, don't just say "best practice")

**Iteration & identity**
- Defaults to `count` for every collection → flag for `for_each` (when version ≥
  identity is stable). Name it: *list-index identity → reshuffle on delete.*
- Omits `moved` on a rename/refactor → *silent destroy/recreate.*
- Builds `for_each` keys from computed IDs → *not known until apply.*
- Suggests `terraform state mv` in automation where `moved` is reviewable.

**Secrets & state**
- Assumes `sensitive` keeps a value out of state → *plaintext still in state.*
- Plaintext secret defaults "for demo convenience".
- Outputs that expose full connection strings / secrets in PR comments.
- Forgets CI artifact retention + access controls on plan files.

**Module shape**
- Loose `map(any)` / untyped `object` inputs → *no contract, silent breakage.*
- Opaque passthrough variables; outputs mirroring whole provider objects.
- Generic names (`main`, `bucket`, `this` for multiples).
- Hardcoded region/AMI/account instead of variables/data sources.

**Cross-cloud**
- Defaults to `aws_*` resources even when the user/module targets Azure/GCP.
  Check the providers block before assuming a cloud.

**Testing**
- Asserts computed values in `command = plan`.
- Indexes set-type blocks with `[0]`.
- Treats mock-provider tests as equivalent to integration tests.

**Drift & lifecycle**
- Blanket `ignore_changes = all` to silence plan noise → *masks real drift.*
- `-auto-approve` on destroy; targeted destroy without a shown plan.
- Provider/version float (no `~>` bounds, lockfile not committed).

---

## False-positive guards (don't flag these)

- A `count = var.create ? 1 : 0` singleton — that's the correct use of `count`.
- `this` as a resource name when there is genuinely one instance.
- DynamoDB lock table when the runtime is < 1.10.
- Inline lifecycle `ignore_changes` on a **specific** attribute with a comment.
- `sensitive = true` on outputs that legitimately must exist (it's the right
  partial mitigation even though state still holds the value) — note, don't block.
