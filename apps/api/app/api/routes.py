from __future__ import annotations

import logging
import mimetypes
import json
import io
import uuid
import zipfile
from datetime import datetime, timezone
from os.path import basename

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, Query, Response, UploadFile, status

from app.core.auth import AuthUser, create_access_token, get_current_user
from app.core.config import settings
from app.core.file_validation import ALLOWED_CONTENT_TYPES, validate_upload
from app.core.metrics import pipeline_errors_total, pipeline_requests_total
from app.core.rate_limit import enforce_user_rate_limit
from app.db.models import JobEvent, JobOption, JobRun, Page, Project, Region, UserSession
from app.db.session import get_db
from app.schemas.pipeline import (
    ArtifactLinks,
    JobCancelResponse,
    JobCreateResponse,
    JobEventRead,
    JobStatusResponse,
    LastSessionResponse,
    LastSessionUpsertRequest,
    LastSessionUpsertResponse,
    MaskRegionPayload,
    MaskPreviewResponse,
    PipelineResponse,
    PipelineConfigPayload,
    PipelineRunRead,
    ProjectProgressResponse,
    ProviderRead,
    PresignDownloadResponse,
    PresignUploadResponse,
    RegionPatchRequest,
    RegionRead,
    TranslateRequest,
    TranslateResponse,
)
from app.services.job_queue import enqueue_job
from app.services.idempotency import runtime_signature
from app.services.pipeline_orchestrator import resolve_pipeline_config
from app.services.provider_registry import list_providers, provider_health
from app.services.pipeline_service import preview_mask as preview_mask_service
from app.services.pipeline_service import run_pipeline as run_pipeline_service
from app.services.pipeline_service import translate_texts as translate_texts_service
from app.services.providers import inpaint_with_mask_regions
from app.services.storage import build_input_key, key_exists, presign_get_url, presign_put_url, read_bytes, upload_bytes

router = APIRouter()
SUPPORTED_PROVIDERS = {"stub", "huggingface", "custom"}
logger = logging.getLogger(__name__)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _resolve_or_create_project(db: Session, owner_id: str, project_id: str | None, project_name: str) -> Project:
    if project_id:
        project = db.get(Project, project_id)
        if project and project.owner_id == owner_id:
            project.updated_by = owner_id
            return project
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found.")
    project = Project(
        owner_id=owner_id,
        created_by=owner_id,
        updated_by=owner_id,
        name=project_name.strip() or "Untitled project",
    )
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


def _enforce_key_access(owner_id: str, key: str) -> None:
    if key.startswith(f"input/{owner_id}/") or key.startswith(f"output/{owner_id}/"):
        return
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden key access.")


def _normalize_inpaint_options(
    *,
    bubble_expand_px: int | None,
    text_expand_px: int | None,
    bubble_scale: float | None,
    text_scale: float | None,
) -> dict[str, float | int]:
    return {
        "inpaint_bubble_expand_px": max(0, min(120, int(bubble_expand_px or settings.inpaint_bubble_expand_px))),
        "inpaint_text_expand_px": max(0, min(120, int(text_expand_px or settings.inpaint_text_expand_px))),
        "inpaint_bubble_scale": max(0.25, min(4.0, float(bubble_scale or settings.inpaint_bubble_scale))),
        "inpaint_text_scale": max(0.25, min(4.0, float(text_scale or settings.inpaint_text_scale))),
    }


def _append_job_event(
    db: Session,
    *,
    job_id: str,
    status: str,
    message: str | None = None,
    payload: dict | None = None,
) -> None:
    db.add(
        JobEvent(
            job_id=job_id,
            status=status,
            message=message,
            payload_json=json.dumps(payload or {}, ensure_ascii=False),
        )
    )


def _resolve_stage_config_payload(
    *,
    provider: str,
    pipeline_config_json: str | None,
) -> PipelineConfigPayload:
    if pipeline_config_json:
        parsed = PipelineConfigPayload.model_validate_json(pipeline_config_json)
        return parsed
    return PipelineConfigPayload(
        detector={"provider": provider},
        inpainter={"provider": provider},
        ocr={"provider": provider},
        translator={"provider": provider},
    )


