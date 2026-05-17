// Smoke tests for `tools/emit_queue_cli.ts`. Each test runs the CLI in a
// subprocess against a fresh STARK_QUEUE_DIR so the wire shape (stdout,
// exit code) stays in lockstep with the Python `--health` consumer
// (`/stark-session`) and the statusline-command.sh consumer.

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "emit_queue_cli.ts");

function freshQueueDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "emit-queue-cli-"));
}

function runCli(args: string[], queueDir: string): { stdout: string; stderr: string; status: number } {
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", CLI, ...args],
    {
      env: { ...process.env, STARK_QUEUE_DIR: queueDir },
      encoding: "utf8",
    },
  );
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? -1 };
}

test("--help prints usage on stdout and exits 0", () => {
  const r = runCli(["--help"], freshQueueDir());
  assert.equal(r.status, 0);
  assert.match(r.stdout, /emit-queue CLI/);
  assert.match(r.stdout, /--health/);
  assert.match(r.stdout, /record-context-pct/);
});

test("--health on a fresh DB prints {pending_count:0, max_created_at:null}", () => {
  const r = runCli(["--health"], freshQueueDir());
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.pending_count, 0);
  assert.equal(parsed.max_created_at, null);
});

test("--init-schema creates the queue.db file", () => {
  const dir = freshQueueDir();
  const r = runCli(["--init-schema"], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(path.join(dir, "queue.db")), true);
});

test("pending-count on fresh DB prints 0", () => {
  const r = runCli(["pending-count"], freshQueueDir());
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "0");
});

test("dead-letter-count on fresh DB prints 0", () => {
  const r = runCli(["dead-letter-count"], freshQueueDir());
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "0");
});

test("record-context-pct: first reading prints empty string trend", () => {
  const r = runCli(["record-context-pct", "12.5"], freshQueueDir());
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, ""); // no trailing newline by design
});

test("record-context-pct: ≥5pp jump prints ▲", () => {
  const dir = freshQueueDir();
  runCli(["record-context-pct", "10"], dir);
  const r = runCli(["record-context-pct", "20"], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "▲");
});

test("record-context-pct: missing argument exits 2 with usage hint", () => {
  const r = runCli(["record-context-pct"], freshQueueDir());
  assert.equal(r.status, 2);
  assert.match(r.stderr, /missing <pct>/);
});

test("record-context-pct: non-numeric argument exits 2 with usage hint", () => {
  const r = runCli(["record-context-pct", "abc"], freshQueueDir());
  assert.equal(r.status, 2);
  assert.match(r.stderr, /must be a finite number/);
});

test("unknown command exits 2 and prints usage", () => {
  const r = runCli(["nope"], freshQueueDir());
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown command/);
  assert.match(r.stderr, /--health/);
});
