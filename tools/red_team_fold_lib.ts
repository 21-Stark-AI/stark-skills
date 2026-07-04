// tools/red_team_fold_lib.ts
//
// Fold orchestrator types + hash-guarded fix-plan run selection (rt4).
//
// `resolveFixPlanForFold` is the stale-guard at the heart of the fold
// pipeline: it decides which prior fix-plan run (if any) is safe to fold
// into the artifact currently on disk. A fix plan is only ever adopted
// when the caller can prove it was generated against the artifact text as
// it exists *right now* (sidecar hash match), or when the operator has
// explicitly named the run they want folded (source-run-id'd DB
// fallback). It never silently picks "whatever's latest" — that would risk
// folding a stale or foreign plan into an artifact that has since moved on.
import { createHash } from "node:crypto";
import { extractVerdictJson, isPlainObject } from "./copilot_dispatch.ts";
import { parseFixPlanOutput } from "./red_team_lib.ts";
import type { FixPlanMove, RedTeamFixPlan } from "./red_team_lib.ts";
import { applyPatches, type FixerPatch } from "./stark_review_doc_lib.ts";

/** Outcome the fold host applies to a single fix-plan move. */
export type Disposition = "accept" | "modify" | "reject" | "apply_failed";

/** A concrete text edit proposed for one move (old → new). */
export interface FoldPatch {
  move_id: string;
  old: string;
  new: string;
}

/** Per-move fold decision + audit trail, one per `FixPlanMove`. */
export interface MoveDisposition {
  move_id: string;
  addressed_finding_ids: string[];
  disposition: Disposition;
  rationale: string;
  patch: FoldPatch | null;
  move_snapshot_json: string;
}

/** A resolved fix plan plus provenance: which run produced it, and the
 *  artifact hash it was resolved against (the *current* artifact's hash,
 *  not necessarily the hash recorded at generation time). */
export interface FixPlanSource {
  fixPlan: RedTeamFixPlan;
  sourceRunId: string;
  artifactHash: string;
}

/** SHA-256 hex digest of a string, UTF-8 encoded. */
export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

interface ResolveOpts {
  artifactText: string;
  sidecar: { fixPlanJson: string | null; runId: string | null; artifactHash: string | null } | null;
  explicitFixPlanJson: string | null;
  dbLatest: { fixPlanJson: string; runId: string; artifactHash: string } | null;
  sourceRunId: string | null;
  forceStale: boolean;
}

/**
 * Resolve which fix plan (if any) the fold host should apply, in strict
 * precedence order:
 *
 *   1. Explicit override (`explicitFixPlanJson`, e.g. `--fix-plan-json`)
 *      always wins — the caller handed us the plan directly, so there is
 *      no staleness question to ask.
 *   2. The adjacent sidecar — only when its recorded `artifactHash`
 *      matches the current artifact's hash (or `forceStale` is set). A
 *      mismatch means the artifact was edited since the plan was
 *      generated, so it is rejected as `stale_fix_plan` rather than
 *      silently folded.
 *   3. The DB's latest run for this artifact — but *only* when the caller
 *      passes an explicit `sourceRunId` naming the run they intend to
 *      fold. There is no "just use latest" path: `dbLatest` present with
 *      no `sourceRunId` is `source_run_id_required`, never a silent
 *      auto-pick.
 *   4. Otherwise `no_fix_plan_found`.
 */
export function resolveFixPlanForFold(opts: ResolveOpts): {
  source: FixPlanSource | null;
  status: "ok" | "no_fix_plan_found" | "stale_fix_plan" | "source_run_id_required";
} {
  const curHash = sha256Hex(opts.artifactText);

  // 1) explicit override
  if (opts.explicitFixPlanJson) {
    return {
      status: "ok",
      source: {
        fixPlan: JSON.parse(opts.explicitFixPlanJson),
        sourceRunId: opts.sourceRunId ?? "explicit",
        artifactHash: curHash,
      },
    };
  }

  // 2) adjacent sidecar — only on hash match (rt4)
  if (opts.sidecar?.fixPlanJson && opts.sidecar.runId) {
    if (opts.sidecar.artifactHash === curHash || opts.forceStale) {
      return {
        status: "ok",
        source: {
          fixPlan: JSON.parse(opts.sidecar.fixPlanJson),
          sourceRunId: opts.sidecar.runId,
          artifactHash: curHash,
        },
      };
    }
    return { status: "stale_fix_plan", source: null };
  }

  // 3) DB fallback — only with explicit --source-run-id (never "latest")
  if (opts.dbLatest) {
    if (!opts.sourceRunId) return { status: "source_run_id_required", source: null };
    if (opts.dbLatest.artifactHash !== curHash && !opts.forceStale) {
      return { status: "stale_fix_plan", source: null };
    }
    return {
      status: "ok",
      source: {
        fixPlan: JSON.parse(opts.dbLatest.fixPlanJson),
        sourceRunId: opts.dbLatest.runId,
        artifactHash: curHash,
      },
    };
  }

  return { status: "no_fix_plan_found", source: null };
}

