# Advanced practices — CI cost done RIGHT (not just cheap)

The cheap levers (in `levers.md`) stop the bleeding. This file is the *durable*
craft: measure the right number, skip work without breaking merges or
correctness, and govern so the cut stays cut. The recurring expert move is
reconciling **cost (skip work) vs signal (required gate) vs correctness (don't
miss regressions)** at a single chokepoint — the naive cost-only version of each
practice breaks mergeability or correctness.

Sourced from a 2026 multi-agent research sweep of GitHub docs/changelogs, tool
maintainers, and incident write-ups. Dates/limits are load-bearing — re-verify
before quoting hard prices (GitHub changed them twice in 2025–2026).

## Contents
1. Measure the right number (billed ≠ runtime ≠ cost; wait ≫ minutes)
2. Govern so cuts stay cut (FinOps loop, budgets, org policy)
3. Caching & incremental-build architecture
4. Pipeline architecture (skip work without breaking merge/correctness)
5. Storage, artifacts & the downstream resource
6. Security ⇒ cost/reliability (the same lever)
7. Consolidated myths / outdated advice

---

## 1. Measure the right number

- **billed ≠ runtime ≠ cost** — the #1 measurement error. Every **job rounds UP
  to a whole minute** (a 3s job bills 1 min). Included-minute **OS multipliers:
  Linux 1× / Windows 2× / macOS 10×** (a 10-min macOS job = 100 min). Larger
  runners bill higher SKUs. **A dashboard that sums wall-clock durations is
  wrong**, and GitHub's own Insights minutes can disagree with the billing report.
- **⭐ The dominant CI cost is developer WAIT time, not runner minutes.**
  Measured wait-to-compute ratios run **25–100×** (one "healthy" workload: **$7
  compute vs $977 wait, 142:1**). GitHub's own 2022 study: cutting a build 310→27
  min saved ~$350 of dev time/build while the extra hardware cost cents. So the
  true unit economic is **cost-per-merged-PR including loaded engineering wait**,
  and the lever is **duration / queue-time**, not $/minute. Optimizing minutes
  alone optimizes the small number. (Weight wait at ~30–60% of hours, not 100%.)
- **Where the data actually is:**
  - `GET /settings/billing/usage` is the **only supported billing endpoint**
    (repo/SKU grain, **daily**, 24 months; the `hour` param was removed Nov 2025).
    Per-**workflow** cost exists **only in the downloadable CSV usage report** (its
    API is enterprise-only, public preview Feb 2026). **Dead:**
    `/billing/{actions,packages,shared-storage}` (retired 2025-09-26) and the
    `Get workflow (run) usage` timing endpoints (closed 2025-02) — don't build on
    them.
  - **`self-actuated/actions-usage`** (OSS) reports **total** runtime including
    free-tier + self-hosted minutes that billing deliberately hides — the only way
    to see self-hosted volume.
  - **Native Actions Insights** (Usage + Performance Metrics; free, org-wide since
    Mar 2025): minutes/jobs + **queue time + failure rate** by workflow/repo/OS.
    UI-only, no dollars, no export API — a triage lens, not a system of record.
  - **Webhook cost attribution** (`workflow_job` completion → minutes × price;
    e.g. ActionsCost/CICosts) catches a regression the **day it merges**, not at
    the monthly invoice. Gotchas: the payload carries the **requested** `runs-on`
    (not the allocated runner → SKU ambiguity); on reruns `created_at` refreshes
    but `started/completed_at` are preserved (timestamp math breaks).
  - **CI-as-distributed-traces (OpenTelemetry):** run = trace, job = span, step =
    child span (export via `krzko/export-job-telemetry` to Tempo/Grafana/SigNoz).
    Queryable history you own, beyond GitHub's retention.
- **Billed-minutes ÷ actual-runtime ratio** per workflow is a direct **rounding-
  waste detector** — it points straight at tiny-job matrices and misplaced macOS.
