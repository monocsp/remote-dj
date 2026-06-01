"""Pytest fixtures for the black-box server harness.

The `server_url` fixture yields a base HTTP URL of a running remote-dj server:

- If REMOTE_DJ_SERVER_URL is set, tests use that already-running server and
  nothing is spawned/torn down.
- Otherwise a Node server is spawned from the repo root on a test PORT
  (default 3099, override with REMOTE_DJ_TEST_PORT), waited on via /health,
  and torn down at session end.

This harness talks to the server ONLY over the wire (Socket.IO + HTTP). It does
not import any server/shared source.
"""

from __future__ import annotations

import os
import signal
import subprocess
import time
from pathlib import Path

import pytest
import requests

# qa/server/conftest.py -> repo root
REPO_ROOT = Path(__file__).resolve().parent.parent.parent


def _wait_for_health(base_url: str, timeout: float = 60.0) -> None:
    deadline = time.time() + timeout
    last_err: Exception | None = None
    while time.time() < deadline:
        try:
            r = requests.get(f"{base_url}/health", timeout=2)
            if r.status_code == 200 and r.text.strip() == "ok":
                return
        except Exception as exc:  # noqa: BLE001 - retry until healthy
            last_err = exc
        time.sleep(0.5)
    raise RuntimeError(f"server /health not ready at {base_url}: {last_err}")


@pytest.fixture(scope="session")
def server_url() -> str:
    existing = os.environ.get("REMOTE_DJ_SERVER_URL")
    if existing:
        base = existing.rstrip("/")
        _wait_for_health(base)
        yield base
        return

    port = int(os.environ.get("REMOTE_DJ_TEST_PORT", "3099"))
    base = f"http://localhost:{port}"

    env = {
        **os.environ,
        "PORT": str(port),
        "HOSTNAME": "127.0.0.1",
        # Deterministic title for the black-box server (no network).
        "REMOTE_DJ_FAKE_TITLE": "QA Title",
        # Deterministic loudness (+6 dB) so loudness auto-seed yields ~0.5
        # for any new track (no network).
        "REMOTE_DJ_FAKE_LOUDNESS": "6",
    }
    # Prefer the workspace dev:server script; fall back to direct tsx run.
    cmd = ["npm", "run", "dev:server"]
    proc = subprocess.Popen(
        cmd,
        cwd=str(REPO_ROOT),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        start_new_session=True,  # own process group, so we can kill children (tsx)
    )

    try:
        _wait_for_health(base)
    except Exception:
        _terminate(proc)
        raise

    try:
        yield base
    finally:
        _terminate(proc)


def _terminate(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except ProcessLookupError:
            pass
