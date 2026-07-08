/**
 * review_doc_findings_lib — pure helpers for posting every doc-review finding
 * to a PR as its own *resolvable* review thread, and resolving each thread once
 * the finding is fixed.
 *
 * The stark_review_doc dispatcher already reviews + auto-fixes findings and
 * emits a JSON receipt. This module turns that receipt into a per-finding
 * work list: which findings the wing already fixed (post + auto-resolve) and
 * which still need a manual fix (post + leave open for the skill to fix, ask
 * the operator when ambiguous, then resolve). Nothing is dropped — every
 * distinct finding across every round lands on the PR.
 *
 * Pure functions only (no network / fs). The CLI in review_doc_findings.ts
 * owns the GitHub round-trips.
 */

// ─── Types ───────────────────────────────────────────────────────────────

/** Per-finding fix status derived from the dispatcher receipt. */
export type FixStatus =
  | "autofixed" // wing applied a patch and the final review no longer surfaces it
  | "unresolved" // still surfaced by the final review-only round
  | "patch_failed" // wing tried to patch but the patch didn't apply
  | "skipped" // wing explicitly declined to patch (needs judgment)
  | "below_threshold"; // classified noise/ignored — never attempted

/** A finding as it appears in the dispatcher receipt. */
export interface ReceiptFinding {
  id: string;
  agent: string;
  domain: string;
  severity: string;
  section: string;
  title: string;
  description: string;
  suggestion: string;
  classification?: string;
}

interface ReceiptFix {
  applied_finding_ids?: string[];
  skipped_finding_ids?: string[];
  patch_failures?: Array<{ finding_id: string }>;
}

interface ReceiptRound {
  round: number;
  kind: "review-fix" | "final-review";
  findings?: ReceiptFinding[];
  fix?: ReceiptFix;
}

export interface Receipt {
  rounds?: ReceiptRound[];
  unresolved?: ReceiptFinding[];
}

/** A finding collected from the receipt, tagged with its fix status. */
export interface CollectedFinding extends ReceiptFinding {
  status: FixStatus;
  /** True when the wing fixed it and the final review confirms it's gone. */
  resolved_by_wing: boolean;
  /** Round it first surfaced in (for ordering). */
  first_round: number;
}

// ─── collectFindings ───────────────────────────────────────────────────────

/**
 * De-duplicate every finding across every round into one work list, each
 * tagged with its fix status. Precedence (most-actionable wins) when the same
 * finding id appears with conflicting signals across rounds:
 *
 *   unresolved > patch_failed > skipped > below_threshold > autofixed
 *
 * A finding is `autofixed` (resolved_by_wing) only when the wing applied a
 * patch for it AND the final review-only round no longer reports it.
 */
export function collectFindings(receipt: Receipt): CollectedFinding[] {
  const rounds = receipt.rounds ?? [];

  const appliedIds = new Set<string>();
  const skippedIds = new Set<string>();
  const patchFailedIds = new Set<string>();
  for (const r of rounds) {
    for (const id of r.fix?.applied_finding_ids ?? []) appliedIds.add(id);
    for (const id of r.fix?.skipped_finding_ids ?? []) skippedIds.add(id);
    for (const pf of r.fix?.patch_failures ?? []) {
      if (pf.finding_id) patchFailedIds.add(pf.finding_id);
    }
  }

  // The final review-only round is the authoritative "still broken" signal.
  const finalRound = [...rounds].reverse().find((r) => r.kind === "final-review");
  const unresolvedIds = new Set<string>(
    (receipt.unresolved ?? []).map((f) => f.id),
  );
  // A finding surfaced by the final round is unresolved even if a prior round
  // marked it applied (the fix didn't hold).
  for (const f of finalRound?.findings ?? []) {
    if (f.classification === "fix" || f.classification === "recurring") {
      unresolvedIds.add(f.id);
    }
  }

  // First-seen record per id (prefer the earliest, most-detailed occurrence).
  const seen = new Map<string, { finding: ReceiptFinding; round: number }>();
  for (const r of rounds) {
    for (const f of r.findings ?? []) {
      if (!seen.has(f.id)) seen.set(f.id, { finding: f, round: r.round });
    }
  }
  // unresolved list may carry findings not in a round's `findings` (defensive).
  for (const f of receipt.unresolved ?? []) {
    if (!seen.has(f.id)) seen.set(f.id, { finding: f, round: Number.MAX_SAFE_INTEGER });
  }

  const out: CollectedFinding[] = [];
  for (const [id, { finding, round }] of seen) {
    let status: FixStatus;
    if (unresolvedIds.has(id)) status = "unresolved";
    else if (patchFailedIds.has(id)) status = "patch_failed";
    else if (skippedIds.has(id)) status = "skipped";
    else if (appliedIds.has(id)) status = "autofixed";
    else if (finding.classification === "noise" || finding.classification === "ignored") {
      status = "below_threshold";
    } else {
      // Surfaced, at/above threshold, never applied/skipped/failed and absent
      // from the final review — treat as unresolved so the skill still fixes it.
      status = "unresolved";
    }
    out.push({
      ...finding,
      status,
      resolved_by_wing: status === "autofixed",
      first_round: round,
    });
  }

  // Stable order: unresolved-first, then severity desc, then round asc.
  const statusRank: Record<FixStatus, number> = {
    unresolved: 0,
    patch_failed: 1,
    skipped: 2,
    below_threshold: 3,
    autofixed: 4,
  };
  const sevRank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  out.sort((a, b) => {
    const s = statusRank[a.status] - statusRank[b.status];
    if (s !== 0) return s;
    const v = (sevRank[a.severity] ?? 9) - (sevRank[b.severity] ?? 9);
    if (v !== 0) return v;
    return a.first_round - b.first_round;
  });
  return out;
}

