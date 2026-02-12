from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Callable, TypeVar

T = TypeVar("T")


@dataclass
class CircuitBreaker:
    failure_threshold: int
    reset_timeout_sec: int
    failures: int = 0
    opened_at: float | None = None

    def can_execute(self) -> bool:
        if self.opened_at is None:
            return True
        if (time.time() - self.opened_at) >= self.reset_timeout_sec:
            self.failures = 0
            self.opened_at = None
            return True
        return False

    def on_success(self) -> None:
        self.failures = 0
        self.opened_at = None

    def on_failure(self) -> None:
        self.failures += 1
        if self.failures >= self.failure_threshold:
            self.opened_at = time.time()


def run_with_retry_timeout_circuit(
    action: Callable[[], T],
    *,
    retry_count: int,
    timeout_sec: int,
    circuit_breaker: CircuitBreaker,
) -> T:
    if not circuit_breaker.can_execute():
        raise RuntimeError("Pipeline provider circuit is open.")

    last_exc: Exception | None = None
    for _ in range(retry_count + 1):
        start = time.perf_counter()
        try:
            result = action()
            elapsed = time.perf_counter() - start
            if elapsed > timeout_sec:
                raise TimeoutError(f"Provider timeout exceeded {timeout_sec}s.")
            circuit_breaker.on_success()
            return result
        except Exception as exc:
            last_exc = exc
            circuit_breaker.on_failure()
    if last_exc:
        raise last_exc
    raise RuntimeError("Unknown pipeline provider failure")
