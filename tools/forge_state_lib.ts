// `tools/forge_state_lib.ts` — the pure, deterministic, I/O-free state-machine
// core for the `/stark-forge` pipeline orchestrator.
//
// HARD CONSTRAINTS (spec §5/§6, plan §2.5 "Global Constraints"):
//   - No clock: every timestamp is a host-supplied `at: string` param; this file
//     never reads the wall clock.
//   - No LLM calls, no git, no disk I/O, no network. It imports nothing from the
//     filesystem, the state-root resolver, or the write-spec history helpers.
//     All persistence lives in the host module `tools/forge_state.ts`.
//   - Every mutating function returns a NEW `RunState` (input left untouched).
//
// The transition-throw style mirrors `tools/github_projects_lib.ts`
// (`isLegalTransition` / `LEGAL_TRANSITIONS` / `transitionStatus`).

// ---------------------------------------------------------------------------
// Types & enums (T1 — spec §5)
// ---------------------------------------------------------------------------

/** The 8-value closed stage enum (spec §5, plan §2.5). */
export type Stage =
  | "write-spec"
  | "review-spec"
  | "red-team-spec"
  | "spec-to-plan"
  | "review-plan"
  | "red-team-plan"
  | "plan-to-tasks"
  | "copilot";

export type StageStatus = "pending" | "running" | "halted" | "done" | "failed";

export type MergePoint = {
  after_stage: Stage;
  artifact: "spec" | "plan" | "impl";
};

export type Attempt = {
  started_at: string;
  ended_at: string | null;
  outcome: "halted" | "failed" | "crashed";
};

/** Spec's closed artifact shape — NO completion boolean (spec §5, plan §2.5). */
export type StageArtifacts = {
  spec_path?: string;
  plan_path?: string;
  plan_slug?: string;
  issue_numbers?: number[];
};

/** Injected PR-state reader — the sole external dependency (spec §7). */
export type PrReader = (pr: number) => "open" | "merged" | "closed";

export type Gate = { reason: string; detail: string };

export type MergeRecord = { pr: number; merged_by_forge: boolean };

export type StageRecord = {
  stage: Stage;
  status: StageStatus;
  prs: number[];
  merges: MergeRecord[];
  fold_prs: number[];
  artifacts: StageArtifacts;
  gate: Gate | null;
  started_at: string | null;
  ended_at: string | null;
  attempts: Attempt[];
};

export type RepoIdentity = { host: string; owner: string; name: string };

export type RunInput = {
  kind: "intent" | "spec-path" | "plan-path";
  value: string;
};

export type InitialArtifacts = {
  spec_path?: string;
  plan_path?: string;
  plan_slug?: string;
};

export type ArtifactPrs = { spec?: number[]; plan?: number[]; impl?: number[] };

export type RunState = {
  slug: string;
  run_id: string;
  input: RunInput;
  initial_artifacts: InitialArtifacts;
  mode: "in-session" | "driver";
  chain: Stage[];
  merge_points: MergePoint[];
  artifact_prs: ArtifactPrs;
  repo: RepoIdentity;
  default_branch: string;
  created_at: string;
  updated_at: string;
  abandoned_at?: string | null;
  stages: StageRecord[];
};

/** Resolved-run descriptor consumed by `initializeRun` (T7). */
export type ResolvedRun = {
  chain: Stage[];
  mergePoints: MergePoint[];
  slug: string;
  input: RunInput;
  initial_artifacts: InitialArtifacts;
  repo: RepoIdentity;
  default_branch: string;
};

// ---------------------------------------------------------------------------
// Errors — coded, so the CLI/tests can assert on `error.code`.
// ---------------------------------------------------------------------------

export class ForgeStateError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ForgeStateError";
  }
}

function err(code: string, message: string): ForgeStateError {
  return new ForgeStateError(code, message);
}

// ---------------------------------------------------------------------------
// Static stage classification (T4)
// ---------------------------------------------------------------------------

