import logging

from sqlalchemy import select
from sqlalchemy.orm import Session

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status

from app.core.config import settings
from app.db.models import PipelineRun
from app.db.session import get_db
from app.schemas.pipeline import PipelineResponse, PipelineRunRead
from app.services.pipeline_stub import run_stub_pipeline

logger = logging.getLogger(__name__)

router = APIRouter()

ALLOWED_CONTENT_TYPES = {"image/png", "image/jpeg", "image/webp"}


@router.post("/pipeline/run", response_model=PipelineResponse)
async def run_pipeline(
    file: UploadFile = File(...),
    target_lang: str = Form("ru"),
    db: Session = Depends(get_db),
) -> PipelineResponse:
    logger.info("Pipeline request from %s targeting %s", file.filename, target_lang)

    if file.content_type not in ALLOWED_CONTENT_TYPES:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Unsupported file type. Use PNG/JPEG/WEBP.",
        )

    raw = await file.read()
    max_bytes = settings.max_upload_mb * 1024 * 1024
    if len(raw) > max_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File too large. Max {settings.max_upload_mb}MB.",
        )

    if len(raw) < 64:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid image payload.")

    try:
        payload = run_stub_pipeline(raw, target_lang)

        run = PipelineRun(
            file_name=file.filename or "unknown",
            target_lang=target_lang,
            region_count=len(payload.regions),
        )
        db.add(run)
        db.commit()

        logger.info("Stored pipeline run %s with %d regions", run.id, run.region_count)

        return payload
    except Exception as exc:  # pragma: no cover
        logger.exception("Pipeline execution failed")
        raise HTTPException(status_code=500, detail="Pipeline execution failed") from exc


@router.get("/pipeline/runs", response_model=list[PipelineRunRead])
async def list_runs(db: Session = Depends(get_db)) -> list[PipelineRunRead]:
    rows = db.execute(select(PipelineRun).order_by(PipelineRun.created_at.desc()).limit(100)).scalars().all()
    return [
        PipelineRunRead(
            id=row.id,
            file_name=row.file_name,
            target_lang=row.target_lang,
            region_count=row.region_count,
            created_at=row.created_at,
        )
        for row in rows
    ]