@router.post("/storage/presign-upload", response_model=PresignUploadResponse)
async def presign_upload(
    file_name: str = Form(...),
    content_type: str = Form("application/octet-stream"),
    current_user: AuthUser = Depends(get_current_user),
) -> PresignUploadResponse:
    enforce_user_rate_limit(current_user.user_id, bucket="presign-upload", limit=120)
    if content_type not in ALLOWED_CONTENT_TYPES:
        raise HTTPException(status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, detail="Unsupported content type.")
    safe_name = file_name.replace("/", "_")
    key = f"input/{current_user.user_id}/uploads/{uuid.uuid4()}/{safe_name}"
    return PresignUploadResponse(
        key=key,
        url=presign_put_url(key, content_type),
        expires_in_sec=settings.signed_url_expires_sec,
    )


@router.get("/storage/presign-download", response_model=PresignDownloadResponse)
async def presign_download(
    key: str = Query(...),
    current_user: AuthUser = Depends(get_current_user),
) -> PresignDownloadResponse:
    enforce_user_rate_limit(current_user.user_id, bucket="presign-download", limit=240)
    _enforce_key_access(current_user.user_id, key)
    if not key_exists(key):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Artifact not found.")
    return PresignDownloadResponse(
        key=key,
        url=presign_get_url(key),
        expires_in_sec=settings.signed_url_expires_sec,
    )


@router.post("/auth/dev-token")
async def issue_dev_token(user_id: str = Form(...), email: str | None = Form(default=None)) -> dict[str, str]:
    if settings.api_env != "development":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found.")
    token = create_access_token(user_id, email)
    return {"access_token": token, "token_type": "bearer"}