/** Which artifact a stage's PR belongs to (null = produces no mergeable PR). */
export function stageArtifact(stage: Stage): "spec" | "plan" | "impl" | null {
  switch (stage) {
    case "write-spec":
    case "review-spec":
    case "red-team-spec":
      return "spec";
    case "spec-to-plan":
    case "review-plan":
    case "red-team-plan":
      return "plan";
    case "copilot":
      return "impl";
    case "plan-to-tasks":
      return null;
  }
}

/**
 * The single owner of the base-sync routing rule (plan §2.5): true EXACTLY for
 * the new-artifact stages that must run against updated `main`.
 */
export function requiresBaseSync(stage: Stage): boolean {
  return (
    stage === "spec-to-plan" ||
    stage === "plan-to-tasks" ||
    stage === "copilot"
  );
}

/**
 * Fields §4 requires each stage to record before it may reach `done`
 * (checked by the `running → done` gate; reused by reconciliation).
 */
export function requiredOutputsFor(stage: Stage): string[] {
  switch (stage) {
    case "write-spec":
      return ["spec_path"];
    case "spec-to-plan":
      return ["plan_path", "plan_slug"];
    case "plan-to-tasks":
      return ["issue_numbers"];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Transition matrix (T2 — spec §6)
// ---------------------------------------------------------------------------

export const LEGAL_TRANSITIONS: Readonly<
  Record<StageStatus, ReadonlySet<StageStatus>>
> = {
  pending: new Set<StageStatus>(["running"]),
  running: new Set<StageStatus>(["done", "halted", "failed"]),
  halted: new Set<StageStatus>(["running"]),
  failed: new Set<StageStatus>(["running"]),
  done: new Set<StageStatus>(),
};

export function isLegalTransition(from: StageStatus, to: StageStatus): boolean {
  const allowed = LEGAL_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.has(to);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function clone<T>(v: T): T {
  return structuredClone(v);
}

function stageIndex(state: RunState, stage: Stage): number {
  const idx = state.stages.findIndex((s) => s.stage === stage);
  if (idx === -1) {
    throw err(
      "stage_not_in_chain",
      `Stage '${stage}' is not part of this run's chain: ${JSON.stringify(
        state.chain,
      )}`,
    );
  }
  return idx;
}

/** Union two number arrays, dedup, first-seen order preserved. */
function unionDedup(existing: number[], incoming: number[]): number[] {
  const out = [...existing];
  const seen = new Set(existing);
  for (const n of incoming) {
    if (!seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

function isRecorded(value: unknown, field: string): boolean {
  if (field === "issue_numbers") {
    return Array.isArray(value) && value.length > 0;
  }
  return typeof value === "string" && value.length > 0;
}

/**
 * Enforce the `running → done` output/merge/marker gate (T5). Throws on any
 * unmet requirement. Reused by `transition` and `reconcileRunningStage`.
 */
function enforceDoneGate(
  state: RunState,
  stage: Stage,
  readPr?: PrReader,
): void {
  const rec = state.stages[stageIndex(state, stage)];

  // 1. required outputs recorded
  for (const field of requiredOutputsFor(stage)) {
    const value = (rec.artifacts as Record<string, unknown>)[field];
    if (!isRecorded(value, field)) {
      throw err(
        "missing_required_output",
        `Stage '${stage}' cannot reach 'done': required output '${field}' not recorded.`,
      );
    }
  }

  // 2. merge-point gate (registry non-empty, all merged, no open fold)
  const mp = state.merge_points.find((m) => m.after_stage === stage);
  if (mp) {
    if (!readPr) {
      throw err(
        "pr_reader_required",
        `Merge-point stage '${stage}' cannot reach 'done' without a PR-state reader.`,
      );
    }
    const registry = state.artifact_prs[mp.artifact] ?? [];
    if (registry.length === 0) {
      throw err(
        "empty_artifact_prs",
        `Merge-point stage '${stage}' cannot reach 'done': artifact_prs.${mp.artifact} is empty (no vacuous pass).`,
      );
    }
    for (const pr of registry) {
      if (readPr(pr) !== "merged") {
        throw err(
          "merge_pending",
          `Merge-point stage '${stage}' cannot reach 'done': PR #${pr} for '${mp.artifact}' is not merged.`,
        );
      }
    }
    for (const pr of rec.fold_prs ?? []) {
      if (readPr(pr) === "open") {
        throw err(
          "fold_pr_open",
          `Merge-point stage '${stage}' cannot reach 'done': fold PR #${pr} is still open.`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// recordOutput — the ONE output/PR-registry mutation owner (T4)
// ---------------------------------------------------------------------------

export function recordOutput(
  state: RunState,
  args: {
    stage: Stage;
    prs?: number[];
    foldPrs?: number[];
    merges?: MergeRecord[];
    artifacts?: Partial<StageArtifacts>;
    at: string;
  },
): RunState {
  const next = clone(state);
  const idx = stageIndex(next, args.stage);
  const rec = next.stages[idx];
  const artifact = stageArtifact(args.stage);

  // Output checkpoints are only valid for a RUNNING stage — a completed
  // (done)/pending/halted/failed stage must not append more outputs (e.g. a
  // finished copilot stage cannot register another impl PR after completion).
  if (rec.status !== "running") {
    throw err(
      "stage_not_running",
      `recordOutput requires stage '${args.stage}' to be 'running' (found '${rec.status}').`,
    );
  }

  // A stage that produces no mergeable PR (plan-to-tasks → issues, not a PR)
  // keeps its per-stage `prs`/`fold_prs` permanently empty.
  if (
    artifact === null &&
    ((args.prs && args.prs.length > 0) ||
      (args.foldPrs && args.foldPrs.length > 0))
  ) {
    throw err(
      "no_pr_for_stage",
      `Stage '${args.stage}' produces no PR; prs/fold_prs may not be recorded.`,
    );
  }

  // --- canonical artifact_prs registry (one writing stage per artifact) ---
  if (args.prs && args.prs.length > 0 && artifact !== null) {
    const existing = next.artifact_prs[artifact] ?? [];
    if (existing.length === 0) {
      // opening stage seeds the entry (author stage, or a review stage in a
      // path-based/sliced chain acting as PR opener). spec/plan are the ONE
      // shared PR per artifact — only `impl` (copilot multi-PR) may seed many.
      const seeded = unionDedup([], args.prs);
      if (artifact !== "impl" && seeded.length !== 1) {
        throw err(
          "multiple_seed_prs",
          `Stage '${args.stage}' seeded the '${artifact}' registry with ${seeded.length} PRs; spec/plan allow exactly one shared PR.`,
        );
      }
      next.artifact_prs[artifact] = seeded;
    } else if (artifact === "impl") {
      // incremental union allowed ONLY for the multi-PR impl artifact.
      next.artifact_prs[artifact] = unionDedup(existing, args.prs);
    } else {
      // spec/plan registries are write-once after first PR: a continuation (or
      // crashed-and-re-entering opener) stage may only report PRs already
      // present — a divergent PR forks the one-PR-per-artifact model.
      for (const pr of args.prs) {
        if (!existing.includes(pr)) {
          throw err(
            "adoption_mismatch",
            `Stage '${args.stage}' reported PR #${pr} which does not match the write-once '${artifact}' registry ${JSON.stringify(
              existing,
            )}.`,
          );
        }
      }
      // identical re-report → no change
    }
  }

  // --- per-stage prs (derived observation, union-dedup) ---
  if (args.prs && args.prs.length > 0) {
    rec.prs = unionDedup(rec.prs, args.prs);
  }

  // --- fold_prs (union-dedup) ---
  if (args.foldPrs && args.foldPrs.length > 0) {
    rec.fold_prs = unionDedup(rec.fold_prs, args.foldPrs);
  }

  // --- merges keyed by pr, monotonic (true never overwritten by false) ---
  if (args.merges && args.merges.length > 0) {
    for (const m of args.merges) {
      const found = rec.merges.find((e) => e.pr === m.pr);
      if (!found) {
        rec.merges.push({ pr: m.pr, merged_by_forge: m.merged_by_forge });
      } else if (m.merged_by_forge && !found.merged_by_forge) {
        found.merged_by_forge = true;
      }
      // existing true + incoming false → keep true (monotonic no-op)
    }
  }

  // --- artifacts: scalars write-once, issue_numbers union-dedup ---
  if (args.artifacts) {
    const a = args.artifacts;
    for (const field of ["spec_path", "plan_path", "plan_slug"] as const) {
      const incoming = a[field];
      if (incoming === undefined) continue;
      const current = rec.artifacts[field];
      if (current !== undefined && current !== incoming) {
        throw err(
          "artifact_conflict",
          `Stage '${args.stage}' scalar artifact '${field}' is write-once: '${current}' cannot be overwritten with '${incoming}'.`,
        );
      }
      rec.artifacts[field] = incoming;
    }
    if (a.issue_numbers && a.issue_numbers.length > 0) {
      rec.artifacts.issue_numbers = unionDedup(
        rec.artifacts.issue_numbers ?? [],
        a.issue_numbers,
      );
    }
  }

  // Idempotent re-report: if the patch changed nothing, return an unchanged
  // clone — updated_at is preserved (never bumped by a no-op re-report). `next`
  // was cloned from `state` with the same updated_at, so equality here means
  // no field moved.
  if (JSON.stringify(next) === JSON.stringify(state)) {
    return next;
  }

  next.updated_at = args.at;
  return next;
}

// ---------------------------------------------------------------------------
// transition — status/gate/timestamps/attempts owner (T2, T3, T5)
// ---------------------------------------------------------------------------

export function transition(
  state: RunState,
  args: {
    stage: Stage;
    expectedStatus?: StageStatus;
    to: StageStatus;
    prs?: number[];
    foldPrs?: number[];
    gate?: Gate;
    artifacts?: Partial<StageArtifacts>;
    at: string;
  },
  readPr?: PrReader,
): RunState {
  const current = state.stages[stageIndex(state, args.stage)].status;

  // Replay-safe no-op reprint: re-issuing a transition whose `to` already
  // equals the stored status preserves timestamps/attempts (spec §7).
  if (current === args.to) {
    return clone(state);
  }

  // Compare-and-set: commit only when the stored status matches expectation.
  if (args.expectedStatus !== undefined && current !== args.expectedStatus) {
    throw err(
      "expected_status_mismatch",
      `Stage '${args.stage}' expected status '${args.expectedStatus}' but found '${current}'.`,
    );
  }

  if (!isLegalTransition(current, args.to)) {
    const allowed = [...(LEGAL_TRANSITIONS[current] ?? new Set<StageStatus>())];
    throw err(
      "illegal_transition",
      `Illegal transition: '${current}' → '${args.to}' for stage '${args.stage}'. Allowed: ${JSON.stringify(
        allowed,
      )}`,
    );
  }

  // Single-writer discipline: output/PR writes delegate to recordOutput.
  let next =
    args.prs || args.foldPrs || args.artifacts
      ? recordOutput(state, {
          stage: args.stage,
          prs: args.prs,
          foldPrs: args.foldPrs,
          artifacts: args.artifacts,
          at: args.at,
        })
      : clone(state);

  // `running → done` enforces the required-output + merge/marker gate BEFORE
  // committing the status change.
  if (args.to === "done") {
    enforceDoneGate(next, args.stage, readPr);
  }

  const idx = stageIndex(next, args.stage);
  const rec = next.stages[idx];

  switch (args.to) {
    case "running": {
      // pending→running, or halted/failed→running re-entry. A new episode
      // begins: stamp started_at, clear ended_at + gate, append NOTHING
      // (the prior episode was archived when it ended). prs/fold_prs/artifacts
      // are preserved.
      rec.status = "running";
      rec.started_at = args.at;
      rec.ended_at = null;
      rec.gate = null;
      break;
    }
    case "done": {
      rec.status = "done";
      rec.ended_at = args.at;
      // running→done archives nothing (its timing lives in started/ended_at).
      break;
    }
    case "halted":
    case "failed": {
      if (!args.gate || !args.gate.reason) {
        throw err(
          "gate_required",
          `Transition '${current}' → '${args.to}' for stage '${args.stage}' requires a gate {reason, detail}.`,
        );
      }
      rec.status = args.to;
      rec.ended_at = args.at;
      rec.gate = { reason: args.gate.reason, detail: args.gate.detail ?? "" };
      // Normal episode-end: append exactly ONE attempt (never `crashed`).
      rec.attempts.push({
        started_at: rec.started_at ?? args.at,
        ended_at: args.at,
        outcome: args.to,
      });
      break;
    }
    case "pending":
      // unreachable — no legal transition targets pending
      break;
  }

  next.updated_at = args.at;
  return next;
}

// ---------------------------------------------------------------------------
// reconcileRunningStage — the ONE AND ONLY writer of a `crashed` attempt (T6)
// ---------------------------------------------------------------------------

export function reconcileRunningStage(
  state: RunState,
  args: {
    stage: Stage;
    to: "done" | "failed" | "halted";
    gate?: Gate;
    observedMerges?: { pr: number }[];
    at: string;
  },
  readPr: PrReader,
): RunState {
  const idx0 = stageIndex(state, args.stage);
  const current = state.stages[idx0].status;
  if (current !== "running") {
    throw err(
      "not_running",
      `reconcileRunningStage requires stage '${args.stage}' to be 'running' (found '${current}').`,
    );
  }
  if (args.to !== "done" && args.to !== "failed" && args.to !== "halted") {
    throw err(
      "illegal_transition",
      `reconcileRunningStage target must be one of done|failed|halted (got '${args.to}').`,
    );
  }

  // For a `→done` reconciliation, record each observed merge that has NO
  // existing entry as {pr, merged_by_forge: false} (monotonic — recordOutput
  // never demotes an existing `true`).
  let next =
    args.to === "done" && args.observedMerges && args.observedMerges.length > 0
      ? recordOutput(state, {
          stage: args.stage,
          merges: args.observedMerges.map((m) => ({
            pr: m.pr,
            merged_by_forge: false,
          })),
          at: args.at,
        })
      : clone(state);

  // Enforce the same `→done` gate as `transition` (reuse T5).
  if (args.to === "done") {
    enforceDoneGate(next, args.stage, readPr);
  }

  if (args.to !== "done" && (!args.gate || !args.gate.reason)) {
    throw err(
      "gate_required",
      `reconcileRunningStage '${args.to}' for stage '${args.stage}' requires a gate {reason, detail}.`,
    );
  }

  const idx = stageIndex(next, args.stage);
  const rec = next.stages[idx];

  // Append EXACTLY ONE crashed attempt for the crashed episode. This is the
  // sole site in the codebase that produces a crashed-outcome attempt.
  rec.attempts.push({
    started_at: rec.started_at ?? args.at,
    ended_at: null,
    outcome: "crashed",
  });

  // Apply the resolving transition IN THE SAME CALL, bypassing transition's
  // normal episode-end append so the episode is archived once, never twice.
  rec.status = args.to;
  rec.ended_at = args.at;
  if (args.to === "done") {
    rec.gate = null;
  } else {
    rec.gate = { reason: args.gate!.reason, detail: args.gate!.detail ?? "" };
  }

  next.updated_at = args.at;
  return next;
}

// ---------------------------------------------------------------------------
// initializeRun — the pure run-state constructor (T7)
// ---------------------------------------------------------------------------

export function initializeRun(
  resolved: ResolvedRun,
  args: { runId: string; at: string; mode: "in-session" | "driver" },
): RunState {
  const stages: StageRecord[] = resolved.chain.map((stage) => ({
    stage,
    status: "pending",
    prs: [],
    merges: [],
    fold_prs: [],
    artifacts: {},
    gate: null,
    started_at: null,
    ended_at: null,
    attempts: [],
  }));

  return {
    slug: resolved.slug,
    run_id: args.runId,
    input: clone(resolved.input),
    initial_artifacts: clone(resolved.initial_artifacts),
    mode: args.mode,
    chain: [...resolved.chain],
    merge_points: clone(resolved.mergePoints),
    artifact_prs: {},
    repo: clone(resolved.repo),
    default_branch: resolved.default_branch,
    created_at: args.at,
    updated_at: args.at,
    abandoned_at: null,
    stages,
  };
}