/** Findings the skill must still fix by hand (everything the wing didn't resolve). */
export function openFindings(findings: CollectedFinding[]): CollectedFinding[] {
  return findings.filter((f) => f.status !== "autofixed");
}

// ─── Anchoring ─────────────────────────────────────────────────────────────

/**
 * Best-effort 1-based line for a finding's `section` within the doc. Used to
 * enrich the comment body with a "near line N" pointer (file-level review
 * threads don't require a valid diff line, so a miss is non-fatal).
 *
 * Order: exact heading match (a Markdown `#…` line whose text equals the
 * section) → heading containing the section → any line containing the section
 * verbatim → null.
 */
export function anchorLine(docText: string, section: string): number | null {
  const target = section.trim();
  if (!target) return null;
  const lines = docText.split("\n");
  const norm = (s: string) => s.replace(/^#+\s*/, "").trim().toLowerCase();
  const want = norm(target);

  let headingContains: number | null = null;
  let anyContains: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const isHeading = /^#+\s/.test(line);
    if (isHeading && norm(line) === want) return i + 1;
    if (isHeading && headingContains === null && norm(line).includes(want)) {
      headingContains = i + 1;
    }
    if (anyContains === null && line.toLowerCase().includes(target.toLowerCase())) {
      anyContains = i + 1;
    }
  }
  return headingContains ?? anyContains;
}

// ─── Comment rendering ─────────────────────────────────────────────────────

/** HTML marker embedded in every finding comment for idempotent re-runs. */
export function findingMarker(id: string): string {
  return `<!-- stark-review-finding:${id} -->`;
}

/** Extract a finding id from a comment body's marker, or null. */
export function parseFindingMarker(body: string): string | null {
  const m = body.match(/<!--\s*stark-review-finding:([^\s>]+)\s*-->/);
  return m ? m[1]! : null;
}

const SEV_EMOJI: Record<string, string> = {
  critical: "🟥",
  high: "🟧",
  medium: "🟨",
  low: "⬜",
};

/** The per-finding review-comment body. */
export function renderFindingComment(
  f: CollectedFinding,
  opts: { line?: number | null } = {},
): string {
  const sev = f.severity.toLowerCase();
  const emoji = SEV_EMOJI[sev] ?? "•";
  const near = opts.line ? ` · near line ${opts.line}` : "";
  const lines: string[] = [
    `${emoji} **[${sev}] ${f.domain}: ${f.title}**`,
    "",
    f.description.trim(),
  ];
  if (f.suggestion && f.suggestion.trim()) {
    lines.push("", `**Suggested fix:** ${f.suggestion.trim()}`);
  }
  lines.push(
    "",
    `<sub>Section: \`${f.section}\`${near} · finding \`${f.id}\` · reviewer: ${f.agent}</sub>`,
    "",
    findingMarker(f.id),
  );
  return lines.join("\n");
}

/** Reply body used when auto-resolving a finding the wing already fixed. */
export function renderAutofixReply(commitSha?: string | null): string {
  const at = commitSha ? ` (\`${commitSha.slice(0, 8)}\`)` : "";
  return `✅ Resolved automatically by the review wing — the fix was applied to this doc on the PR${at}.`;
}

/** Reply body used when a finding was fixed by hand and the thread is resolved. */
export function renderManualFixReply(opts: {
  summary: string;
  commitSha?: string | null;
}): string {
  const at = opts.commitSha ? ` (\`${opts.commitSha.slice(0, 8)}\`)` : "";
  return `✅ Fixed${at}: ${opts.summary.trim()}`;
}