@router.post("/pipeline/jobs", response_model=JobCreateResponse)
async def create_pipeline_job(
    file: UploadFile | None = File(default=None),
    input_s3_key: str | None = Form(default=None),
    target_lang: str = Form("ru"),
    provider: str = Form("custom"),
    request_id: str | None = Form(None),
    project_id: str | None = Form(None),
    project_name: str = Form("Default project"),
    page_index: int = Form(1),
    pipeline_config_json: str | None = Form(default=None),
    inpaint_bubble_expand_px: int | None = Form(default=None),
    inpaint_text_expand_px: int | None = Form(default=None),
    inpaint_bubble_scale: float | None = Form(default=None),
    inpaint_text_scale: float | None = Form(default=None),
    x_request_id: str | None = Header(default=None, alias="X-Request-ID"),
    db: Session = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
) -> JobCreateResponse:
    pipeline_requests_total.inc()
    enforce_user_rate_limit(current_user.user_id, bucket="pipeline-jobs", limit=30)

    if file is None and not input_s3_key:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Provide either file or input_s3_key.")
    if file is not None and input_s3_key:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Use either file or input_s3_key, not both.")

    resolved_request_id = request_id or x_request_id or str(uuid.uuid4())
    if len(resolved_request_id) > 128:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="request_id is too long.")
    if provider not in SUPPORTED_PROVIDERS:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unsupported provider.")

    try:
        requested_cfg = _resolve_stage_config_payload(
            provider=provider,
            pipeline_config_json=pipeline_config_json,
        )
        resolved_cfg = resolve_pipeline_config(requested_cfg.model_dump(exclude_none=True))
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid pipeline_config_json.") from exc

    existing_job = db.execute(
        select(JobRun).where(JobRun.owner_id == current_user.user_id, JobRun.request_id == resolved_request_id)
    ).scalar_one_or_none()
    if existing_job is not None:
        existing_sig = runtime_signature(
            {
                "target_lang": existing_job.target_lang,
                "detector": {
                    "provider": existing_job.detector_provider,
                    "model": existing_job.detector_model,
                    "version": existing_job.detector_version,
                },
                "inpainter": {
                    "provider": existing_job.inpainter_provider,
                    "model": existing_job.inpainter_model,
                    "version": existing_job.inpainter_version,
                },
                "ocr": {
                    "provider": existing_job.ocr_provider,
                    "model": existing_job.ocr_model,
                    "version": existing_job.ocr_version,
                },
                "translator": {
                    "provider": existing_job.translator_provider,
                    "model": existing_job.translator_model,
                    "version": existing_job.translator_version,
                },
            }
        )
        requested_sig = runtime_signature(
            {
                "target_lang": target_lang,
                "detector": {
                    "provider": resolved_cfg.detector.provider,
                    "model": resolved_cfg.detector.model,
                    "version": resolved_cfg.detector.version,
                },
                "inpainter": {
                    "provider": resolved_cfg.inpainter.provider,
                    "model": resolved_cfg.inpainter.model,
                    "version": resolved_cfg.inpainter.version,
                },
                "ocr": {
                    "provider": resolved_cfg.ocr.provider,
                    "model": resolved_cfg.ocr.model,
                    "version": resolved_cfg.ocr.version,
                },
                "translator": {
                    "provider": resolved_cfg.translator.provider,
                    "model": resolved_cfg.translator.model,
                    "version": resolved_cfg.translator.version,
                },
            }
        )
        same_runtime = existing_sig == requested_sig
        same_scope = (project_id is None) or (existing_job.project_id == project_id)
        if not same_runtime or not same_scope:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="request_id already exists with different config.")
        return JobCreateResponse(
            job_id=existing_job.id,
            status=existing_job.status,  # type: ignore[arg-type]
            project_id=existing_job.project_id,
            page_id=existing_job.page_id,
            request_id=existing_job.request_id,
        )

    try:
        inpaint_options = _normalize_inpaint_options(
            bubble_expand_px=inpaint_bubble_expand_px,
            text_expand_px=inpaint_text_expand_px,
            bubble_scale=inpaint_bubble_scale,
            text_scale=inpaint_text_scale,
        )

        project = _resolve_or_create_project(db, current_user.user_id, project_id, project_name)
        if input_s3_key:
            _enforce_key_access(current_user.user_id, input_s3_key)
            if not key_exists(input_s3_key):
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Input object not found.")
            page = _create_page(
                db,
                project=project,
                page_index=page_index,
                file_name=basename(input_s3_key) or "upload.bin",
                input_s3_key=input_s3_key,
            )
            input_key = input_s3_key
        else:
            assert file is not None
            raw = await file.read()
            validate_upload(file.content_type, raw, settings.max_upload_mb, settings.max_image_pixels)
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
            created_by=current_user.user_id,
            updated_by=current_user.user_id,
            project_id=project.id,
            page_id=page.id,
            request_id=resolved_request_id,
            provider=provider,
            target_lang=target_lang,
            status="queued",
            input_s3_key=input_key,
            detector_provider=resolved_cfg.detector.provider,
            detector_model=resolved_cfg.detector.model,
            detector_version=resolved_cfg.detector.version,
            detector_params_json=json.dumps(resolved_cfg.detector.params, ensure_ascii=False),
            inpainter_provider=resolved_cfg.inpainter.provider,
            inpainter_model=resolved_cfg.inpainter.model,
            inpainter_version=resolved_cfg.inpainter.version,
            inpainter_params_json=json.dumps(resolved_cfg.inpainter.params, ensure_ascii=False),
            ocr_provider=resolved_cfg.ocr.provider,
            ocr_model=resolved_cfg.ocr.model,
            ocr_version=resolved_cfg.ocr.version,
            ocr_params_json=json.dumps(resolved_cfg.ocr.params, ensure_ascii=False),
            translator_provider=resolved_cfg.translator.provider,
            translator_model=resolved_cfg.translator.model,
            translator_version=resolved_cfg.translator.version,
            translator_params_json=json.dumps(resolved_cfg.translator.params, ensure_ascii=False),
        )
        db.add(job)
        db.flush()
        _append_job_event(
            db,
            job_id=job.id,
            status="queued",
            message="Job accepted.",
            payload={"request_id": resolved_request_id},
        )
        db.add(
            JobOption(
                job_id=job.id,
                inpaint_bubble_expand_px=int(inpaint_options["inpaint_bubble_expand_px"]),
                inpaint_text_expand_px=int(inpaint_options["inpaint_text_expand_px"]),
                inpaint_bubble_scale=float(inpaint_options["inpaint_bubble_scale"]),
                inpaint_text_scale=float(inpaint_options["inpaint_text_scale"]),
            )
        )
        session = db.get(UserSession, current_user.user_id)
        if session is None:
            session = UserSession(user_id=current_user.user_id)
        session.project_id = project.id
        session.page_id = page.id
        session.file_name = page.file_name
        session.view_params_json = "{}"
        db.add(session)
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
        logger.exception("Failed to create pipeline job for user_id=%s", current_user.user_id)
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
    mask_url = presign_get_url(job.mask_s3_key) if job.mask_s3_key else None
    inpainted_url = presign_get_url(job.inpainted_s3_key) if job.inpainted_s3_key else None

    return JobStatusResponse(
        job_id=job.id,
        project_id=job.project_id,
        page_id=job.page_id,
        status=job.status,  # type: ignore[arg-type]
        request_id=job.request_id,
        target_lang=job.target_lang,
        provider=job.provider,
        detector_provider=job.detector_provider,
        detector_model=job.detector_model,
        detector_version=job.detector_version,
        inpainter_provider=job.inpainter_provider,
        inpainter_model=job.inpainter_model,
        inpainter_version=job.inpainter_version,
        ocr_provider=job.ocr_provider,
        ocr_model=job.ocr_model,
        ocr_version=job.ocr_version,
        translator_provider=job.translator_provider,
        translator_model=job.translator_model,
        translator_version=job.translator_version,
        attempts=job.attempts,
        created_at=job.created_at,
        started_at=job.started_at,
        finished_at=job.finished_at,
        cancel_requested_at=job.cancel_requested_at,
        canceled_at=job.canceled_at,
        error_message=job.error_message,
        input_s3_key=job.input_s3_key,
        mask_s3_key=job.mask_s3_key,
        inpainted_s3_key=job.inpainted_s3_key,
        output_json_s3_key=job.output_json_s3_key,
        output_preview_s3_key=job.output_preview_s3_key,
        mask_url=mask_url,
        inpainted_url=inpainted_url,
        output_json_url=output_json_url,
        output_preview_url=output_preview_url,
        region_count=job.region_count,
    )