- **Highest-signal KPIs** (priority): cost-per-merged-PR (loaded) · queue-time
  p50/p95 · duration p50/p95 · billed÷actual ratio · **macOS/Windows share of
  billed minutes** (usually the Pareto driver) · cache hit rate (target 70–90%) ·
  failure/rerun + flaky disruption · cost-per-workflow week-over-week delta · budget
  burn-down · DORA change-fail/MTTR (keeps you from cutting CI so hard escaped-defect
  cost rises). Separate **COST** tools (Octolense/CICube/ActionsCost) from
  **DURATION** tools (Datadog CI Visibility/Trunk/BuildPulse — priced $/committer,
  they show duration, **not** your Actions dollars).

## 2. Govern so cuts stay cut

Optimization that isn't governed regresses the moment attention moves on. Run the
FinOps **Inform → Optimize → Operate** loop: surface per-PR/per-workflow cost →
right-size/batch/cache/kill-flakes → budgets + alerts + cost-center showback.

- **Budgets + cost centers (native).** Cost centers group repos → a team
  (showback/chargeback); budgets attach at enterprise/org/repo/cost-center scope,
  by product **or** SKU, with %-alerts **and an optional hard-stop** ("stop usage
  when budget reached"). API-managed since Nov 2025. Start **showback**, graduate
  to **chargeback** once allocation accuracy > 90%. (Cost-center dimension is
  enterprise-only.) The **default $0 Actions spending limit** is the zero-config
  guardrail — but it hard-stops on **overage only** (halts all hosted Actions once
  *included* minutes are exhausted, with no signal); past the free tier use budgets.
- **Org allowed-actions allowlist + SHA-pin *policy*.** Set org policy to
  `selected` (github-owned + verified + explicit `owner/repo@ref`). Since
  **2025-08-15** you can (a) **block** an action by prefixing `!` — the blocklist
  is evaluated last and overrides any allow, i.e. an **org-wide incident
  kill-switch** (`!compromised-org/*`), and (b) tick **"require actions pinned to a
  full-length commit SHA"** so any unpinned workflow **fails**. This turns
  SHA-pinning from a lint into an enforced gate. (Enforcing org-wide red-fails
  every repo still on `@v4` tags → stage it. **Verified-creator badge ≠ security**
  — identity only; tj-actions was verified and popular.)
- **Org required workflows via repository rulesets** (GA 2023, replaced the retired
  "Required Workflows" feature). One central versioned CI gate across N repos, with
  an **evaluate/dry-run** mode — kills per-repo CI drift *and* the maintenance tax.
  Centralize the **gate**, not the whole pipeline; pin the required-workflow file to
  a SHA.
- **Runner-group policy** — bind expensive (large/self-hosted) runners to selected
  repos/workflows so a stray or compromised repo can't schedule 64-core jobs or
  reach a prod-networked runner.
- **Fork-PR / first-time-contributor approval gate** — fork PRs bill the **base**
  repo; approval blocks minute-mining + secret-probing. "First-time contributor"
  is a **weak** bar (one merged typo = exempt forever) → set to **all outside
  collaborators** for high-value public repos.
- **Hunt zombie crons.** Public-repo schedules **auto-disable after 60 days of no
  repo activity** (a feature); forks disable schedules by default. Find live ones
  via Insights (repos with only `schedule` runs, no human commits); disable Actions
  entirely on archived repos. **Trap:** popular "keepalive" actions defeat the
  safety by auto-committing a timestamp — audit *why* a schedule must survive first.
  Only **commits** reset the 60-day timer (not tags/releases/PRs) → genuinely-active
  but commit-quiet repos get silently disabled too.
- **Prevent bot event-loops.** Events triggered by the `GITHUB_TOKEN` **don't start
  new runs** (native recursion breaker). The moment you swap in a **PAT / App token
  / deploy key** to make an auto-commit trigger CI, you **re-arm the loop** — two
  bots reacting to each other's commits becomes a runaway. Add actor `if:` filters
  or commit-message guards if you must use a non-`GITHUB_TOKEN` identity.

## 3. Caching & incremental-build architecture

Mental model: `actions/cache` keys on a **whole-lockfile hash** → a coarse,
write-once tarball. Every finer-grained cache wins because **grain sets hit-rate
under churn** (one dep bump busts a lockfile tarball entirely; it only invalidates
one coordinate/object/action in a fine-grained cache). "Warm the cache" = pick the
right grain **and** a storage tier that survives to the next job.

- **Rotating suffix key + `restore-keys` prefix** — cache entries are **write-once**
  ("you cannot change the contents of an existing cache"). A pure lockfile-hash key
  *hits* → the save step is **skipped** → your build/compile cache **never
  accumulates** and ossifies. Suffix the key with `sha`/date to force a save; put
  the stable prefix in `restore-keys` to stay warm. A rotating key **without**
  `restore-keys` = 100% miss (the cargo-culted anti-pattern).
- **Branch scope makes PR-only pipelines cold.** Caches read only current + default
  + PR-base branch; siblings can't share. If CI is `on: pull_request` only and the
  default branch never runs the save, **every PR is a cold cache**. Fix: a
  **default-branch priming job** (push/schedule) so PRs restore warm.
- **Read-only cache for untrusted triggers (2026-06-26)** — saves from
  `pull_request_target` / fork `workflow_run` now get read-only tokens (cache-
  poisoning defense). Workflows that *saved* there silently regress to uncached.
- **`setup-go`/`setup-node` `cache:true` caches deps, NOT build output** → tests
  (`-race`) stay cold on a "hit". Split `GOCACHE` from `GOMODCACHE`, rotate the
  build-cache key, and **prune `GOCACHE` before save** (it grows unbounded, 100 GB+
  reports fill the 10 GB budget with dead objects).
- **Docker layer cache:** `type=gha` shares the **same 10 GB/repo pool** and its
  `scope` defaults to `"buildkit"` so **multiple images overwrite each other**
  (you cache only the last); needs the `docker-container` driver; 10-min timeout.
  Use **`type=registry,mode=max`** (or S3) for anything non-trivial — `mode=max`
  caches **intermediate/build stages** (default `min` throws them away),
  `type=inline` **can't do `mode=max`**, and registry has no 10 GB cap + shares
  across repos/self-hosted runners. **`RUN --mount=type=cache` does NOT persist**
  on ephemeral runners (lives on the builder host) — needs a remote/persistent
  builder or the `buildkit-cache-dance`.
- **Content-addressed compiler caches (sccache/ccache)** beat layer caching for
  Rust/C/C++ (object-file grain, ideal for ephemeral CI). **Absolute paths poison
  the hash** → set `CCACHE_BASEDIR`/relative or get 100% misses; the GHA backend
  inherits the 10 GB cap, S3 is the real distributed store; diagnose with
  `--show-stats`.
- **Bazel/Gradle/Nx/Turborepo remote build/task cache** = org-wide warm, cross-
  developer/CI — the biggest wins (action/task-output grain). **But it's a
  correctness surface:** a non-hermetic action **poisons a shared, unverifiable
  input-addressed cache → *wrong* builds for everyone**; untrusted PRs must be
  **read-only upload**. Pair affected-graph selection (`nx affected` / `turbo
  --affected`) with the remote cache — GOTCHA: `nrwl/nx-set-shas` defaults to
  `HEAD~1` when it can't find a successful run → **must track the last *successful*
  main run** or it skips changed projects; **shallow clone marks everything
  changed** (need the base commit in the checkout).
- **Dependency proxy / pull-through mirror** (Verdaccio/Artifactory/GAR-ECR
  pull-through) caches at **coordinate grain** — survives lockfile churn that busts
  an `actions/cache` tarball **and** keeps builds working through upstream
  outages/rate-limits. It's infra to secure (SPOF/MITM).
- **Prebuilt CI base images** for slow-changing deps turn a per-run install into a
  per-change one, more deterministically than a cache restore — watch staleness +
  pull time; lifecycle-prune the image itself.
- **Matrix: split restore/save** — restore-only in every leg, one save downstream
  (write-once → legs race `reserveCache failed`; respects 200 uploads/min).
- **Cache is no longer unconditionally free (2025-11-20)** — >10 GB is
  pay-as-you-go; a hit budget makes cache **read-only** until next cycle (silent
  miss storms). Don't use **artifacts as a pseudo-cache** (uploading
  `node_modules`/`.venv` = billed storage for regenerable data).

