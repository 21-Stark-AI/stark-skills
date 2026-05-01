#!/usr/bin/env bun
// @ts-nocheck — standalone script in ~/.claude/, no tsconfig/@types/node nearby
// Record context-window % over time and emit a trend indicator.
// Storage matches scripts/emit_queue.py:record_context_pct so both
// implementations interoperate on the same ctx-history file.
//
// Usage: statusline-ctx-trend.ts <pct>
//   stdout: "▲" (delta ≥ 5%), "▸" (delta ≥ 1%), or empty

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const QUEUE_DIR = process.env.STARK_QUEUE_DIR ?? join(homedir(), ".stark-insights");
const HISTORY = join(QUEUE_DIR, "ctx-history");
const KEEP = 10;

const pct = Number(process.argv[2]);
if (!Number.isFinite(pct)) process.exit(0);

if (!existsSync(dirname(HISTORY))) {
  try { mkdirSync(dirname(HISTORY), { recursive: true }); } catch { /* ignore */ }
}

type Entry = [number, number]; // [unix_ts, pct]
const entries: Entry[] = [];
try {
  for (const line of readFileSync(HISTORY, "utf8").trim().split("\n")) {
    const [ts, p] = line.split("\t");
    const n = Number(ts), q = Number(p);
    if (Number.isFinite(n) && Number.isFinite(q)) entries.push([n, q]);
  }
} catch { /* missing or corrupt — start fresh */ }

entries.push([Math.floor(Date.now() / 1000), pct]);
const trimmed = entries.slice(-KEEP);

try {
  const tmp = `${HISTORY}.tmp`;
  writeFileSync(tmp, trimmed.map(([t, p]) => `${t}\t${p}`).join("\n") + "\n");
  renameSync(tmp, HISTORY);
} catch { /* best-effort persist */ }

if (trimmed.length < 2) process.exit(0);
const delta = pct - trimmed[0][1];
if (delta >= 5) process.stdout.write("▲"); // ▲
else if (delta >= 1) process.stdout.write("▸"); // ▸
