from __future__ import annotations

from fastapi import HTTPException, status

from app.core.config import settings
from app.core.redis_client import get_redis


def enforce_user_rate_limit(user_id: str) -> None:
    redis_client = get_redis()
    key = f"ratelimit:{user_id}"
    count = redis_client.incr(key)
    if count == 1:
        redis_client.expire(key, 60)
    if count > settings.rate_limit_per_minute:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Rate limit exceeded. Retry in one minute.",
        )
