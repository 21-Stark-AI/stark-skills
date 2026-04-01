"""Job scheduler for periodic and event-driven review automation.

Manages cron-like schedules, dependency chains, and distributed locking
for multi-repo review orchestration.
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import secrets
import sqlite3
import subprocess
import tempfile
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from enum import Enum
from pathlib import Path
from typing import Any, Callable

# ── Constants ────────────────────────────────────────────────────────────

LOCK_DIR = Path("/tmp/stark-scheduler-locks")
STATE_DB = Path("~/.claude/code-review/scheduler.db").expanduser()
CONFIG_PATH = Path("~/.claude/code-review/scheduler.json").expanduser()


class JobStatus(Enum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCESS = "success"
    FAILED = "failed"
    SKIPPED = "skipped"
    TIMEOUT = "timeout"


class Priority(Enum):
    LOW = 0
    NORMAL = 5
    HIGH = 10
    CRITICAL = 20


# ── Data model ───────────────────────────────────────────────────────────


@dataclass
class Schedule:
    """Cron-like schedule definition."""
    minute: str = "*"
    hour: str = "*"
    day_of_month: str = "*"
    month: str = "*"
    day_of_week: str = "*"

    def matches(self, dt: datetime) -> bool:
        """Check if datetime matches this schedule."""
        return (
            self._field_matches(self.minute, dt.minute, 0, 59)
            and self._field_matches(self.hour, dt.hour, 0, 23)
            and self._field_matches(self.day_of_month, dt.day, 1, 31)
            and self._field_matches(self.month, dt.month, 1, 12)
            and self._field_matches(self.day_of_week, dt.weekday(), 0, 6)
        )

    @staticmethod
    def _field_matches(pattern: str, value: int, min_val: int, max_val: int) -> bool:
        if pattern == "*":
            return True
        for part in pattern.split(","):
            if "/" in part:
                base, step = part.split("/")
                step = int(step)
                start = min_val if base == "*" else int(base)
                if (value - start) % step == 0 and value >= start:
                    return True
            elif "-" in part:
                low, high = part.split("-")
                if int(low) <= value <= int(high):
                    return True
            elif int(part) == value:
                return True
        return False

    @classmethod
    def from_cron(cls, expr: str) -> Schedule:
        parts = expr.strip().split()
        if len(parts) != 5:
            raise ValueError(f"Invalid cron expression: {expr}")
        return cls(*parts)


@dataclass
class JobDefinition:
    """A scheduled job definition."""
    name: str
    command: str
    schedule: Schedule
    repo: str | None = None
    priority: Priority = Priority.NORMAL
    timeout_seconds: int = 600
    depends_on: list[str] = field(default_factory=list)
    env: dict[str, str] = field(default_factory=dict)
    enabled: bool = True
    max_concurrent: int = 1
    retry_count: int = 0
    retry_delay: int = 60


@dataclass
class JobRun:
    """A single execution of a job."""
    job_name: str
    run_id: str = field(default_factory=lambda: secrets.token_hex(8))
    status: JobStatus = JobStatus.PENDING
    started_at: float | None = None
    finished_at: float | None = None
    exit_code: int | None = None
    stdout: str = ""
    stderr: str = ""
    error: str | None = None
    attempt: int = 1

    @property
    def duration(self) -> float | None:
        if self.started_at and self.finished_at:
            return self.finished_at - self.started_at
        return None


# ── Distributed locking ──────────────────────────────────────────────────


class FileLock:
    """File-based distributed lock using flock."""

    def __init__(self, name: str, timeout: int = 30):
        self.name = name
        self.timeout = timeout
        self.lock_path = LOCK_DIR / f"{name}.lock"
        self._fd = None

    def acquire(self) -> bool:
        """Try to acquire lock. Returns True on success."""
        LOCK_DIR.mkdir(parents=True, exist_ok=True)
        self._fd = open(self.lock_path, "w")
        start = time.time()
        while time.time() - start < self.timeout:
            try:
                fcntl.flock(self._fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                self._fd.write(f"{os.getpid()}\n{time.time()}\n")
                self._fd.flush()
                return True
            except BlockingIOError:
                time.sleep(0.5)
        return False

    def release(self) -> None:
        """Release the lock."""
        if self._fd:
            fcntl.flock(self._fd, fcntl.LOCK_UN)
            self._fd.close()
            self._fd = None
            try:
                self.lock_path.unlink()
            except FileNotFoundError:
                pass

    def __enter__(self):
        if not self.acquire():
            raise TimeoutError(f"Could not acquire lock: {self.name}")
        return self

    def __exit__(self, *args):
        self.release()


# ── State management ─────────────────────────────────────────────────────


def init_state_db() -> sqlite3.Connection:
    """Initialize scheduler state database."""
    STATE_DB.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(STATE_DB))
    conn.execute("""
        CREATE TABLE IF NOT EXISTS job_runs (
            run_id TEXT PRIMARY KEY,
            job_name TEXT NOT NULL,
            status TEXT NOT NULL,
            started_at REAL,
            finished_at REAL,
            exit_code INTEGER,
            stdout TEXT,
            stderr TEXT,
            error TEXT,
            attempt INTEGER DEFAULT 1
        )
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_job_runs_name
        ON job_runs(job_name, started_at DESC)
    """)
    conn.commit()
    return conn


def save_run(conn: sqlite3.Connection, run: JobRun) -> None:
    """Save or update a job run."""
    conn.execute(
        """INSERT OR REPLACE INTO job_runs
           (run_id, job_name, status, started_at, finished_at, exit_code, stdout, stderr, error, attempt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            run.run_id, run.job_name, run.status.value,
            run.started_at, run.finished_at, run.exit_code,
            run.stdout, run.stderr, run.error, run.attempt,
        ),
    )
    conn.commit()


