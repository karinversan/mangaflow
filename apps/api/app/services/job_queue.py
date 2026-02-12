from __future__ import annotations

from app.core.config import settings
from app.core.redis_client import get_redis


def enqueue_job(job_id: str) -> None:
    get_redis().rpush(settings.pipeline_queue_name, job_id)


def pop_job(timeout_sec: int = 5) -> str | None:
    item = get_redis().blpop(settings.pipeline_queue_name, timeout=timeout_sec)
    if item is None:
        return None
    _, job_id = item
    return job_id


def queue_length() -> int:
    return int(get_redis().llen(settings.pipeline_queue_name))
