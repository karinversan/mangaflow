from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import router
from app.core.config import settings
from app.db.base import Base
from app.db.session import engine

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
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Request-ID"],
)


@app.on_event("startup")
def init_db() -> None:
    import app.db.models  # noqa: F401

    Base.metadata.create_all(bind=engine)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "env": settings.api_env}


@app.get("/metrics")
async def metrics() -> dict[str, int]:
    return {
        "pipeline_requests_total": 0,
        "pipeline_errors_total": 0,
    }


app.include_router(router, prefix="/api/v1")