## 4. Pipeline architecture

- **⭐ The gate-job pattern** (the correct fix for the required-check freeze). A
  *skipped workflow* leaves its required check **Pending forever** → the PR can
  never merge; a skipped **job** reports **Success**. So path-filtering a required
  *workflow* both wastes nothing **and bricks merges**. Make the **only** required
  check a dedicated `gate` job that `needs: [all real jobs]`, runs `if: always()`,
  and aggregates via `re-actors/alls-green` (`jobs: ${{ toJSON(needs) }}`); un-require
  the individual jobs. This also closes a **security gap**: GitHub counts a
  **skipped job as passing** for branch protection *and* the merge queue, so a
  required scan that gets skipped (upstream fail / path filter / `[skip ci]`) merges
  **as if it passed** — the `if: always()` gate converts skips into an explicit fail.
- **Fix the `on: [push, pull_request]` double-run at the trigger** — the naive form
  runs the whole workflow **twice** on every push that has an open PR (~50% waste).
  Scope push, leave PR unscoped:
  ```yaml
  on:
    push: { branches: [main] }   # + tags for releases
    pull_request:
  ```
- **Merge queue + batching** — a batch of N PRs is tested as **one** CI run
  (≈ 1/N runs), but the real win is **correctness**: each PR is tested against the
  **future `main`** (catches semantic conflicts that pass individually) and it kills
  the "require branches up-to-date" **rebase stampede**. Wire `merge_group:` into
  the `on:` of every required check or the queue **deadlocks**. GOTCHA: **flaky
  required checks are catastrophic in a queue** (one 5% flake can blow the whole
  batch + trigger bisection re-runs) — quarantine flaky tests **out of the required
  set** first. Low PR volume → skip the queue.