@router.post("/pipeline/jobs/{job_id}/cancel", response_model=JobCancelResponse)
async def cancel_pipeline_job(
    job_id: str,
    db: Session = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
) -> JobCancelResponse:
    job = db.get(JobRun, job_id)
    if not job or job.owner_id != current_user.user_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found.")

    if job.status in {"done", "failed", "canceled"}:
        return JobCancelResponse(job_id=job.id, status=job.status)  # type: ignore[arg-type]

    now = utcnow()
    if job.status == "queued":
        job.status = "canceled"
        job.canceled_at = now
        job.updated_by = current_user.user_id
        _append_job_event(db, job_id=job.id, status="canceled", message="Canceled before execution.")
    else:
        job.status = "cancel_requested"
        job.cancel_requested_at = now
        job.updated_by = current_user.user_id
        _append_job_event(db, job_id=job.id, status="cancel_requested", message="Cancellation requested.")
    db.add(job)
    db.commit()
    return JobCancelResponse(job_id=job.id, status=job.status)  # type: ignore[arg-type]


@router.get("/pipeline/jobs/{job_id}/events", response_model=list[JobEventRead])
async def list_pipeline_job_events(
    job_id: str,
    db: Session = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
) -> list[JobEventRead]:
    job = db.get(JobRun, job_id)
    if not job or job.owner_id != current_user.user_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found.")
    rows = (
        db.execute(select(JobEvent).where(JobEvent.job_id == job.id).order_by(JobEvent.created_at.asc()))
        .scalars()
        .all()
    )
    out: list[JobEventRead] = []
    for row in rows:
        try:
            payload = json.loads(row.payload_json or "{}")
            if not isinstance(payload, dict):
                payload = {}
        except Exception:
            payload = {}
        out.append(
            JobEventRead(
                id=row.id,
                status=row.status,
                message=row.message,
                payload_json=payload,
                created_at=row.created_at,
            )
        )
    return out