/** Coerce to a string, or `""` for anything that isn't one. */
function strOrEmpty(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Parse the disposition decider's raw JSON output into validated
 * `MoveDisposition[]` plus an `invalid[]` list of rejected rows.
 *
 * Extraction: `extractVerdictJson` only matches a top-level object carrying
 * a `"verdict"` key (the copilot lead/wing review shape) — the decider's
 * `{summary, dispositions}` envelope never has one, so it is tried first
 * (in case a future prompt revision wraps dispositions in a verdict
 * envelope) and, when it comes back without a `dispositions` array, this
 * falls back to `parseFixPlanOutput` — the same best-effort JSON-object
 * extraction (direct parse → fenced ```block → first `{`..last `}` slice,
 * no required key) already used for the structurally-identical fix-plan
 * envelope — rather than re-implementing that scan here.
 *
 * Validation, per row: `move_id` must match one of `moves`; `disposition`
 * must be `accept` | `modify` | `reject`; `rationale` must be non-empty;
 * `accept`/`modify` additionally require `patch.old` non-empty. Anything
 * failing a rule is dropped into `invalid[]` with a reason string instead
 * of the output array.
 */
export function parseDispositions(
  rawOutput: string,
  moves: FixPlanMove[],
): { dispositions: MoveDisposition[]; invalid: Array<{ move_id: string; reason: string }> } {
  const dispositions: MoveDisposition[] = [];
  const invalid: Array<{ move_id: string; reason: string }> = [];
  const byId = new Map(moves.map((m) => [m.id, m]));

  const fromVerdict = extractVerdictJson(rawOutput);
  const obj: Record<string, unknown> =
    fromVerdict && Array.isArray(fromVerdict["dispositions"]) ? fromVerdict : parseFixPlanOutput(rawOutput);
  const rows: unknown[] = Array.isArray(obj["dispositions"]) ? (obj["dispositions"] as unknown[]) : [];

  for (const rawRow of rows) {
    const r: Record<string, unknown> = isPlainObject(rawRow) ? rawRow : {};

    const moveId = strOrEmpty(r["move_id"]);
    const move = byId.get(moveId);
    if (!move) {
      invalid.push({ move_id: moveId || "(missing)", reason: "unknown_move_id" });
      continue;
    }

    const dispRaw = r["disposition"];
    const disp: "accept" | "modify" | "reject" | null =
      dispRaw === "accept" || dispRaw === "modify" || dispRaw === "reject" ? dispRaw : null;
    if (!disp) {
      invalid.push({ move_id: moveId, reason: "bad_disposition" });
      continue;
    }

    const rationale = strOrEmpty(r["rationale"]).trim();
    if (!rationale) {
      invalid.push({ move_id: moveId, reason: "empty_rationale" });
      continue;
    }

    let patch: FoldPatch | null = null;
    if (disp === "accept" || disp === "modify") {
      const patchObj: Record<string, unknown> = isPlainObject(r["patch"]) ? r["patch"] : {};
      const old = strOrEmpty(patchObj["old"]);
      const nw = strOrEmpty(patchObj["new"]);
      if (!old) {
        invalid.push({ move_id: moveId, reason: "accept_without_patch" });
        continue;
      }
      patch = { move_id: moveId, old, new: nw };
    }

    const addressedRaw = r["addressed_finding_ids"];
    const addressed_finding_ids = Array.isArray(addressedRaw)
      ? addressedRaw.map((x) => String(x))
      : move.addressed_finding_ids;

    dispositions.push({
      move_id: moveId,
      addressed_finding_ids,
      disposition: disp,
      rationale,
      patch,
      move_snapshot_json: JSON.stringify(move),
    });
  }

  return { dispositions, invalid };
}

/**
 * Apply the `accept`/`modify` dispositions' patches to `doc` via the shared
 * `applyPatches` engine, then reconcile the outcome back onto the
 * disposition list.
 *
 * `reject` dispositions (and any `accept`/`modify` row with a null `patch`,
 * which `parseDispositions` never emits but a caller-constructed list could)
 * contribute no patch and pass through untouched. Every patch that
 * `applyPatches` could not land — `old` absent or non-unique in the current
 * document — flips that move's disposition to `apply_failed`; its
 * `rationale` (and every other field) is preserved so the audit trail still
 * shows *why* the decider wanted the change, just not that it landed.
 * Successfully applied patches keep their original `accept`/`modify`
 * disposition.
 */
export function applyFold(
  doc: string,
  dispositions: MoveDisposition[],
): { newDoc: string; dispositions: MoveDisposition[] } {
  const toApply = dispositions.filter(
    (d) => d.patch && (d.disposition === "accept" || d.disposition === "modify"),
  );
  const patches: FixerPatch[] = toApply.map((d) => ({
    finding_id: d.move_id,
    old: d.patch!.old,
    new: d.patch!.new,
  }));
  const res = applyPatches(doc, patches);
  const failedMoveIds = new Set(res.failures.map((f) => f.patch.finding_id));
  const out = dispositions.map((d) =>
    failedMoveIds.has(d.move_id) ? { ...d, disposition: "apply_failed" as Disposition } : d,
  );
  return { newDoc: res.newDoc, dispositions: out };
}