- **Tiered CI around `merge_group`** — Tier 1 (lint/typecheck/unit) `on:
  pull_request` for fast feedback; Tier 2 (E2E/integration/cross-platform)
  `on: merge_group` **only**, so the heavy suite runs **once per landing** with
  *better* signal (the real to-be-merged state), not on every WIP push. Don't also
  leave the heavy suite on `pull_request` (double-pay).
- **Test-impact / affected-only** (Nx/Bazel/Turborepo graph, or Develocity
  predictive PTS) cuts 60–80% on small PRs — **with a mandatory full-suite
  backstop.** TIA has irreducible false negatives (config/env/reflection/generated/
  shared modules), so run the **entire** suite at a chokepoint (merge queue >
  nightly). "Affected passed" ≠ safe; never make it the only gate.
- **Dynamic matrix from changed files** — a cheap detect job emits JSON, the build
  job does `strategy.matrix: ${{ fromJSON(needs.detect.outputs.pkgs) }}` → fan-out
  is O(changed pkgs), not O(repo). Empty matrix + a required per-pkg check = the
  pending-forever trap → needs the gate job.
- **`fail-fast: true` (default) is an economic lever** for PR gating — any matrix
  failure blocks the PR, so finishing the other combos is pure waste. `false` is a
  deliberate spend for a diagnostic grid, not "safer"; people flip it and forget.
- **Cost-aware DAG ordering** — run cheap checks (lint/typecheck/unit) **in
  parallel**, then gate expensive stages (build/E2E/deploy) behind them via
  `needs:`. Kills the doomed 20-min E2E on lint-failing code (cost) **and** surfaces
  cheap signal fast (latency). Not blanket-serial, not blanket-parallel.
- **`timeout-minutes` on every job** — the default is **6 hours** (also the hosted
  max). A hung job bills the whole ceiling; a hung **macOS** job = 3,600 min ≈ $223.
  Set ~2× p95; below real p99 it kills legit jobs and drives retries.
