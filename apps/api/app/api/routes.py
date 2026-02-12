from __future__ import annotations

import uuid
from datetime import datetime, timezone

import jwt
from sqlalchemy import select
from sqlalchemy.orm import Session

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status

from app.core.auth import AuthUser, get_current_user
from app.core.config import settings
from app.core.file_validation import validate_upload
from app.core.metrics import pipeline_errors_total, pipeline_requests_total
from app.core.rate_limit import enforce_user_rate_limit
from app.db.models import JobRun, Page, Project, Region
from app.db.session import get_db
from app.schemas.pipeline import (
    ArtifactLinks,
    JobCreateResponse,
    JobStatusResponse,
    PipelineResponse,
    PipelineRunRead,
    RegionPatchRequest,
    RegionRead,
)
from app.services.job_queue import enqueue_job
from app.services.pipeline_service import run_pipeline as run_pipeline_service
from app.services.storage import build_input_key, presign_get_url, upload_bytes

router = APIRouter()


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _resolve_or_create_project(db: Session, owner_id: str, project_id: str | None, project_name: str) -> Project:
    if project_id:
        project = db.get(Project, project_id)
        if project and project.owner_id == owner_id:
            return project
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found.")
    project = Project(owner_id=owner_id, name=project_name.strip() or "Untitled project")
    db.add(project)
    db.flush()
    return project


def _create_page(
    db: Session,
    *,
    project: Project,
    page_index: int,
    file_name: str,
    input_s3_key: str,
) -> Page:
    page = Page(project_id=project.id, page_index=page_index, file_name=file_name, input_s3_key=input_s3_key)
    db.add(page)
    db.flush()
    return page


@router.post("/auth/dev-token")
async def issue_dev_token(user_id: str = Form(...), email: str | None = Form(default=None)) -> dict[str, str]:
    if settings.api_env != "development":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found.")
    payload = {"sub": user_id}
    if email:
        payload["email"] = email
    token = jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)
    return {"access_token": token, "token_type": "bearer"}


@router.post("/pipeline/jobs", response_model=JobCreateResponse)
async def create_pipeline_job(
    file: UploadFile = File(...),
    target_lang: str = Form("ru"),
    provider: str = Form("stub"),
    request_id: str | None = Form(None),
    project_id: str | None = Form(None),
    project_name: str = Form("Default project"),
    page_index: int = Form(1),
    db: Session = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
) -> JobCreateResponse:
    pipeline_requests_total.inc()
    enforce_user_rate_limit(current_user.user_id)

    raw = await file.read()
    validate_upload(file.content_type, raw, settings.max_upload_mb)

    resolved_request_id = request_id or str(uuid.uuid4())
    existing_job = db.execute(
        select(JobRun).where(JobRun.owner_id == current_user.user_id, JobRun.request_id == resolved_request_id)
    ).scalar_one_or_none()
    if existing_job is not None:
        return JobCreateResponse(
            job_id=existing_job.id,
            status=existing_job.status,  # type: ignore[arg-type]
            project_id=existing_job.project_id,
            page_id=existing_job.page_id,
            request_id=existing_job.request_id,
        )

    try:
        project = _resolve_or_create_project(db, current_user.user_id, project_id, project_name)
        page = _create_page(
            db,
            project=project,
            page_index=page_index,
            file_name=file.filename or "upload.bin",
            input_s3_key="",
        )
        input_key = build_input_key(current_user.user_id, project.id, page.id, file.filename or "upload.bin")
        upload_bytes(input_key, raw, file.content_type or "application/octet-stream")
        page.input_s3_key = input_key

        job = JobRun(
            owner_id=current_user.user_id,
            project_id=project.id,
            page_id=page.id,
            request_id=resolved_request_id,
            provider=provider,
            target_lang=target_lang,
            status="queued",
            input_s3_key=input_key,
        )
        db.add(job)
        db.commit()

        enqueue_job(job.id)
        return JobCreateResponse(
            job_id=job.id,
            status="queued",
            project_id=project.id,
            page_id=page.id,
            request_id=resolved_request_id,
        )
    except HTTPException:
        raise
    except Exception as exc:
        db.rollback()
        pipeline_errors_total.inc()
        raise HTTPException(status_code=500, detail="Failed to create pipeline job.") from exc


@router.get("/pipeline/jobs/{job_id}", response_model=JobStatusResponse)
async def get_pipeline_job(
    job_id: str,
    db: Session = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
) -> JobStatusResponse:
    job = db.get(JobRun, job_id)
    if not job or job.owner_id != current_user.user_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found.")

    output_json_url = presign_get_url(job.output_json_s3_key) if job.output_json_s3_key else None
    output_preview_url = presign_get_url(job.output_preview_s3_key) if job.output_preview_s3_key else None

    return JobStatusResponse(
        job_id=job.id,
        project_id=job.project_id,
        page_id=job.page_id,
        status=job.status,  # type: ignore[arg-type]
        request_id=job.request_id,
        target_lang=job.target_lang,
        provider=job.provider,
        created_at=job.created_at,
        started_at=job.started_at,
        finished_at=job.finished_at,
        error_message=job.error_message,
        input_s3_key=job.input_s3_key,
        output_json_s3_key=job.output_json_s3_key,
        output_preview_s3_key=job.output_preview_s3_key,
        output_json_url=output_json_url,
        output_preview_url=output_preview_url,
        region_count=job.region_count,
    )