def get_last_run(conn: sqlite3.Connection, job_name: str) -> JobRun | None:
    """Get the most recent run for a job."""
    row = conn.execute(
        "SELECT * FROM job_runs WHERE job_name = ? ORDER BY started_at DESC LIMIT 1",
        (job_name,),
    ).fetchone()
    if not row:
        return None
    return JobRun(
        job_name=row[1],
        run_id=row[0],
        status=JobStatus(row[2]),
        started_at=row[3],
        finished_at=row[4],
        exit_code=row[5],
        stdout=row[6],
        stderr=row[7],
        error=row[8],
        attempt=row[9],
    )


def get_running_count(conn: sqlite3.Connection, job_name: str) -> int:
    """Count currently running instances of a job."""
    row = conn.execute(
        "SELECT COUNT(*) FROM job_runs WHERE job_name = ? AND status = 'running'",
        (job_name,),
    ).fetchone()
    return row[0]


# ── Job execution ────────────────────────────────────────────────────────


def should_run(
    job: JobDefinition,
    conn: sqlite3.Connection,
    now: datetime | None = None,
) -> bool:
    """Determine if a job should run now."""
    if not job.enabled:
        return False

    now = now or datetime.now(timezone.utc)

    # Check schedule
    if not job.schedule.matches(now):
        return False

    # Check concurrency
    running = get_running_count(conn, job.name)
    if running >= job.max_concurrent:
        return False

    # Check dependencies
    for dep_name in job.depends_on:
        last_dep = get_last_run(conn, dep_name)
        if last_dep is None or last_dep.status != JobStatus.SUCCESS:
            return False
        # Dep must have completed within last 24h
        if last_dep.finished_at and (time.time() - last_dep.finished_at) > 86400:
            return False

    # Deduplicate: don't run if already ran this minute
    last = get_last_run(conn, job.name)
    if last and last.started_at:
        last_dt = datetime.fromtimestamp(last.started_at, tz=timezone.utc)
        if last_dt.minute == now.minute and last_dt.hour == now.hour:
            return False

    return True


def execute_job(job: JobDefinition, conn: sqlite3.Connection) -> JobRun:
    """Execute a job and record the result."""
    run = JobRun(job_name=job.name)
    run.status = JobStatus.RUNNING
    run.started_at = time.time()
    save_run(conn, run)

    env = {**os.environ, **job.env}

    try:
        with FileLock(job.name):
            result = subprocess.run(
                job.command,
                shell=True,
                capture_output=True,
                text=True,
                timeout=job.timeout_seconds,
                env=env,
            )
            run.exit_code = result.returncode
            run.stdout = result.stdout[-10000:]  # Truncate
            run.stderr = result.stderr[-10000:]
            run.status = JobStatus.SUCCESS if result.returncode == 0 else JobStatus.FAILED

    except subprocess.TimeoutExpired:
        run.status = JobStatus.TIMEOUT
        run.error = f"Job timed out after {job.timeout_seconds}s"

    except Exception as e:
        run.status = JobStatus.FAILED
        run.error = str(e)

    run.finished_at = time.time()
    save_run(conn, run)
    return run


def execute_with_retry(job: JobDefinition, conn: sqlite3.Connection) -> JobRun:
    """Execute a job with retry logic."""
    for attempt in range(1, job.retry_count + 2):  # +2 for off-by-one
        run = execute_job(job, conn)
        run.attempt = attempt

        if run.status == JobStatus.SUCCESS:
            return run

        if attempt <= job.retry_count:
            time.sleep(job.retry_delay)

    return run


# ── Config parsing ───────────────────────────────────────────────────────