- **Concurrency beyond cancel** — PR branches: `cancel-in-progress: true`. Deploy /
  `main` / `merge_group`: **`cancel-in-progress: false` + `queue: max`** (GA
  2026-05). The default keeps only **one** pending run, so a 2nd queued deploy
  **silently cancels the first** even with `cancel-in-progress: false`; `queue: max`
  is the first native way to queue N in order. (`queue: max` + `cancel: true` is a
  validation error.) Copying `cancel-in-progress: true` into a deploy workflow
  "silently dropped our deploys."
- **Gate expensive jobs on draft-state + labels** — `if: github.event.pull_request
  .draft == false` skips E2E on drafts; `contains(labels,'run-e2e')` opts heavy
  suites in per-PR. Skipped = unbilled (route through the gate job; un-draft needs
  `ready_for_review` in `types`).
- **Reusable workflows + composite actions + org rulesets** — DRY that cuts drift
  and the maintenance tax, not just minutes (one place to fix a cache key / Node
  version). Reusable can't nest (1 level); composite can't take secrets/matrices;
  **pin callers to a SHA, not a moving branch**.

## 5. Storage, artifacts & the downstream resource

- **`retention-days` per upload** — artifacts bill **GB-months** ($0.25/GB-mo over
  a tiny free allowance shared with Packages: 500 MB Free / 2 GB Team / 50 GB Ent).
  The **90-day default** bills every throwaway coverage report for a quarter — set
  3–7 for CI transients, 90 only for releases. **Delete early**, don't wait for
  expiry (accrual is continuous; deleting stops *future* accrual but doesn't refund;
  expired ≠ deleted, 6–24 h lag). Lowering the default is **not retroactive**.
- **Push summaries to `$GITHUB_STEP_SUMMARY` + keep raw logs in the run** — logs +
  job summaries **don't count** against the artifact quota; artifacts are for what
  you re-download. Don't use artifacts as a pseudo-cache.
- **`upload-artifact@v4`** is immutable + ~10× faster, but same-name-from-multiple-
  jobs now **errors** (use `upload-artifact/merge`), 500-artifact/job cap, and v4
  can't download v3. **v3 is dead since 2025-01-30** (GHES still v3).
- **Registry lifecycle is where CI storage cost actually lands.** Every build pushes
  a new image and every `:latest` re-tag **orphans a digest**. Attach cleanup:
  **GAR** cleanup policies (delete-untagged `older_than` + keep-most-recent-N;
  $0.10/GB-mo; keep-N & conditional-keep are **mutually exclusive**, keep beats
  delete, max 10/repo, ~1 day to act, dry-run first); **ECR** lifecycle policies
  (`imageCountMoreThan`/`sinceImagePushed`; **rule-priority ordering trap** — a
  broad keep-N can delete images a later rule meant to keep; preview first,
  irreversible). **GHCR** container storage is **currently free** (1-month notice;
  deleting needs a `delete:packages` PAT — `GITHUB_TOKEN` has none) — treat free as
  temporary. **Docker Hub:** authenticate pulls (ephemeral runners share NAT IPs →
  anon hits the per-IP limit → **429 build failures**) and front with a pull-through
  cache (cached pulls don't count). (The April-2025 10/hr anon limit was announced
  but **never enforced** — real: 100/6h anon, 200/6h free-authed.)
- **Image slimming is a DOUBLE cost cut** — registry storage (GB-months, forever)
  **and** pull-time on every ephemeral runner/deploy (bandwidth + slower cold
  starts = compute). Multi-stage + distroless/scratch/slim + `.dockerignore`;
  reported 850 MB→15 MB, CI 22 min→4 min, and fewer CVEs (security win too). Caveat:
  **alpine's musl** breaks glibc wheels and can force slower from-source builds —
  distroless/slim is often smaller *and* faster; distroless has no shell (`:debug`).
