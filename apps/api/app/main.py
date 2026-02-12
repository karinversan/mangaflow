import logging

from fastapi import FastAPI, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.api.routes import router
from app.core.config import settings, validate_runtime_settings
from app.core.middleware import RequestContextMiddleware
from app.core.metrics import render_metrics
from app.core.redis_client import get_redis
from app.core.s3_client import check_s3_ready, ensure_bucket_exists
from app.db.base import Base
from app.db.session import SessionLocal, engine

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

app = FastAPI(
    title="Manga Translate API",
    version="0.1.0",
    docs_url="/docs",
    redoc_url="/redoc",
)

origins = [origin.strip() for origin in settings.cors_allow_origins.split(",") if origin.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PATCH", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Request-ID"],
)
app.add_middleware(RequestContextMiddleware)


@app.on_event("startup")
def init_db() -> None:
    import app.db.models  # noqa: F401

    validate_runtime_settings()
    Base.metadata.create_all(bind=engine)
    try:
        ensure_bucket_exists()
    except Exception:  # pragma: no cover
        logger.exception("Failed to ensure S3 bucket exists on startup.")


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "env": settings.api_env}


@app.get("/ready")
async def ready():
    checks = {"database": False, "redis": False, "s3": False}

    db = SessionLocal()
    try:
        db.execute(text("SELECT 1"))
        checks["database"] = True
    finally:
        db.close()

    redis_ok = bool(get_redis().ping())
    checks["redis"] = redis_ok

    checks["s3"] = check_s3_ready()

    ok = all(checks.values())
    if not ok:
        return JSONResponse(
            content={"status": "degraded", "checks": checks},
            status_code=503,
        )
    return {"status": "ready", "checks": checks}


@app.get("/metrics")
async def metrics() -> Response:
    payload, content_type = render_metrics()
    return Response(content=payload, media_type=content_type)


app.include_router(router, prefix="/api/v1")
