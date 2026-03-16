import logging
from pathlib import Path

from fastapi import FastAPI, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.api.routes import router
from app.core.config import settings, validate_runtime_settings
from app.core.middleware import RequestContextMiddleware
from app.core.metrics import render_metrics
from app.core.redis_client import get_redis
from app.core.s3_client import check_s3_ready, ensure_bucket_exists
from app.db.base import Base
from app.db.migrate import run_migrations
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
    run_migrations(engine)
    try:
        Base.metadata.create_all(bind=engine)
    except IntegrityError:
        # API and worker can start at the same time; retry after concurrent DDL race.
        logger.warning("Concurrent metadata create_all detected, retrying.")
        Base.metadata.create_all(bind=engine)
    if settings.storage_backend == "s3":
        try:
            ensure_bucket_exists()
        except Exception:  # pragma: no cover
            logger.exception("Failed to ensure S3 bucket exists on startup.")
    else:
        Path(settings.local_storage_path).mkdir(parents=True, exist_ok=True)
        logger.info("Using local filesystem storage at %s", settings.local_storage_path)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "env": settings.api_env}


@app.get("/ready")
async def ready():
    if not settings.enable_ready_checks:
        return {"status": "ready", "checks": {"disabled": True}}
    checks = {"database": False, "redis": False, "s3": False}

    db = SessionLocal()
    try:
        db.execute(text("SELECT 1"))
        checks["database"] = True
    finally:
        db.close()

    redis_ok = bool(get_redis().ping())
    checks["redis"] = redis_ok

    if settings.storage_backend == "s3":
        checks["s3"] = check_s3_ready()
    else:
        checks["s3"] = Path(settings.local_storage_path).is_dir()

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
