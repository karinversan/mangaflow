from __future__ import annotations

from typing import Literal

JobStatus = Literal["queued", "running", "retrying", "done", "failed", "cancel_requested", "canceled"]

TERMINAL_STATUSES: set[JobStatus] = {"done", "failed", "canceled"}

_ALLOWED_TRANSITIONS: dict[JobStatus, set[JobStatus]] = {
    "queued": {"running", "canceled", "cancel_requested"},
    "running": {"retrying", "done", "failed", "cancel_requested", "canceled"},
    "retrying": {"queued", "failed"},
    "cancel_requested": {"canceled", "done", "failed"},
    "done": set(),
    "failed": set(),
    "canceled": set(),
}


def can_transition(current: JobStatus, nxt: JobStatus) -> bool:
    return nxt in _ALLOWED_TRANSITIONS[current]


def retry_outcome(*, attempts: int, max_attempts: int) -> JobStatus:
    return "retrying" if attempts < max_attempts else "failed"
