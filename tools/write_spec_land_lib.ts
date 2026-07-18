/**
 * write_spec_land_lib.ts — pure, individually-testable helpers for the
 * `/stark-write-spec` create-or-adopt PR landing flow (#706).
 *
 * The CLI (`write_spec_land.ts`) owns every git + PR side effect; THIS module
 * owns the deterministic decisions that make the flow idempotent and provable
 * without touching a real repo or GitHub:
 *
 *  - `appForLead`       — which GitHub App authors the PR (lead → App identity).
 *  - `planBranchAction` — the three-way branch decision (STANDARDIZED union:
 *                         checkout-ff | checkout-track | create).
 *  - `shouldSkipCommit` — skip the commit when nothing is staged (idempotent
 *                         re-run).
 *  - `pickPrForHead`    — adopt an existing open PR by head ref.
 *  - `buildOwnedBlock`  — the marker-delimited coverage block we own in a PR
 *                         body, assembled from the run receipt + accepted gaps.
 *  - `mergePrBody`      — replace-in-place OR append that owned block, never
 *                         disturbing any non-owned prose.
 *  - `shouldRunGitStep` — the dry-run gate.
 *
 * ACCEPTED-GAPS FILE SCHEMA (defined HERE, consumed by publish + buildOwnedBlock
 * + the skill's 5-3 step): a JSON array of `{ section, status, note }` — one
 * entry per non-satisfied / n_a contract item the operator has deliberately
 * accepted. `section` is a SectionId, `status`/`note` are free strings.
 */
import type { AppName } from "./github_app_lib.ts";
import {
  SECTION_IDS,
  type ContractItem,
  type SectionId,
  type WriteSpecAgent,
  type WriteSpecReceipt,
} from "./write_spec_lib.ts";

// ── Accepted-gaps schema (defined here, self-contained) ─────────────────────

/**
 * One operator-accepted coverage gap. The exact shape of each element of the
 * accepted-gaps.json array: a `section` (a known SectionId), a `status`
 * (typically the contract status that was accepted, e.g. `underspecified`,
 * `n_a`), and a human `note` explaining why the gap is acceptable.
 */
export interface AcceptedGap {
  section: SectionId;
  status: string;
  note: string;
}

const SECTION_ID_SET: ReadonlySet<string> = new Set(SECTION_IDS);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Parse + validate the accepted-gaps.json payload into a trusted
 * `AcceptedGap[]`. Accepts a JSON array of `{section,status,note}`. Any entry
 * whose `section` is not a known SectionId is DROPPED (never trusted); missing
 * `status`/`note` coerce to `""`. A non-array top level throws (the file's
 * contract is an array). Returns `[]` for `null`/`undefined` (no file passed).
 */
export function parseAcceptedGaps(raw: unknown): AcceptedGap[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error("accepted-gaps.json must be a JSON array of {section,status,note}");
  }
  const out: AcceptedGap[] = [];
  for (const entry of raw) {
    if (!isPlainObject(entry)) continue;
    const section = entry["section"];
    if (typeof section !== "string" || !SECTION_ID_SET.has(section)) continue;
    out.push({
      section: section as SectionId,
      status: typeof entry["status"] === "string" ? entry["status"] : "",
      note: typeof entry["note"] === "string" ? entry["note"] : "",
    });
  }
  return out;
}

// ── Lead → App identity ─────────────────────────────────────────────────────

/**
 * The GitHub App that authors the PR for a given lead agent. Only `claude` and
 * `codex` are valid write-spec leads (v1), so the mapping is total over the
 * `WriteSpecAgent` union: codex → stark-codex, everything else → stark-claude.
 *
 * NOTE (#705 review, dedup finding): consuming a shared mapping was considered
 * and REJECTED — the nearest registry, `AGENTS` in dispatcher_base_lib.ts, is an
 * enabled-filtered snapshot (a config-disabled agent drops out, so a lookup
 * could miss), and the only total map (`ALL_AGENTS`) is unexported. No clean
 * shared exported agent→App mapping exists, so `appForLead` stays the home; the
 * codebase already tolerates per-tool copies of this policy.
 */
export function appForLead(lead: WriteSpecAgent | string): AppName {
  return lead === "codex" ? "stark-codex" : "stark-claude";
}

// ── Branch action ───────────────────────────────────────────────────────────

/**
 * The STANDARDIZED three-way branch decision union. `checkout-ff` is the
 * existing-local fast-forward path (checkout + fetch + `merge --ff-only`);
 * `checkout-track` creates a local tracking branch from an existing remote;
 * `create` opens a brand-new branch. There is deliberately NO bare `checkout`
 * — every existing-local path is the fast-forward path.
 */
export type BranchAction = "checkout-ff" | "checkout-track" | "create";

/**
 * Decide the branch action from what already exists. Local wins (adopt +
 * fast-forward), else an existing remote is tracked, else a fresh branch is
 * created. Pure — the CLI performs the git for the returned action.
 */
export function planBranchAction(
  localExists: boolean,
  remoteExists: boolean,
): BranchAction {
  if (localExists) return "checkout-ff";
  if (remoteExists) return "checkout-track";
  return "create";
}

// ── Commit / git gates ──────────────────────────────────────────────────────

