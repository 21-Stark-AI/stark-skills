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
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  buildClaudeCmd,
  collectJsonCandidates,
  isPlainObject,
  resolveModel,
} from "./copilot_dispatch.ts";
import { assetPromptsDir } from "./asset_root_lib.ts";

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

// ── Dispatch primitives (#699) ───────────────────────────────────────────
//
// The deterministic, individually-testable building blocks the lead/wing
// loop composes: the slug contract, the command boundary (least-privilege
// no-tools for claude, read-only for codex), the claude JSON envelope parse,
// and in-band contract delivery. Kept apart from the state machine so each
// surface is provable on its own.

/**
 * Derive the spec slug from the `--out` path ALONE. The basename must match
 * `docs/specs/YYYY-MM-DD-<slug>-spec.md`; the `<slug>` capture is returned.
 *
 * There is deliberately NO `--slug` flag — the slug is a pure function of the
 * out path, so a caller can never desync the filename from the slug. A
 * non-conforming path throws rather than guessing.
 */
export function deriveSlugFromOut(outPath: string): string {
  const base = path.basename(outPath);
  const m = /^\d{4}-\d{2}-\d{2}-(?<slug>.+)-spec\.md$/.exec(base);
  if (!m || !m.groups?.slug) {
    throw new Error(
      `out path must match docs/specs/YYYY-MM-DD-<slug>-spec.md; got ${base}`,
    );
  }
  return m.groups.slug;
}

/**
 * Tools every write-spec agent is forbidden from using. Copied VERBATIM from
 * `red_team_fold_lib.ts::DECIDER_DISALLOWED_TOOLS` (the fold decider's
 * disallowedTools) — the write-spec lead/wing only emit spec text + JSON
 * verdicts over an in-band contract, so they need zero tools. Disabling the
 * mutating/exfil primitives means even a jailbroken model has no Bash/Write/
 * WebFetch primitive to run a command, touch the filesystem, or make a
 * network call from inside the subprocess.
 */
export const NO_TOOLS = [
  "Bash",
  "Edit",
  "Write",
  "Read",
  "WebFetch",
  "WebSearch",
  "Task",
  "NotebookEdit",
] as const;

/** Which write-spec agent a command is being built for. */
export type WriteSpecAgent = "claude" | "codex";

/** A resolved subprocess argv. */
export interface AgentCommand {
  cmd: string;
  args: string[];
}

/**
 * Claude argv: the shared headless-Claude command (`buildClaudeCmd`,
 * `--output-format json`) with NO tools grantable (empty `allowedTools`, so
 * `--allowedTools` is never emitted) plus `--disallowedTools <NO_TOOLS...>`
 * appended at the END (mirrors `red_team_fold_lib.ts::buildDeciderCommand`).
 */
function claudeAgentCmd(): AgentCommand {
  const built = buildClaudeCmd({ outputFormat: "json", allowedTools: "" });
  return { cmd: built.cmd, args: [...built.args, "--disallowedTools", ...NO_TOOLS] };
}

/**
 * Codex argv: `codex exec` at the given reasoning effort, `-s read-only`
 * (never mutates the target), prompt on stdin (`-`). Mirrors
 * `copilot_dispatch.ts::buildCodexCmd`.
 */
function codexAgentCmd(effort: "high" | "xhigh"): AgentCommand {
  return {
    cmd: "codex",
    args: [
      "exec",
      "-m", resolveModel("codex"),
      "-c", `model_reasoning_effort="${effort}"`,
      "--ephemeral", "--json",
      "-s", "read-only",
      "-",
    ],
  };
}

/**
 * Build the LEAD (spec author) command for `agent`. Claude runs no-tools;
 * codex runs read-only at `high` effort.
 */
export function buildLeadCmd(agent: WriteSpecAgent): AgentCommand {
  return agent === "codex" ? codexAgentCmd("high") : claudeAgentCmd();
}

/**
 * Build the WING (contract verifier) command for `agent`. Claude runs
 * no-tools; codex runs read-only at `xhigh` effort (the adversarial pass gets
 * the higher reasoning budget).
 */
export function buildWingCmd(agent: WriteSpecAgent): AgentCommand {
  return agent === "codex" ? codexAgentCmd("xhigh") : claudeAgentCmd();
}

/** The text + token usage unwrapped from a claude `--output-format json` run. */
export interface ClaudeEnvelope {
  text: string;
  usage: Record<string, unknown> | null;
}

/**
 * Parse claude's `--output-format json` stdout envelope
 * (`{"result": "...", "usage": {...}}`) into `{text, usage}`. On any parse
 * failure the raw stdout is returned verbatim as `text` with `usage: null`,
 * so a non-JSON reply (or a plain-text CLI) still surfaces its content.
 */
export function parseClaudeJson(raw: string): ClaudeEnvelope {
  try {
    const obj = JSON.parse(raw);
    if (isPlainObject(obj)) {
      const result = obj["result"];
      const usage = obj["usage"];
      return {
        text: typeof result === "string" ? result : "",
        usage: isPlainObject(usage) ? usage : null,
      };
    }
  } catch {
    /* not JSON — fall through to raw passthrough */
  }
  return { text: raw, usage: null };
}

/** Header the contract is prepended under, so every agent sees it in-band. */
export const CONTRACT_HEADER =
  "## Spec Contract (authoritative — the 9 sections and their done-when bars)";

/**
 * Read + validate the spec contract asset ONCE, from
 * `<assetPromptsDir>/write-spec/contract.md`. This is the SOLE file reader in
 * this module — `composePrompt` is pure and takes the returned text as an
 * argument. Throws if the file is missing or empty (an agent with no file
 * tools must receive the contract in-band; a silent empty contract would let
 * the loop run with no done-when bars).
 */
export function loadContractText(): string {
  const p = path.join(assetPromptsDir(), "write-spec", "contract.md");
  let text: string;
  try {
    text = readFileSync(p, "utf8");
  } catch (e) {
    throw new Error(`spec contract not found at ${p}: ${(e as Error).message}`);
  }
  if (text.trim().length === 0) {
    throw new Error(`spec contract at ${p} is empty`);
  }
  return text;
}

/**
 * Compose the full prompt sent to a write-spec agent. PURE — no file IO; the
 * caller passes `contractText` (from `loadContractText`, read once at dispatch
 * start). The authoritative contract is prepended under `CONTRACT_HEADER`, so
 * every generate/verify/revise request carries the 9 sections + done-when bars
 * in-band (the agents have no file tools to fetch them), followed by the
 * per-agent template and the concrete brief.
 */
export function composePrompt(
  agentPromptText: string,
  contractText: string,
  briefText: string,
): string {
  return [
    CONTRACT_HEADER,
    "",
    contractText.trimEnd(),
    "",
    agentPromptText.trimEnd(),
    "",
    briefText.trimEnd(),
  ].join("\n");
}