@router.get("/projects/{project_id}/progress", response_model=ProjectProgressResponse)
async def get_project_progress(
    project_id: str,
    db: Session = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
) -> ProjectProgressResponse:
    project = db.get(Project, project_id)
    if not project or project.owner_id != current_user.user_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found.")

    total_pages = int(
        db.execute(select(func.count()).select_from(Page).where(Page.project_id == project.id)).scalar_one()
    )
    latest_jobs = (
        db.execute(
            select(JobRun)
            .where(JobRun.project_id == project.id)
            .order_by(JobRun.page_id.asc(), JobRun.created_at.desc())
        )
        .scalars()
        .all()
    )
    latest_by_page: dict[str, JobRun] = {}
    for job in latest_jobs:
        latest_by_page.setdefault(job.page_id, job)

    counters = {
        "queued": 0,
        "running": 0,
        "retrying": 0,
        "done": 0,
        "failed": 0,
        "canceled": 0,
    }
    for job in latest_by_page.values():
        key = job.status if job.status in counters else "failed"
        counters[key] += 1

    processed_pages = counters["done"] + counters["failed"] + counters["canceled"]
    return ProjectProgressResponse(
        project_id=project.id,
        total_pages=total_pages,
        queued=counters["queued"],
        running=counters["running"],
        retrying=counters["retrying"],
        done=counters["done"],
        failed=counters["failed"],
        canceled=counters["canceled"],
        processed_pages=processed_pages,
    )


@router.get("/providers", response_model=list[ProviderRead])
async def get_provider_catalog() -> list[ProviderRead]:
    out: list[ProviderRead] = []
    for item in list_providers():
        health = provider_health(item["name"])
        out.append(
            ProviderRead(
                name=item["name"],
                enabled=item["enabled"],
                stages=item["stages"],
                model=item["model"],
                version=item["version"],
                capabilities=item["capabilities"],
                health={
                    "provider": health.provider,
                    "ready": health.ready,
                    "latency_ms": health.latency_ms,
                    "error_rate": health.error_rate,
                    "checks": health.checks,
                },
            )
        )
    return out


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
        mask_url=presign_get_url(latest_job.mask_s3_key)
        if latest_job and latest_job.mask_s3_key
        else None,
        inpainted_url=presign_get_url(latest_job.inpainted_s3_key)
        if latest_job and latest_job.inpainted_s3_key
        else None,
        output_json_url=presign_get_url(latest_job.output_json_s3_key)
        if latest_job and latest_job.output_json_s3_key
        else None,
        output_preview_url=presign_get_url(latest_job.output_preview_s3_key)
        if latest_job and latest_job.output_preview_s3_key
        else None,
    )


@router.get("/projects/{project_id}/pages/{page_id}/input")
async def get_page_input(
    project_id: str,
    page_id: str,
    db: Session = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
) -> Response:
    project = db.get(Project, project_id)
    if not project or project.owner_id != current_user.user_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found.")

    page = db.get(Page, page_id)
    if not page or page.project_id != project.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Page not found.")

    _enforce_key_access(current_user.user_id, page.input_s3_key)
    if not key_exists(page.input_s3_key):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Input object not found.")

    payload = read_bytes(page.input_s3_key)
    content_type = mimetypes.guess_type(page.file_name or "")[0] or "application/octet-stream"
    return Response(content=payload, media_type=content_type)


@router.get("/projects/{project_id}/pages/{page_id}/preview")
async def get_page_preview(
    project_id: str,
    page_id: str,
    db: Session = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
) -> Response:
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
    if latest_job is None or not latest_job.output_preview_s3_key:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Preview not found.")

    preview_key = latest_job.output_preview_s3_key
    _enforce_key_access(current_user.user_id, preview_key)
    if not key_exists(preview_key):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Preview object not found.")

    payload = read_bytes(preview_key)
    return Response(content=payload, media_type="image/png")


