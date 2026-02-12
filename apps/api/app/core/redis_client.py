from __future__ import annotations

from functools import lru_cache

import redis

from app.core.config import settings


@lru_cache(maxsize=1)
def get_redis() -> redis.Redis:
    return redis.Redis.from_url(settings.redis_url, decode_responses=True)