- **⭐ Chase the resource the workflow TOUCHES.** A deploy workflow can bill pennies
  in Actions yet write a config that bills 24/7. The canonical trap: **Cloud Run
  `min-instances > 0` + `cpu-idle=false`** = always-on billing **~$150/mo per idle
  instance**; a 30-warm-instance dev fleet ≈ **$1,960/mo before a single request**.
  Also: per-PR **preview envs** leave standing services / load-balancers / volumes;
  **cross-region egress** meters what same-region pulls get free. Trace every
  build/deploy workflow's downstream footprint (registry storage, deployed-service
  standing cost, egress, spun-up test DBs) and put it on the same review as the YAML.
  On GCP: `gcp_artifact_registry` (`idle_repositories`) + Cloud Run.

## 6. Security ⇒ cost/reliability (the same lever)

The cheapest minute is one never run; the safest secret is one that doesn't exist.

- **OIDC / WIF deletes long-lived secrets** — a ~1 h token per run kills the
  rotation runbook *and* the thing attackers steal (the entire tj-actions attack
  was dumping long-lived secrets from runner memory into logs; short-lived tokens
  are near-worthless to exfiltrate). **The safety lives entirely in the cloud-side
  trust-condition scoping** — pin exact `repo:ref:environment`, never owner-only /
  wildcard `sub`, or any repo (or a fork) can mint prod creds.
- **step-security `harden-runner`** — EDR for runners (egress/file/process). Deploy
  `egress-policy: audit` first (baseline), then `block` (allowlist). It's precisely
  what would have **caught** tj-actions (an unexpected outbound secret POST, or a
  miner burning your minutes). Free on public repos; block-without-baseline breaks
  legit downloads.
- **Least-privilege, job-scoped `permissions:` + kill the `pull_request_target`
  pwn-request.** Grant `contents: write` on the one job, not the workflow; never
  interpolate untrusted PR title/body into `run:` (pass via `env:`); run untrusted
  code under `pull_request` (no secrets) → hand the artifact to a privileged
  `workflow_run`. `pull_request_target` + checking out fork head is the root cause
  of most GHA RCEs. **`actions/checkout` v7 (2026-06) refuses pwn checkouts by
  default** → upgrading checkout *is* a hardening step.
- **Environments + deployment protection** — required reviewers (with
  prevent-self-review), **wait timers (non-billable)**, and secrets that release
  **only after approval** — shrinks the secret-exposure window and blocks accidental/
  compromised prod deploys.
- **tj-actions/reviewdog (CVE-2025-30066/30154) is the whole lesson.** Root cause: a
  **PAT pasted into a CI workflow**, leaked via a `pull_request_target` pwn request,
  then lateral movement and **retroactive tag-repointing** (incl. `@v1`, `@v45`) to
  a commit that dumped runner memory into logs, **double-base64-encoded to defeat
  log masking**. ~23k repos exposed, ~218 actually leaked. Defenses (each above):
  full-SHA pin, **no PATs in workflows**, `pull_request_target` discipline, egress
  monitoring, block-list. **SHA-pinning is necessary, not sufficient** — it fails if
  you (or Dependabot) bump *into* the bad SHA, and does nothing against a transitive
  dep the pinned action pulls at runtime.
- **Immutable releases (GA 2025-10-28) + immutable actions publishing (preview)** =
  the structural fix that makes tag-repointing impossible (tags can't move/delete;
  signed provenance; `@vX` → content-addressed OCI). The low-maintenance successor
  to hand-managed SHAs — but until the ecosystem adopts it, **SHA-pinning remains
  the enforceable control today**.