@router.get("/projects/{project_id}/export.zip")
async def export_project_zip(
    project_id: str,
    db: Session = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
) -> Response:
    project = db.get(Project, project_id)
    if not project or project.owner_id != current_user.user_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found.")

    pages = (
        db.execute(select(Page).where(Page.project_id == project.id).order_by(Page.page_index.asc()))
        .scalars()
        .all()
    )
    if not pages:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Project has no pages.")

    archive = io.BytesIO()
    manifest: dict[str, object] = {
        "project_id": project.id,
        "project_name": project.name,
        "exported_at": utcnow().isoformat(),
        "pages": [],
    }
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for page in pages:
            latest_job = db.execute(
                select(JobRun)
                .where(JobRun.page_id == page.id, JobRun.status == "done")
                .order_by(JobRun.finished_at.desc())
                .limit(1)
            ).scalar_one_or_none()

            image_key = page.input_s3_key
            if latest_job and latest_job.inpainted_s3_key:
                image_key = latest_job.inpainted_s3_key
            elif latest_job and latest_job.output_preview_s3_key:
                image_key = latest_job.output_preview_s3_key

            image_bytes = read_bytes(image_key)
            image_name = f"images/page-{page.page_index:03d}.png"
            zf.writestr(image_name, image_bytes)

            regions = (
                db.execute(select(Region).where(Region.page_id == page.id).order_by(Region.external_region_id.asc()))
                .scalars()
                .all()
            )
            region_payload = [
                {
                    "external_region_id": row.external_region_id,
                    "x": row.x,
                    "y": row.y,
                    "width": row.width,
                    "height": row.height,
                    "source_text": row.source_text,
                    "translated_text": row.translated_text,
                    "confidence": row.confidence,
                    "review_status": row.review_status,
                    "note": row.note,
                }
                for row in regions
            ]

            page_meta = {
                "page_id": page.id,
                "page_index": page.page_index,
                "file_name": page.file_name,
                "image": image_name,
                "regions": region_payload,
                "runtime": {
                    "detector": {
                        "provider": latest_job.detector_provider if latest_job else None,
                        "model": latest_job.detector_model if latest_job else None,
                        "version": latest_job.detector_version if latest_job else None,
                    },
                    "inpainter": {
                        "provider": latest_job.inpainter_provider if latest_job else None,
                        "model": latest_job.inpainter_model if latest_job else None,
                        "version": latest_job.inpainter_version if latest_job else None,
                    },
                    "ocr": {
                        "provider": latest_job.ocr_provider if latest_job else None,
                        "model": latest_job.ocr_model if latest_job else None,
                        "version": latest_job.ocr_version if latest_job else None,
                    },
                    "translator": {
                        "provider": latest_job.translator_provider if latest_job else None,
                        "model": latest_job.translator_model if latest_job else None,
                        "version": latest_job.translator_version if latest_job else None,
                    },
                },
            }
            zf.writestr(
                f"metadata/page-{page.page_index:03d}.json",
                json.dumps(page_meta, ensure_ascii=False, indent=2),
            )
            manifest_pages = manifest.get("pages")
            if isinstance(manifest_pages, list):
                manifest_pages.append(page_meta)
        zf.writestr("metadata/project.json", json.dumps(manifest, ensure_ascii=False, indent=2))

    return Response(
        content=archive.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{project.name or "project"}-export.zip"'},
    )


@router.post("/pipeline/mask-preview", response_model=MaskPreviewResponse)
async def preview_mask(
    file: UploadFile = File(...),
    provider: str = Form("custom"),
    inpaint_bubble_expand_px: int | None = Form(default=None),
    inpaint_text_expand_px: int | None = Form(default=None),
    inpaint_bubble_scale: float | None = Form(default=None),
    inpaint_text_scale: float | None = Form(default=None),
) -> MaskPreviewResponse:
    raw = await file.read()
    validate_upload(file.content_type, raw, settings.max_upload_mb, settings.max_image_pixels)
    if provider not in SUPPORTED_PROVIDERS:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unsupported provider.")
    options = _normalize_inpaint_options(
        bubble_expand_px=inpaint_bubble_expand_px,
        text_expand_px=inpaint_text_expand_px,
        bubble_scale=inpaint_bubble_scale,
        text_scale=inpaint_text_scale,
    )
    try:
        return preview_mask_service(raw, provider, options=options)
    except Exception as exc:
        pipeline_errors_total.inc()
        raise HTTPException(status_code=500, detail="Mask preview failed.") from exc


