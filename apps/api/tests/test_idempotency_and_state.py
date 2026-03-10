from __future__ import annotations

from app.services.idempotency import runtime_signature
from app.services.job_state import can_transition, retry_outcome


def test_runtime_signature_is_stable_and_order_independent() -> None:
    a = {"target_lang": "ru", "stages": {"detector": {"provider": "custom", "version": "v1"}}}
    b = {"stages": {"detector": {"version": "v1", "provider": "custom"}}, "target_lang": "ru"}
    assert runtime_signature(a) == runtime_signature(b)


def test_job_state_transitions_and_retry_outcome() -> None:
    assert can_transition("queued", "running")
    assert can_transition("running", "retrying")
    assert not can_transition("done", "running")
    assert retry_outcome(attempts=1, max_attempts=3) == "retrying"
    assert retry_outcome(attempts=3, max_attempts=3) == "failed"
