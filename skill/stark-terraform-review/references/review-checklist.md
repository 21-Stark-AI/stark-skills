# Terraform / OpenTofu review checklist

The failure-mode catalog. Each item is a thing to look for, the consequence, and
the fix shape. Severities are defaults — escalate on blast radius (prod, shared
state, internet-facing).

---

## 1. Secret exposure  `critical`/`high`

- ❌ Secret in a variable `default`, a `.tfvars`, or a literal in `main.tf`.
  ✅ Source from a secret manager (`aws_secretsmanager_secret_version`, Vault) at
  runtime, or a `write_only` argument (Terraform 1.11+).
- ❌ Treating `sensitive = true` as "not in state". It only masks **display** —
  the plaintext is still in state and in any `terraform_remote_state` reader.
  ✅ Keep secrets out of state entirely; restrict backend access; rotate.
- ❌ `nonsensitive()` used to push a secret into logs / output / a PR comment.
- ❌ Outputs exposing full connection strings / credentials. ✅ Expose only the
  ARN/identifier; mark sensitive outputs `sensitive = true`.
- ❌ Secret echoed via a `local-exec` provisioner or `null_resource`.

## 2. Identity churn (the silent destroy/recreate)  `high`

- ❌ `count` index as a resource's stable identity. Removing a middle element
  reshuffles every later address → mass destroy/recreate.
  ✅ `for_each` over a map/set keyed by **business identity** (`"payments-api"`).
- ❌ `for_each` keys derived from **computed** attributes (`.id`, `.arn`) — not
  known at plan time → "Invalid for_each argument".
  ✅ Keys from input variables / known-at-plan values.
- ❌ Resource renamed by editing the address (text replace) → destroy/recreate.
  ✅ A `moved {}` block (Terraform 1.1+) for every rename/refactor, incl.
  `count → for_each` migrations.
- ❌ `count` used for numeric repetition where identity matters. ✅ `count` only
  for 0/1 conditional creation.

## 3. Blast radius & state safety  `critical`/`high`

- ❌ One monolithic root/state for everything. ✅ Split by ownership / change
  cadence / recovery boundary (platform foundation · service stacks · bootstrap).
- ❌ Local state on a team/CI/prod module. ✅ Remote backend (S3/AzureRM/GCS/TFC)
  with **encryption + locking + versioning**.
- ❌ S3 backend without locking. ✅ `use_lockfile = true` (Terraform/OpenTofu
  1.10+) or `dynamodb_table` on older versions.
- ❌ Shared state across prod and non-prod, or across unrelated components.
  ✅ One backend key per stack; per-env isolation.
- ❌ `terraform destroy` / targeted destroy without `plan -destroy` + explicit
  confirmation. ❌ `-auto-approve` on destroy. ✅ Show the destroy plan first.

## 4. Network / IAM exposure  `critical`/`high`

- ❌ Security group open to `0.0.0.0/0` on all protocols (`"-1"`), esp. admin
  ports (22/3389/db). ✅ Least-privilege, specific ports/CIDRs.
- ❌ Inline `ingress` / `egress` blocks inside `aws_security_group` → rule edits
  churn the whole SG. ✅ Separate `aws_vpc_security_group_ingress_rule` /
  `aws_vpc_security_group_egress_rule` resources.
- ❌ Wildcard IAM (`Action: "*"`, `Resource: "*"`). ✅ Scoped actions + resources;
  review for least-privilege before approval.
- ❌ Default VPC; ❌ public subnets for data tiers.

## 5. Encryption & storage hardening  `critical`/`high`

- ❌ S3 bucket without `aws_s3_bucket_public_access_block` (all 4 flags `true`).
- ❌ Storage (S3/EBS/RDS/disks) without encryption at rest. ✅ SSE-KMS with a CMK
  + rotation for compliance; SSE-S3 minimum.
- ❌ Bucket without versioning (no rollback). ✅ Versioning on; MFA-delete on prod.
- ❌ Unencrypted data in transit (no TLS enforcement / `aws_s3_bucket_policy`
  denying non-TLS).

## 6. Module contracts & style  `medium`/`low`

(HashiCorp Style Guide — lift as the baseline.)

- ✅ File layout: `terraform.tf` (versions) · `providers.tf` · `main.tf` ·
  `variables.tf` (alphabetical) · `outputs.tf` (alphabetical) · `locals.tf`.
- ✅ Every **variable** has `type` **and** `description`; sensitive ones marked;
  constraints via `validation`. Order: `description → type → default → nullable
  → sensitive → validation`.
- ✅ Every **output** has a `description`; sensitive outputs marked.
- ✅ Naming: `lowercase_with_underscores`, descriptive noun **excluding** the
  resource type (`aws_instance.web_api`, not `web_api_instance`), singular not
  plural, `main`/`this` only for the singleton.
- ✅ `required_version` + `required_providers` pinned (min **and** max major;
  AVM TFNFR25). Providers `~> N.0`, runtime `~> 1.x`; `.terraform.lock.hcl`
  committed. Provider upgrades in their own PR.
- ❌ `map(any)` / loose `object({})` for structured input. ✅ Strong types +
  `optional()` with typed defaults (1.3+).
- ❌ Outputs that mirror whole provider objects. ✅ Narrow, stable subsets.
- ❌ `provisioner` / `null_resource` + `local-exec` for bootstrap. ✅ Cloud-native
  init (user-data, cloud-init, instance metadata); provisioners are last resort.
- ❌ Blanket `ignore_changes = all` — silences drift. ✅ Ignore specific attrs
  with a reason.
- ✅ Use trusted registry modules (`terraform-aws-modules`, Azure Verified
  Modules, `terraform-google-modules`) pinned to an **exact** version in prod;
  don't wrap trivially.

## 7. Testing gaps  `medium`

(HashiCorp `terraform-test` + Babenko testing rules.)

- ❌ Asserting **computed** values (ARNs, generated names) in `command = plan` →
  "could not be evaluated at this time". ✅ `command = apply` for computed.
- ❌ Indexing a **set-type** nested block with `[0]` (S3 encryption `rule`,
  lifecycle `transition`) in `plan` mode → "Cannot index a set value". ✅ `for`
  expression / `one()` / `apply` mode.
- ✅ Naming: `*_unit_test.tftest.hcl` = `plan` mode, `*_integration_test.tftest.hcl`
  = `apply` mode. Unit tests on every PR, integration on merge.
- ✅ Mock providers (1.7+) for PR validation (free, no creds); real-infra tests
  reserved for main. Negative tests via `expect_failures`.
- ❌ No tests at all on a reusable module. ✅ `examples/` doubles as test fixtures.

## 8. CI/CD review (when the PR touches pipelines)  `medium`

- ✅ Stages: validate → test → plan → **apply the saved plan artifact** (don't
  re-plan inside apply).
- ✅ Static analysis (fmt/validate/tflint/trivy/checkov) on every path to apply.
- ✅ Policy-as-code gate (`conftest`/OPA on plan JSON) for compliance frameworks.
- ❌ Apply from arbitrary branches; ❌ skipping the policy/scan stage.

---

## Quick verdict matrix

| Signal | Severity |
|--------|----------|
| Secret in code / state / output, public sensitive bucket, `0.0.0.0/0` admin, unguarded destroy | critical |
| `count`-index identity, missing `moved`, computed `for_each` keys, no remote lock, `map(any)` inputs, no encryption | high |
| Missing `type`/`validation`, inline SG rules, `ignore_changes=all`, unpinned providers, plan-mode computed asserts | medium |
| Missing `description`, naming, fmt, file layout | low |
