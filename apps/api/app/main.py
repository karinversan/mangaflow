import logging

from fastapi import FastAPI, Response
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import router
from app.core.config import settings
from app.core.metrics import render_metrics
from app.core.s3_client import ensure_bucket_exists
from app.db.base import Base
from app.db.session import engine

logger = logging.getLogger(__name__)

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


@app.on_event("startup")
def init_db() -> None:
    import app.db.models  # noqa: F401

    Base.metadata.create_all(bind=engine)
    try:
        ensure_bucket_exists()
    except Exception:  # pragma: no cover
        logger.exception("Failed to ensure S3 bucket exists on startup.")


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "env": settings.api_env}


@app.get("/metrics")
async def metrics() -> Response:
    payload, content_type = render_metrics()
    return Response(content=payload, media_type=content_type)


app.include_router(router, prefix="/api/v1")
