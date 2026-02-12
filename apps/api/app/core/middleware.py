from __future__ import annotations

import logging
import time
import uuid

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware

from app.core.config import settings
from app.core.metrics import http_request_duration_seconds, http_requests_in_flight, http_requests_total

logger = logging.getLogger("api.request")


class RequestContextMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        request_id = request.headers.get("X-Request-ID") or str(uuid.uuid4())
        request.state.request_id = request_id
        start = time.perf_counter()
        http_requests_in_flight.inc()
        response = None
        status_code = 500
        try:
            response = await call_next(request)
            status_code = response.status_code
        finally:
            elapsed = time.perf_counter() - start
            path = request.url.path
            method = request.method
            status_label = str(status_code)
            http_requests_total.labels(method=method, path=path, status=status_label).inc()
            http_request_duration_seconds.labels(method=method, path=path).observe(elapsed)
            http_requests_in_flight.dec()
            if settings.request_log_enabled:
                logger.info(
                    "request method=%s path=%s status=%s duration_sec=%.4f request_id=%s",
                    method,
                    path,
                    status_label,
                    elapsed,
                    request_id,
                )
            if response is not None:
                response.headers["X-Request-ID"] = request_id
        if response is None:
            raise RuntimeError("Request processing failed before response generation.")
        return response