@router.patch("/projects/{project_id}/pages/{page_id}/regions/{region_id}", response_model=RegionRead)
async def patch_region(
    project_id: str,
    page_id: str,
    region_id: str,
    payload: RegionPatchRequest,
    db: Session = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
) -> RegionRead:
    project = db.get(Project, project_id)
    if not project or project.owner_id != current_user.user_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found.")

    page = db.get(Page, page_id)
    if not page or page.project_id != project.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Page not found.")

    region = db.get(Region, region_id)
    if not region or region.page_id != page.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Region not found.")

    patch = payload.model_dump(exclude_none=True)
    for key, value in patch.items():
        setattr(region, key, value)
    region.updated_at = utcnow()
    db.add(region)
    db.commit()
    db.refresh(region)

    return RegionRead(
        id=region.id,
        external_region_id=region.external_region_id,
        x=region.x,
        y=region.y,
        width=region.width,
        height=region.height,
        source_text=region.source_text,
        translated_text=region.translated_text,
        confidence=region.confidence,
        review_status=region.review_status,  # type: ignore[arg-type]
        note=region.note,
        updated_at=region.updated_at,
    )


@router.get("/projects/{project_id}/pages/{page_id}/regions", response_model=list[RegionRead])
async def list_regions(
    project_id: str,
    page_id: str,
    db: Session = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
) -> list[RegionRead]:
    project = db.get(Project, project_id)
    if not project or project.owner_id != current_user.user_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found.")
    page = db.get(Page, page_id)
    if not page or page.project_id != project.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Page not found.")
    rows = db.execute(select(Region).where(Region.page_id == page.id).order_by(Region.external_region_id.asc())).scalars().all()
    return [
        RegionRead(
            id=row.id,
            external_region_id=row.external_region_id,
            x=row.x,
            y=row.y,
            width=row.width,
            height=row.height,
            source_text=row.source_text,
            translated_text=row.translated_text,
            confidence=row.confidence,
            review_status=row.review_status,  # type: ignore[arg-type]
            note=row.note,
            updated_at=row.updated_at,
        )
        for row in rows
    ]


@router.get("/projects/{project_id}/pages/{page_id}/artifacts", response_model=ArtifactLinks)
async def get_page_artifacts(
    project_id: str,
    page_id: str,
    db: Session = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
) -> ArtifactLinks:
    project = db.get(Project, project_id)
    if not project or project.owner_id != current_user.user_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found.")

    page = db.get(Page, page_id)
    if not page or page.project_id != project.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Page not found.")

    latest_job = db.execute(
        select(JobRun)
        .where(JobRun.page_id == page.id, JobRun.status == "done")
        .order_by(JobRun.finished_at.desc())
        .limit(1)
    ).scalar_one_or_none()

    return ArtifactLinks(
        input_url=presign_get_url(page.input_s3_key),
        output_json_url=presign_get_url(latest_job.output_json_s3_key)
        if latest_job and latest_job.output_json_s3_key
        else None,
        output_preview_url=presign_get_url(latest_job.output_preview_s3_key)
        if latest_job and latest_job.output_preview_s3_key
        else None,
    )


@router.post("/pipeline/run", response_model=PipelineResponse)
async def run_pipeline_legacy(
    file: UploadFile = File(...),
    target_lang: str = Form("ru"),
    provider: str = Form("stub"),
) -> PipelineResponse:
    raw = await file.read()
    validate_upload(file.content_type, raw, settings.max_upload_mb)
    try:
        return run_pipeline_service(raw, target_lang, provider)
    except Exception as exc:
        pipeline_errors_total.inc()
        raise HTTPException(status_code=500, detail="Pipeline execution failed.") from exc


@router.get("/pipeline/runs", response_model=list[PipelineRunRead])
async def list_runs(db: Session = Depends(get_db)) -> list[PipelineRunRead]:
    rows = (
        db.execute(
            select(JobRun, Page)
            .join(Page, Page.id == JobRun.page_id)
            .order_by(JobRun.created_at.desc())
            .limit(100)
        )
        .all()
    )
    return [
        PipelineRunRead(
            id=job.id,
            file_name=page.file_name,
            target_lang=job.target_lang,
            region_count=job.region_count,
            created_at=job.created_at,
        )
        for job, page in rows
    ]