- **Keep SHA-pins fresh with Dependabot/Renovate** (a pin without an update path
  rots into an unpatched-dependency liability). Bootstrap at scale with `ratchet` /
  `pin-github-action` / StepSecurity `secure-repo`. GOTCHAS: Dependabot can bump to
  the **latest branch commit, not the release tag** (#13466) and **fails to update
  the `# v4.1.2` comment** (it lies about the SHA) — review the compare link.
  **Auto-merging action bumps is how you'd sail into the tj-actions bad SHA** — gate
  behind a human or a cool-down.
- **Flaky-test economics: reliability IS cost.** A "re-run failed tests" policy
  **doubles/triples** compute (20–30% of CI on retries) **and masks regressions**
  (green-on-attempt-2 ships the bug). Right pattern: **zero retries locally**,
  **bounded 1–2 in CI only to *measure*** pass-on-retry rate, then **auto-quarantine
  out of the merge gate** (Trunk/BuildPulse/Datadog EFD; flag within ~3 runs).
  Quarantine is a **holding cell, not a graveyard** — keep it **< 5%** of the suite
  (>10% = systemic rot), route each to an owner with an SLA. Air cover: Atlassian
  21% of master failures / ~150k dev-hrs/yr; Google 16% flaky, 84% of pass→fail
  transitions are flakiness (dollar figures are vendor-directional).
- **Org artifact/log retention** is one lever with two wins — storage cost **and**
  the window an attacker (or over-broad `actions: read`) can mine old logs for
  leaked secrets (logs hold tokens/hostnames; tj-actions dumped *to* logs). Not
  retroactive; don't cut below your forensics/compliance window.

## 7. Consolidated myths / outdated advice

- **"billed minutes = runtime = cost."** No — per-job rounding + OS multipliers +
  runner SKUs make it nonlinear; summing durations is wrong.
- **"Self-hosted runners are free / always cheaper."** Free of GitHub *minute*
  charges only; cost shifts to idle compute, egress, patching, ops, secret-exposure.
  Hosted prices dropped ~25–39% on 2026-01-01 and a **$0.002/min self-hosted
  control-plane fee was postponed, not cancelled** — model it, don't assume $0
  forever. Self-hosted on **public repos** is dangerous (non-ephemeral + forks =
  persistent RCE).
- **"Verified-creator / Marketplace badge = safe."** Identity only; GitHub doesn't
  review the code. tj-actions was verified; `trivy-action` had 76/77 tags repointed.
- **"Pinning to `@v4` or a short SHA is enough."** Tags are mutable (the whole 2025
  attack class); short SHAs are collision-weakened. Pin the **full 40-char SHA** (or
  an immutable-published action).
- **"Retries fix flaky tests."** They mask regressions and multiply compute; retry
  only to *measure*, then quarantine.
- **"`pull_request_target` lets fork PRs run our checks with secrets."** Backwards —
  it's the pwn-request. Untrusted code → `pull_request` (no secrets) → `workflow_run`.
- **"Path/branch-filter the required *workflow* to save money."** A skipped workflow
  leaves the required check Pending forever and **bricks the merge** (a skipped *job*
  passes) — use the **gate job**.
- **"`cancel-in-progress: true` everywhere is a free saving."** Right for PR
  branches; on deploy/`main`/`merge_group` it **silently drops deploys** — use
  `false` + `queue: max`.
- **"`[skip ci]` is a clean way to save runs."** In a repo with required checks it
  **blocks the merge** (checks never report) and doesn't work in the merge queue.
- **"`fail-fast: false` is the safe choice."** It just costs more; `true` is right
  for merge gating.
- **"Affected/TIA can be the only gate."** Irreducible false negatives — keep a
  full-suite backstop.
- **"`skip-duplicate-actions` (fkirc)."** Effectively unmaintained since 2023 — use
  native `concurrency` + correct triggers.
- **"Add a keepalive so our schedule never disables."** Often keeps a *zombie*
  alive; the 60-day auto-disable is a safety feature.
- **"`type=gha` is the best Docker cache / `setup-*` `cache:true` is enough."**
  `type=gha` thrashes the 10 GB pool + collides scopes; `setup-*` caches deps not
  build output. Use `type=registry,mode=max`; split/rotate the build cache.
- **"`upload-artifact@v3` still works" / "cache is always free."** v3 dead since
  2025-01-30; cache >10 GB has been pay-as-you-go since 2025-11-20.
- **"The GHA bill is the CI cost."** For build/deploy pipelines the dominant cost is
  usually registry storage + the deployed service's standing spend (Cloud Run
  min-instances) + egress — on the *cloud* bill, not GitHub's.
- **Dead endpoints:** `/billing/{actions,packages,shared-storage}` (2025-09-26),
  `Get workflow (run) usage` (2025-02), the `hour` param on `/billing/usage`
  (Nov 2025). Use `/settings/billing/usage` + the CSV report.
