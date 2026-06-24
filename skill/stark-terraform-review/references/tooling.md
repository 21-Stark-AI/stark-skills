# Scanners & how to read them

Run these for **evidence** before the manual pass. Cite their output in findings;
don't duplicate what they already catch unless you add severity/context. Skip the
whole step on `--no-tools` and say so in the report. Probe availability first:

```bash
for t in terraform tofu tflint trivy checkov conftest infracost; do
  command -v "$t" >/dev/null 2>&1 && echo "have: $t" || echo "missing: $t"
done
```

Use `tofu` if `terraform` is absent (OpenTofu). Run from the module dir.

---

## Format & validate (always)

```bash
terraform fmt -check -recursive          # non-zero = unformatted files (low)
terraform init -backend=false            # needed for validate; no remote state touched
terraform validate                       # schema / reference / type errors
```

`-backend=false` keeps it offline and side-effect-free — never run a real
`init`/`plan` against a live backend during review.

## Lint

```bash
tflint --init && tflint --format compact     # provider-aware lint, deprecations, naming
```

## Security / policy scan

```bash
trivy config .            # IaC misconfig scan — INCLUDES the old tfsec rules (tfsec is EOL)
checkov -d . --compact    # CIS/PCI/HIPAA-mapped policy checks
```

Read these for: public access, missing encryption, permissive IAM/SG, missing
logging. Map each hit to a `file:line` and a severity. Trivy + Checkov overlap —
dedup, prefer the one with the clearer remediation.

## Policy-as-code (when a plan exists / CI review)

```bash
terraform plan -out=tfplan -lock=false && terraform show -json tfplan > tfplan.json
conftest test tfplan.json --policy policy/      # OPA/Rego compliance gates
```

Only generate a plan if it's safe and the user expects it (it can hit providers).
Default to **not** planning in an ad-hoc review; rely on validate + scanners.

## Cost / drift (optional)

```bash
infracost breakdown --path . --format json      # cost delta; flag surprises
```

## Tests (if the module ships `.tftest.hcl`)

```bash
terraform test                                  # native tests (TF 1.6+)
```

Check the tests themselves against the testing rules in `review-checklist.md`
(plan-vs-apply mode, set indexing, mock providers).

---

## Reading order

1. `fmt -check` → `validate`: structural sanity. If validate fails, fix-blocking;
   report and stop deep review until it parses.
2. `tflint`: idiom + deprecation.
3. `trivy` + `checkov`: the security spine — most `critical`/`high` come from here.
4. Manual pass (the checklists): the things scanners miss — identity churn,
   blast-radius/state design, module contracts, test-mode bugs.
