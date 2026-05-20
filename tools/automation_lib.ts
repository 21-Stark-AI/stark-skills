/**
 * Automation fleet utilities — TypeScript port of the
 * `scripts/automation/` package (`logs.py` + `schema.py`).
 *
 * Two concerns, one self-contained module:
 *   - Prepend-only markdown run logs (`prependRunRecord` / `parseRunHistory`)
 *   - Registry schema loading + validation (`loadRegistry`)
 */

import fs from "node:fs";

// ---------------------------------------------------------------------------
// Prepend-only markdown run logs (port of automation/logs.py)
// ---------------------------------------------------------------------------

/**
 * Insert a run record after the `<!-- schema_version: 1 -->` comment, or
 * after the first H1, or at the top if neither is present.
 */
export function prependRunRecord(logPath: string, runMarkdown: string): void {
  const content = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
  const lines = content.split("\n");

  let insertIdx: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("<!-- schema_version: 1 -->")) {
      insertIdx = i + 1;
      break;
    }
  }
  if (insertIdx === null) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("# ")) {
        insertIdx = i + 1;
        break;
      }
    }
  }
  if (insertIdx === null) insertIdx = 0;

  const insertion = `${runMarkdown}\n---\n`;
  lines.splice(insertIdx, 0, insertion);
  fs.writeFileSync(logPath, lines.join("\n"));
}

export interface RunRecord {
  timestamp?: string;
  status?: string;
  duration_s?: number;
  tokens?: { prompt: number; completion: number; total: number };
  cost_usd?: number;
  findings?: number;
  actions?: string;
  error?: string;
}

/** First capture group of a non-global regex match, or null. */
function firstGroup(re: RegExp, text: string): string | null {
  const m = text.match(re);
  return m ? m[1] : null;
}

/** Parse a prepend-only markdown log into structured run records. */
export function parseRunHistory(logPath: string): RunRecord[] {
  if (!fs.existsSync(logPath)) return [];

  const content = fs.readFileSync(logPath, "utf8");
  // Split on `## Run ` headers, keeping the delimiter (lookahead split).
  const blocks = content.split(/(?=^## Run )/m);

  const records: RunRecord[] = [];
  for (const raw of blocks) {
    const block = raw.trim();
    if (!block.startsWith("## Run ")) continue;

    const record: RunRecord = {};

    const ts = firstGroup(/^## Run (.+)/, block);
    if (ts !== null) record.timestamp = ts.trim();

    const status = firstGroup(/[*-]\s*\*?\*?Status\*?\*?:\s*(.+)/, block);
    if (status !== null) record.status = status.trim();

    const duration = firstGroup(/[*-]\s*\*?\*?Duration\*?\*?:\s*([\d.]+)/, block);
    if (duration !== null) record.duration_s = Number(duration);

    const promptTok = firstGroup(/[*-]\s*\*?\*?Prompt tokens\*?\*?:\s*(\d+)/, block);
    const completionTok = firstGroup(/[*-]\s*\*?\*?Completion tokens\*?\*?:\s*(\d+)/, block);
    const totalTok = firstGroup(/[*-]\s*\*?\*?Total tokens\*?\*?:\s*(\d+)/, block);
    if (promptTok !== null || completionTok !== null || totalTok !== null) {
      record.tokens = {
        prompt: promptTok !== null ? Number(promptTok) : 0,
        completion: completionTok !== null ? Number(completionTok) : 0,
        total: totalTok !== null ? Number(totalTok) : 0,
      };
    }

    const cost = firstGroup(/[*-]\s*\*?\*?Cost\*?\*?:\s*\$?([\d.]+)/, block);
    if (cost !== null) record.cost_usd = Number(cost);

    const findings = firstGroup(/[*-]\s*\*?\*?Findings\*?\*?:\s*(\d+)/, block);
    if (findings !== null) record.findings = Number(findings);

    const actions = firstGroup(/[*-]\s*\*?\*?Actions\*?\*?:\s*(.+)/, block);
    if (actions !== null) record.actions = actions.trim();

    const error = firstGroup(/[*-]\s*\*?\*?Error\*?\*?:\s*(.+)/, block);
    if (error !== null) record.error = error.trim();

    records.push(record);
  }

  return records;
}

// ---------------------------------------------------------------------------
// Registry schema (port of automation/schema.py)
// ---------------------------------------------------------------------------

/** Load and validate a registry.json. Throws on any problem. */
export function loadRegistry(registryPath: string): Record<string, unknown> {
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  } catch (err) {
    throw new Error(`Invalid JSON in ${registryPath}: ${(err as Error).message}`);
  }

  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    const kind = Array.isArray(data) ? "list" : data === null ? "NoneType" : typeof data;
    throw new Error(`Registry must be a JSON object, got ${kind}`);
  }

  const schemaVersion = (data as Record<string, unknown>).schema_version;
  if (schemaVersion !== 1) {
    throw new Error(`Unsupported schema_version: ${schemaVersion} (expected 1)`);
  }

  return data as Record<string, unknown>;
}