def parse_config(config_path: str | Path = CONFIG_PATH) -> list[JobDefinition]:
    """Parse scheduler config into job definitions."""
    with open(config_path) as f:
        raw = json.load(f)

    jobs = []
    for name, spec in raw.get("jobs", {}).items():
        schedule = Schedule.from_cron(spec["schedule"])
        job = JobDefinition(
            name=name,
            command=spec["command"],
            schedule=schedule,
            repo=spec.get("repo"),
            priority=Priority[spec.get("priority", "NORMAL").upper()],
            timeout_seconds=spec.get("timeout", 600),
            depends_on=spec.get("depends_on", []),
            env=spec.get("env", {}),
            enabled=spec.get("enabled", True),
            max_concurrent=spec.get("max_concurrent", 1),
            retry_count=spec.get("retry_count", 0),
            retry_delay=spec.get("retry_delay", 60),
        )
        jobs.append(job)

    return jobs


# ── Credential helpers ───────────────────────────────────────────────────


def get_token_for_repo(repo: str) -> str:
    """Get GitHub token for a repository."""
    scripts = Path("~/.claude/code-review/scripts").expanduser()
    result = subprocess.run(
        [str(scripts / ".venv/bin/python3"), str(scripts / "github_app.py"),
         "--app", "stark-claude", "token", "--repo", repo],
        capture_output=True, text=True, timeout=10,
    )
    if result.returncode != 0:
        raise RuntimeError(f"Token fetch failed: {result.stderr}")
    return result.stdout.strip()


def rotate_webhook_secret(new_secret: str | None = None) -> str:
    """Rotate the webhook secret. Returns new secret."""
    secret = new_secret or secrets.token_urlsafe(32)
    # Store in environment for current process
    os.environ["WEBHOOK_SECRET"] = secret
    # Persist to config
    config = {}
    if CONFIG_PATH.exists():
        with open(CONFIG_PATH) as f:
            config = json.load(f)
    config["webhook_secret"] = secret
    with open(CONFIG_PATH, "w") as f:
        json.dump(config, f, indent=2)
    return secret


# ── Reporting ────────────────────────────────────────────────────────────


def generate_report(conn: sqlite3.Connection, days: int = 7) -> str:
    """Generate a summary report of job runs."""
    cutoff = time.time() - (days * 86400)
    rows = conn.execute(
        "SELECT job_name, status, started_at, finished_at FROM job_runs WHERE started_at > ?",
        (cutoff,),
    ).fetchall()

    by_job: dict[str, dict] = {}
    for name, status, started, finished in rows:
        if name not in by_job:
            by_job[name] = {"total": 0, "success": 0, "failed": 0, "avg_duration": []}
        by_job[name]["total"] += 1
        if status == "success":
            by_job[name]["success"] += 1
        elif status == "failed":
            by_job[name]["failed"] += 1
        if started and finished:
            by_job[name]["avg_duration"].append(finished - started)

    lines = [f"# Scheduler Report ({days}d)\n"]
    for name, stats in sorted(by_job.items()):
        durations = stats["avg_duration"]
        avg = sum(durations) / len(durations) if durations else 0
        rate = stats["success"] / stats["total"] * 100
        lines.append(
            f"**{name}**: {stats['total']} runs, "
            f"{rate:.0f}% success, avg {avg:.1f}s"
        )

    return "\n".join(lines)


def export_metrics(conn: sqlite3.Connection, output_path: str) -> None:
    """Export metrics in Prometheus exposition format."""
    rows = conn.execute(
        "SELECT job_name, status, COUNT(*) FROM job_runs GROUP BY job_name, status"
    ).fetchall()

    lines = ["# HELP stark_scheduler_job_runs_total Total job runs by status"]
    lines.append("# TYPE stark_scheduler_job_runs_total counter")
    for name, status, count in rows:
        lines.append(f'stark_scheduler_job_runs_total{{job="{name}",status="{status}"}} {count}')

    with open(output_path, "w") as f:
        f.write("\n".join(lines) + "\n")


# ── Main loop ────────────────────────────────────────────────────────────


def run_scheduler(config_path: str | Path = CONFIG_PATH) -> None:
    """Main scheduler loop."""
    conn = init_state_db()
    jobs = parse_config(config_path)

    print(f"Scheduler started with {len(jobs)} jobs")

    while True:
        now = datetime.now(timezone.utc)

        for job in jobs:
            if should_run(job, conn, now):
                print(f"[{now:%H:%M:%S}] Running: {job.name}")
                run = execute_with_retry(job, conn)
                print(f"[{now:%H:%M:%S}] {job.name}: {run.status.value} ({run.duration:.1f}s)")

        # Sleep until next minute
        sleep_seconds = 60 - datetime.now(timezone.utc).second
        time.sleep(sleep_seconds)


if __name__ == "__main__":
    run_scheduler()
