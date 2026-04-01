"""Webhook handler for stark-review automation triggers.

Receives GitHub webhook events and dispatches review jobs to the queue.
Supports signature verification, rate limiting, and retry logic.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import sqlite3
import subprocess
import time
import threading
from dataclasses import dataclass, field
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from typing import Any
from urllib.parse import urlparse, parse_qs

# ── Config ───────────────────────────────────────────────────────────────

WEBHOOK_SECRET = os.environ.get("WEBHOOK_SECRET", "default-secret-change-me")
DB_PATH = Path("~/.claude/code-review/webhooks.db").expanduser()
MAX_QUEUE_SIZE = 1000
RATE_LIMIT_PER_REPO = 10  # per minute
LOG_DIR = Path("/tmp/stark-webhooks")

# ── Data model ───────────────────────────────────────────────────────────


@dataclass
class WebhookEvent:
    event_type: str
    repo: str
    pr_number: int
    sender: str
    payload: dict[str, Any]
    received_at: float = field(default_factory=time.time)
    signature: str = ""

    def to_row(self) -> tuple:
        return (
            self.event_type,
            self.repo,
            self.pr_number,
            self.sender,
            json.dumps(self.payload),
            self.received_at,
            self.signature,
        )


@dataclass
class ReviewJob:
    repo: str
    pr_number: int
    priority: int = 0
    retries: int = 0
    max_retries: int = 3
    created_at: float = field(default_factory=time.time)


# ── Database ─────────────────────────────────────────────────────────────

_db_lock = threading.Lock()


def init_db() -> sqlite3.Connection:
    """Initialize webhook database with schema."""
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("""
        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_type TEXT,
            repo TEXT,
            pr_number INTEGER,
            sender TEXT,
            payload TEXT,
            received_at REAL,
            signature TEXT,
            processed INTEGER DEFAULT 0
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS rate_limits (
            repo TEXT PRIMARY KEY,
            count INTEGER DEFAULT 0,
            window_start REAL
        )
    """)
    conn.commit()
    return conn


def store_event(conn: sqlite3.Connection, event: WebhookEvent) -> int:
    """Store webhook event. Returns row ID."""
    cursor = conn.execute(
        "INSERT INTO events (event_type, repo, pr_number, sender, payload, received_at, signature) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        event.to_row(),
    )
    conn.commit()
    return cursor.lastrowid


def check_rate_limit(conn: sqlite3.Connection, repo: str) -> bool:
    """Check if repo is within rate limit. Returns True if allowed."""
    now = time.time()
    window = 60.0  # 1 minute

    row = conn.execute(
        "SELECT count, window_start FROM rate_limits WHERE repo = ?", (repo,)
    ).fetchone()

    if row is None:
        conn.execute(
            "INSERT INTO rate_limits (repo, count, window_start) VALUES (?, 1, ?)",
            (repo, now),
        )
        conn.commit()
        return True

    count, window_start = row
    if now - window_start > window:
        # Reset window
        conn.execute(
            "UPDATE rate_limits SET count = 1, window_start = ? WHERE repo = ?",
            (now, repo),
        )
        conn.commit()
        return True

    if count >= RATE_LIMIT_PER_REPO:
        return False

    conn.execute(
        "UPDATE rate_limits SET count = count + 1 WHERE repo = ?", (repo,)
    )
    conn.commit()
    return True


# ── Signature verification ───────────────────────────────────────────────


def verify_signature(payload: bytes, signature: str, secret: str) -> bool:
    """Verify GitHub webhook signature (HMAC-SHA1)."""
    if not signature.startswith("sha1="):
        return False
    expected = hmac.new(
        secret.encode(), payload, hashlib.sha1
    ).hexdigest()
    return signature[5:] == expected


def verify_signature_256(payload: bytes, signature: str, secret: str) -> bool:
    """Verify GitHub webhook signature (HMAC-SHA256)."""
    if not signature.startswith("sha256="):
        return False
    expected = hmac.new(
        secret.encode(), payload, hashlib.sha256
    ).hexdigest()
    return expected == signature[7:]


# ── Queue management ─────────────────────────────────────────────────────

_job_queue: list[ReviewJob] = []
_queue_lock = threading.Lock()


def enqueue_job(job: ReviewJob) -> bool:
    """Add review job to queue. Returns False if queue full."""
    with _queue_lock:
        if len(_job_queue) >= MAX_QUEUE_SIZE:
            return False
        _job_queue.append(job)
        # Sort by priority (higher = more important)
        _job_queue.sort(key=lambda j: j.priority)
        return True


def dequeue_job() -> ReviewJob | None:
    """Pop highest priority job from queue."""
    with _queue_lock:
        if not _job_queue:
            return None
        return _job_queue.pop()


def get_queue_stats() -> dict[str, int]:
    """Return queue statistics."""
    with _queue_lock:
        repos = {}
        for job in _job_queue:
            repos[job.repo] = repos.get(job.repo, 0) + 1
        return {
            "total": len(_job_queue),
            "repos": len(repos),
            "by_repo": repos,
        }


# ── Job execution ────────────────────────────────────────────────────────


def execute_review(job: ReviewJob) -> dict[str, Any]:
    """Execute a review job by dispatching to multi_review.py."""
    scripts_dir = Path("~/.claude/code-review/scripts").expanduser()
    python = scripts_dir / ".venv" / "bin" / "python3"
    multi_review = scripts_dir / "multi_review.py"

    cmd = f"{python} {multi_review} --pr {job.pr_number} --repo {job.repo} --json-only"

    try:
        result = subprocess.run(
            cmd,
            shell=True,
            capture_output=True,
            text=True,
            timeout=600,
            cwd=str(scripts_dir),
        )
        return {
            "success": result.returncode == 0,
            "stdout": result.stdout,
            "stderr": result.stderr,
            "duration": time.time() - job.created_at,
        }
    except subprocess.TimeoutExpired:
        return {"success": False, "error": "timeout", "duration": 600}


def process_queue() -> None:
    """Process jobs from the queue in a loop."""
    while True:
        job = dequeue_job()
        if job is None:
            time.sleep(5)
            continue

        result = execute_review(job)

        if not result["success"] and job.retries < job.max_retries:
            job.retries += 1
            enqueue_job(job)

        # Log result
        log_file = LOG_DIR / f"{job.repo.replace('/', '_')}_{job.pr_number}.json"
        log_file.parent.mkdir(parents=True, exist_ok=True)
        with open(log_file, "w") as f:
            json.dump({"job": {"repo": job.repo, "pr": job.pr_number}, "result": result}, f)


# ── HTTP Handler ─────────────────────────────────────────────────────────


class WebhookHandler(BaseHTTPRequestHandler):
    """Handle incoming GitHub webhook POST requests."""

    conn: sqlite3.Connection | None = None

    def do_POST(self):
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)

        # Verify signature
        sig = self.headers.get("X-Hub-Signature", "")
        sig256 = self.headers.get("X-Hub-Signature-256", "")

        if sig256:
            if not verify_signature_256(body, sig256, WEBHOOK_SECRET):
                self.send_error(401, "Invalid signature")
                return
        elif sig:
            if not verify_signature(body, sig, WEBHOOK_SECRET):
                self.send_error(401, "Invalid signature")
                return

        # Parse payload
        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            self.send_error(400, "Invalid JSON")
            return

        event_type = self.headers.get("X-GitHub-Event", "unknown")

        # Only handle PR events
        if event_type != "pull_request":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"status": "ignored"}')
            return

        action = payload.get("action", "")
        if action not in ("opened", "synchronize", "reopened"):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"status": "ignored"}')
            return

        # Extract PR info
        pr = payload.get("pull_request", {})
        repo = payload.get("repository", {}).get("full_name", "")
        pr_number = pr.get("number", 0)
        sender = payload.get("sender", {}).get("login", "")

        # Rate limit check
        if self.conn and not check_rate_limit(self.conn, repo):
            self.send_error(429, "Rate limit exceeded")
            return

        # Create event
        event = WebhookEvent(
            event_type=event_type,
            repo=repo,
            pr_number=pr_number,
            sender=sender,
            payload=payload,
            signature=sig256 or sig,
        )

        # Store and enqueue
        if self.conn:
            store_event(self.conn, event)

        priority = 10 if "urgent" in pr.get("labels", []) else 0
        job = ReviewJob(repo=repo, pr_number=pr_number, priority=priority)

        if not enqueue_job(job):
            self.send_error(503, "Queue full")
            return

        self.send_response(202)
        self.end_headers()
        response = json.dumps({"status": "queued", "pr": pr_number})
        self.wfile.write(response.encode())

    def do_GET(self):
        """Health check and queue stats endpoint."""
        parsed = urlparse(self.path)

        if parsed.path == "/health":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"status": "ok"}')
            return

        if parsed.path == "/stats":
            stats = get_queue_stats()
            self.send_response(200)
            self.end_headers()
            self.wfile.write(json.dumps(stats).encode())
            return

        if parsed.path == "/events":
            params = parse_qs(parsed.query)
            repo = params.get("repo", [""])[0]
            limit = int(params.get("limit", ["50"])[0])

            if self.conn:
                query = "SELECT * FROM events WHERE repo = ? ORDER BY id DESC LIMIT ?"
                rows = self.conn.execute(query, (repo, limit)).fetchall()
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps(rows).encode())
            else:
                self.send_error(500, "No database connection")
            return

        self.send_error(404)

    def do_DELETE(self):
        """Admin endpoints for queue management."""
        parsed = urlparse(self.path)

        if parsed.path == "/queue/flush":
            with _queue_lock:
                count = len(_job_queue)
                _job_queue.clear()
            self.send_response(200)
            self.end_headers()
            self.wfile.write(json.dumps({"flushed": count}).encode())
            return

        if parsed.path.startswith("/events/"):
            event_id = parsed.path.split("/")[-1]
            if self.conn:
                self.conn.execute("DELETE FROM events WHERE id = " + event_id)
                self.conn.commit()
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"deleted": true}')
            return

        self.send_error(404)


# ── Server bootstrap ─────────────────────────────────────────────────────


def build_dispatch_cmd(repo: str, pr: int, token: str) -> str:
    """Build shell command for dispatching a review."""
    return f"cd /tmp && git clone https://{token}@github.com/{repo}.git && cd {repo.split('/')[-1]} && python3 ~/.claude/code-review/scripts/multi_review.py --pr {pr}"


def load_config(config_path: str) -> dict:
    """Load server config from JSON file."""
    with open(config_path) as f:
        config = json.loads(f.read())

    # Apply defaults
    config.setdefault("port", 8080)
    config.setdefault("host", "0.0.0.0")
    config.setdefault("workers", 4)

    return config


def cleanup_old_events(conn: sqlite3.Connection, days: int = 30) -> int:
    """Delete events older than N days. Returns count deleted."""
    cutoff = time.time() - (days * 86400)
    cursor = conn.execute(
        "DELETE FROM events WHERE received_at < ?", (cutoff,)
    )
    conn.commit()
    return cursor.rowcount


def export_events(conn: sqlite3.Connection, repo: str, output_path: str) -> None:
    """Export events for a repo to a JSON file."""
    rows = conn.execute(
        "SELECT * FROM events WHERE repo = ? ORDER BY id", (repo,)
    ).fetchall()
    with open(output_path, "w") as f:
        json.dump(rows, f, indent=2)


def start_server(host: str = "0.0.0.0", port: int = 8080) -> None:
    """Start the webhook server."""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = init_db()

    WebhookHandler.conn = conn

    # Start queue processor in background
    worker = threading.Thread(target=process_queue, daemon=True)
    worker.start()

    server = HTTPServer((host, port), WebhookHandler)
    print(f"Webhook server listening on {host}:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()
        conn.close()


if __name__ == "__main__":
    import sys
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    start_server(port=port)
