from __future__ import annotations

from fastapi import HTTPException, status

from app.core.config import settings
from app.core.redis_client import get_redis


def enforce_user_rate_limit(user_id: str, *, bucket: str = "default", limit: int | None = None, window_sec: int = 60) -> None:
    redis_client = get_redis()
    resolved_limit = limit or settings.rate_limit_per_minute
    key = f"ratelimit:{bucket}:{user_id}"
    count = redis_client.incr(key)
    if count == 1:
        redis_client.expire(key, window_sec)
    if count > resolved_limit:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Rate limit exceeded. Retry in one minute.",
        )
