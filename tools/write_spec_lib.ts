/**
 * write_spec_lib.ts — SECTION_IDS parser + contract verdict extractor.
 *
 * The structural bound the /stark-write-spec design rests on: a closed-enum
 * verdict over a fixed, host-owned id set. Because the wing may only speak in
 * terms of SECTION_IDS, the loop cannot grow the spec's sections, and the host
 * never trusts the wing's `done` — it recomputes it over the full id set.
 *
 * `extractContractVerdictJson` is deliberately distinct from copilot's
 * `extractVerdictJson`: a contract verdict has `items`/`done`/`summary` and NO
 * `verdict` key, so the two must never grab each other's objects. Both share
 * the `collectJsonCandidates` scan (copilot_dispatch.ts) to avoid drift.
 */
import { collectJsonCandidates, isPlainObject } from "./copilot_dispatch.ts";

/**
 * The sole runtime authority for spec section ids. A host typed literal — the
 * contract asset (global/prompts/write-spec/contract.md) mirrors these, but a
 * 10th asset id is dropped at runtime until this literal is deliberately edited.
 */
export const SECTION_IDS = [
  "intent",
  "scope",
  "interfaces",
  "behavior",
  "ssot",
  "security",
  "test-plan",
  "accessibility",
  "open-questions",
] as const;

export type SectionId = (typeof SECTION_IDS)[number];

/**
 * Per-section coverage status. `done` requires every section satisfied or a
 * reasoned `n_a`. `over_scoped` (the #677 bidirectional-gate lesson — the wing
 * asking to cut excessive scope) is a valid revise signal that blocks `done`
 * just like `underspecified`/`missing`.
 */
export const STATUS_VALUES = [
  "satisfied",
  "underspecified",
  "n_a",
  "missing",
  "over_scoped",
] as const;

export type Status = (typeof STATUS_VALUES)[number];

export interface ContractItem {
  section: SectionId;
  status: Status;
  note: string;
}

export interface ContractVerdict {
  items: ContractItem[];
  done: boolean;
  summary: string;
}

export interface NormalizedContractVerdict {
  verdict: ContractVerdict;
  droppedSections: string[];
}

const SECTION_ID_SET: ReadonlySet<string> = new Set(SECTION_IDS);
const STATUS_SET: ReadonlySet<string> = new Set(STATUS_VALUES);

function isSectionId(v: unknown): v is SectionId {
  return typeof v === "string" && SECTION_ID_SET.has(v);
}

/**
 * A section is satisfied for `done` purposes when it is `satisfied` or a
 * reasoned `n_a`. `underspecified`/`missing` (and reason-less `n_a`, which is
 * downgraded to `underspecified` upstream) all block.
 */
function statusCounts(status: Status): boolean {
  return status === "satisfied" || status === "n_a";
}

/**
 * Host-side `done` recomputation over the FULL SECTION_IDS set. Never trusts
 * the wing's `done`: every known section must be present and satisfied/n_a.
 */
export function computeDone(items: ContractItem[]): boolean {
  const bySection = new Map<string, ContractItem>();
  for (const it of items) bySection.set(it.section, it);
  for (const id of SECTION_IDS) {
    const it = bySection.get(id);
    if (!it || !statusCounts(it.status)) return false;
  }
  return true;
}

/**
 * Extract the LAST JSON candidate that parses to a contract-shaped verdict:
 * a plain object with an `items` array AND a `done` key. Deliberately rejects
 * copilot verdict objects (`{verdict: ...}`) — they have no `items`/`done`.
 * Returns the raw parsed object (pre-normalization) or null.
 */
export function extractContractVerdictJson(
  text: string,
): Record<string, unknown> | null {
  const candidates = collectJsonCandidates(text);
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(candidates[i]!);
      if (isPlainObject(obj) && Array.isArray(obj["items"]) && "done" in obj) {
        return obj;
      }
    } catch { /* skip */ }
  }
  return null;
}

function coerceString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Normalize a raw parsed contract verdict into a trusted ContractVerdict.
 *
 * - Drops items whose `section` is not in SECTION_IDS (recorded in the
 *   camelCase `droppedSections` return field).
 * - Coerces unknown `status` to `underspecified`.
 * - Downgrades reason-less `n_a` to `underspecified` (an unexplained
 *   not-applicable is not trustworthy coverage).
 * - Synthesizes a `missing` item for any absent known id.
 * - Recomputes `done` host-side over the full SECTION_IDS set via computeDone
 *   (never trusting the wing's `done`).
 *
 * The public field name is `droppedSections` everywhere — snake_case
 * `dropped_sections` is NOT used.
 */
export function normalizeContractVerdict(
  raw: unknown,
): NormalizedContractVerdict {
  const droppedSections: string[] = [];
  const bySection = new Map<SectionId, ContractItem>();

  const rawItems =
    isPlainObject(raw) && Array.isArray(raw["items"]) ? raw["items"] : [];

  for (const entry of rawItems) {
    if (!isPlainObject(entry)) continue;
    const section = entry["section"];
    if (!isSectionId(section)) {
      if (typeof section === "string" && section.length > 0) {
        droppedSections.push(section);
      }
      continue;
    }
    let status: Status = STATUS_SET.has(entry["status"] as string)
      ? (entry["status"] as Status)
      : "underspecified";
    const note = coerceString(entry["note"]);
    // Reason-less n_a is not trustworthy coverage → downgrade to underspecified.
    if (status === "n_a" && note.trim().length === 0) {
      status = "underspecified";
    }
    // First occurrence of a known section wins; ignore later duplicates.
    if (!bySection.has(section)) {
      bySection.set(section, { section, status, note });
    }
  }

  // Synthesize a `missing` item for any absent known id.
  for (const id of SECTION_IDS) {
    if (!bySection.has(id)) {
      bySection.set(id, { section: id, status: "missing", note: "" });
    }
  }

  // Emit items in canonical SECTION_IDS order.
  const items: ContractItem[] = SECTION_IDS.map((id) => bySection.get(id)!);
  const summary = isPlainObject(raw) ? coerceString(raw["summary"]) : "";

  return {
    verdict: { items, done: computeDone(items), summary },
    droppedSections,
  };
}