/**
 * Skip the commit iff nothing is staged. A re-run that stages no changes (the
 * spec is byte-identical to what's already committed) must not create an empty
 * commit — the flow stays idempotent.
 */
export function shouldSkipCommit(stagedDiffEmpty: boolean): boolean {
  return stagedDiffEmpty === true;
}

/** Whether git/PR side effects run at all. A dry run performs none. */
export function shouldRunGitStep(dryRun: boolean): boolean {
  return dryRun !== true;
}

// ── PR adoption ─────────────────────────────────────────────────────────────

/** The subset of an open-PR object this module reads. */
export interface OpenPr {
  number: number;
  head?: { ref?: string };
  draft?: boolean;
  html_url?: string;
  body?: string | null;
}

/**
 * Pick the open PR whose head branch is `headRef`, or null if none matches.
 * First match wins (GitHub allows only one open PR per head ref, so at most
 * one can match). Tolerant of malformed entries (missing `head`/`ref`).
 */
export function pickPrForHead(
  openPrs: readonly OpenPr[],
  headRef: string,
): OpenPr | null {
  for (const pr of openPrs) {
    if (pr && pr.head && pr.head.ref === headRef) return pr;
  }
  return null;
}

// ── Owned PR-body block + merge ─────────────────────────────────────────────

/**
 * Paired markers bounding the span of a PR body THIS tool owns. Everything
 * between them is regenerated on each run; everything outside is preserved
 * verbatim. HTML comments so they render invisibly on GitHub.
 */
export const OWNED_BLOCK_START = "<!-- stark-write-spec:owned:start -->";
export const OWNED_BLOCK_END = "<!-- stark-write-spec:owned:end -->";

function statusEmoji(status: string): string {
  switch (status) {
    case "satisfied":
      return "✅";
    case "n_a":
      return "➖";
    case "over_scoped":
      return "✂️";
    default:
      return "⚠️";
  }
}

/** Escape a cell value so a stray `|` / newline can't break the markdown table. */
function cell(v: string): string {
  return v.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

/**
 * Build the owned coverage block (marker-delimited) from the run receipt and
 * the operator-accepted gaps. Renders a contract-coverage table over EVERY
 * SECTION_IDS item, plus an Accepted Gaps table when any gaps were accepted.
 * The returned string INCLUDES both markers, so it can be handed straight to
 * {@link mergePrBody}. Pure — no IO.
 */
export function buildOwnedBlock(
  receipt: Pick<WriteSpecReceipt, "final_verdict" | "contract_status" | "summary" | "cost_usd">,
  acceptedGaps: readonly AcceptedGap[] = [],
): string {
  const lines: string[] = [];
  lines.push(OWNED_BLOCK_START);
  lines.push("## Spec contract coverage");
  lines.push("");
  lines.push(`_Verdict: \`${receipt.final_verdict}\`_`);
  lines.push("");
  lines.push("| Section | Status | Note |");
  lines.push("| --- | --- | --- |");
  const bySection = new Map<string, ContractItem>();
  for (const it of receipt.contract_status ?? []) bySection.set(it.section, it);
  for (const id of SECTION_IDS) {
    const it = bySection.get(id);
    const status = it?.status ?? "missing";
    const note = it?.note ?? "";
    lines.push(`| \`${id}\` | ${statusEmoji(status)} ${status} | ${cell(note) || "—"} |`);
  }

  if (acceptedGaps.length > 0) {
    lines.push("");
    lines.push("### Accepted gaps");
    lines.push("");
    lines.push("| Section | Status | Note |");
    lines.push("| --- | --- | --- |");
    for (const g of acceptedGaps) {
      lines.push(`| \`${g.section}\` | ${cell(g.status) || "—"} | ${cell(g.note) || "—"} |`);
    }
  }

  if (receipt.summary && receipt.summary.trim()) {
    lines.push("");
    lines.push(`> ${cell(receipt.summary)}`);
  }
  if (typeof receipt.cost_usd === "number") {
    lines.push("");
    lines.push(`<sub>cost: $${receipt.cost_usd.toFixed(4)}</sub>`);
  }
  lines.push(OWNED_BLOCK_END);
  return lines.join("\n");
}

/**
 * Merge `ownedBlock` (which already carries the paired markers) into an
 * existing PR body:
 *
 *  - Empty/blank existing body → the owned block VERBATIM.
 *  - Existing owned span present → replace it IN PLACE, preserving everything
 *    before and after the span byte-for-byte.
 *  - No owned span → append the block (blank line separator), preserving the
 *    existing prose verbatim.
 *
 * Idempotent: `mergePrBody(mergePrBody(b, blk), blk) === mergePrBody(b, blk)`
 * for any body `b` and block `blk`. Never wholesale-overwrites a body.
 */
export function mergePrBody(existingBody: string | null | undefined, ownedBlock: string): string {
  const body = existingBody ?? "";
  if (body.trim() === "") return ownedBlock;

  const startIdx = body.indexOf(OWNED_BLOCK_START);
  const endIdx = body.indexOf(OWNED_BLOCK_END);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = body.slice(0, startIdx);
    const after = body.slice(endIdx + OWNED_BLOCK_END.length);
    return before + ownedBlock + after;
  }
  // No owned span — append, preserving the existing content verbatim.
  return body.replace(/\s+$/, "") + "\n\n" + ownedBlock + "\n";
}