@router.post("/pipeline/inpaint-preview")
async def inpaint_preview(
    file: UploadFile = File(...),
    regions_json: str = Form(...),
) -> Response:
    raw = await file.read()
    validate_upload(file.content_type, raw, settings.max_upload_mb, settings.max_image_pixels)
    try:
        raw_regions = json.loads(regions_json)
        regions = [MaskRegionPayload.model_validate(item) for item in raw_regions]
        preview = inpaint_with_mask_regions(raw, regions)
        if preview is None:
            return Response(content=raw, media_type=file.content_type or "image/png")
        return Response(content=preview, media_type="image/png")
    except Exception as exc:
        pipeline_errors_total.inc()
        raise HTTPException(status_code=500, detail="Inpaint preview failed.") from exc


@router.post("/pipeline/translate", response_model=TranslateResponse)
async def translate_texts(payload: TranslateRequest) -> TranslateResponse:
    if payload.provider not in SUPPORTED_PROVIDERS:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unsupported provider.")
    try:
        translated = translate_texts_service(payload.texts, payload.target_lang, payload.provider)
        return TranslateResponse(translated_texts=translated)
    except Exception as exc:
        pipeline_errors_total.inc()
        raise HTTPException(status_code=500, detail="Translation failed.") from exc


@router.post("/pipeline/run", response_model=PipelineResponse)
async def run_pipeline_legacy(
    file: UploadFile = File(...),
    target_lang: str = Form("ru"),
    provider: str = Form("custom"),
) -> PipelineResponse:
    raw = await file.read()
    validate_upload(file.content_type, raw, settings.max_upload_mb, settings.max_image_pixels)
    if provider not in SUPPORTED_PROVIDERS:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unsupported provider.")
    try:
        return run_pipeline_service(raw, target_lang, provider)
    except Exception as exc:
        pipeline_errors_total.inc()
        raise HTTPException(status_code=500, detail="Pipeline execution failed.") from exc


@router.get("/pipeline/runs", response_model=list[PipelineRunRead])
async def list_runs(
    db: Session = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
) -> list[PipelineRunRead]:
    rows = (
        db.execute(
            select(JobRun, Page)
            .join(Page, Page.id == JobRun.page_id)
            .where(JobRun.owner_id == current_user.user_id)
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


@router.get("/me/last-session", response_model=LastSessionResponse)
async def get_last_session(
    db: Session = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
) -> LastSessionResponse:
    session = db.get(UserSession, current_user.user_id)
    if session is not None:
        try:
            view_params = json.loads(session.view_params_json or "{}")
            if not isinstance(view_params, dict):
                view_params = {}
        except Exception:
            view_params = {}
        return LastSessionResponse(
            project_id=session.project_id,
            page_id=session.page_id,
            file_name=session.file_name,
            view_params=view_params,
        )

    row = (
        db.execute(
            select(JobRun, Page)
            .join(Page, Page.id == JobRun.page_id)
            .where(JobRun.owner_id == current_user.user_id)
            .order_by(JobRun.created_at.desc())
            .limit(1)
        )
        .first()
    )
    if not row:
        return LastSessionResponse()
    job, page = row
    return LastSessionResponse(project_id=job.project_id, page_id=job.page_id, file_name=page.file_name, view_params={})


@router.post("/me/last-session", response_model=LastSessionUpsertResponse)
async def upsert_last_session(
    payload: LastSessionUpsertRequest,
    db: Session = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
) -> LastSessionUpsertResponse:
    if payload.project_id:
        project = db.get(Project, payload.project_id)
        if not project or project.owner_id != current_user.user_id:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found.")
    if payload.page_id and payload.project_id:
        page = db.get(Page, payload.page_id)
        if not page or page.project_id != payload.project_id:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Page not found.")

    session = db.get(UserSession, current_user.user_id)
    if session is None:
        session = UserSession(user_id=current_user.user_id)
    session.project_id = payload.project_id
    session.page_id = payload.page_id
    session.file_name = payload.file_name
    session.view_params_json = json.dumps(payload.view_params, ensure_ascii=False)
    db.add(session)
    db.commit()
    return LastSessionUpsertResponse(ok=True)
