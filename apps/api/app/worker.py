from __future__ import annotations

import base64
import io
import json
import logging
import time
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.core.config import settings
from app.core.metrics import (
    pipeline_dead_letter_total,
    pipeline_errors_total,
    pipeline_job_duration_seconds,
    pipeline_jobs_running,
    pipeline_queue_length,
    pipeline_retries_total,
    pipeline_workers_active,
)
from app.db.base import Base
from app.db.migrate import run_migrations
from PIL import Image, ImageDraw

from app.db.models import JobEvent, JobOption, JobRun, Page, Region, UserSession
from app.db.session import SessionLocal, engine
from app.services.job_queue import enqueue_dead_letter, enqueue_job, pop_job, queue_length
from app.services.pipeline_service import preview_mask as preview_mask_service
from app.services.pipeline_service import run_pipeline
from app.services.storage import (
    build_output_inpainted_key,
    build_output_json_key,
    build_output_mask_key,
    build_output_preview_key,
    read_bytes,
    upload_bytes,
    upload_json,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("pipeline-worker")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _append_job_event(
    db,
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


def _render_mask_png(file_bytes: bytes, mask_regions) -> bytes:
    with Image.open(io.BytesIO(file_bytes)) as image:
        rgb = image.convert("RGB")
        w, h = rgb.size
        mask = Image.new("L", (w, h), 0)
        draw = ImageDraw.Draw(mask)
        for region in mask_regions:
            if region.polygon and len(region.polygon) >= 3:
                poly = [((pt.x / 100) * w, (pt.y / 100) * h) for pt in region.polygon]
                draw.polygon(poly, fill=255)
                continue
            x1 = int((region.x / 100) * w)
            y1 = int((region.y / 100) * h)
            x2 = int(((region.x + region.width) / 100) * w)
            y2 = int(((region.y + region.height) / 100) * h)
            if x2 <= x1 or y2 <= y1:
                continue
            draw.rectangle([(x1, y1), (x2, y2)], fill=255)
        out = io.BytesIO()
        mask.save(out, format="PNG")
        return out.getvalue()


def _safe_json_dict(raw: str) -> dict:
    try:
        parsed = json.loads(raw or "{}")
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        return {}


def _upsert_regions(db, page_id: str, regions_payload) -> int:
    count = 0
    for region in regions_payload:
        existing = db.execute(
            select(Region).where(Region.page_id == page_id, Region.external_region_id == region.id)
        ).scalar_one_or_none()
        if existing:
            existing.x = region.x
            existing.y = region.y
            existing.width = region.width
            existing.height = region.height
            existing.source_text = region.source_text
            existing.translated_text = region.translated_text
            existing.confidence = region.confidence
            existing.updated_at = utcnow()
            db.add(existing)
        else:
            db.add(
                Region(
                    page_id=page_id,
                    external_region_id=region.id,
                    x=region.x,
                    y=region.y,
                    width=region.width,
                    height=region.height,
                    source_text=region.source_text,
                    translated_text=region.translated_text,
                    confidence=region.confidence,
                    review_status="todo",
                    note="",
                )
            )
        count += 1
    return count


def _decode_png_data_url(payload: str) -> bytes | None:
    prefix = "data:image/png;base64,"
    if not payload.startswith(prefix):
        return None
    encoded = payload[len(prefix) :]
    try:
        return base64.b64decode(encoded, validate=True)
    except Exception:
        logger.warning("Failed to decode inpaint preview data URL")
        return None


def process_job(job_id: str) -> None:
    db = SessionLocal()
    started = time.perf_counter()
    pipeline_jobs_running.inc()
    try:
        job = db.get(JobRun, job_id)
        if not job:
            return
        if job.status in {"canceled", "done", "failed"}:
            return
        if job.status == "cancel_requested":
            job.status = "canceled"
            job.canceled_at = utcnow()
            job.updated_by = job.owner_id
            _append_job_event(db, job_id=job.id, status="canceled", message="Canceled before starting worker execution.")
            db.add(job)
            db.commit()
            return
        job.status = "running"
        job.started_at = utcnow()
        job.last_heartbeat_at = utcnow()
        job.attempts += 1
        job.updated_by = job.owner_id
        _append_job_event(db, job_id=job.id, status="running", message="Worker started processing.")
        db.add(job)
        db.commit()
        logger.info(
            "job_start job_id=%s project_id=%s request_id=%s provider=%s attempts=%s",
            job.id,
            job.project_id,
            job.request_id,
            job.provider,
            job.attempts,
        )

        options_row = db.get(JobOption, job.id)
        options: dict[str, float | int] | None = None
        if options_row is not None:
            options = {
                "inpaint_bubble_expand_px": options_row.inpaint_bubble_expand_px,
                "inpaint_text_expand_px": options_row.inpaint_text_expand_px,
                "inpaint_bubble_scale": options_row.inpaint_bubble_scale,
                "inpaint_text_scale": options_row.inpaint_text_scale,
            }

        stage_config = {
            "detector": {
                "provider": job.detector_provider,
                "model": job.detector_model,
                "version": job.detector_version,
                "params": _safe_json_dict(job.detector_params_json),
            },
            "inpainter": {
                "provider": job.inpainter_provider,
                "model": job.inpainter_model,
                "version": job.inpainter_version,
                "params": _safe_json_dict(job.inpainter_params_json),
            },
            "ocr": {
                "provider": job.ocr_provider,
                "model": job.ocr_model,
                "version": job.ocr_version,
                "params": _safe_json_dict(job.ocr_params_json),
            },
            "translator": {
                "provider": job.translator_provider,
                "model": job.translator_model,
                "version": job.translator_version,
                "params": _safe_json_dict(job.translator_params_json),
            },
        }

        file_bytes = read_bytes(job.input_s3_key)
        db.refresh(job)
        if job.status == "cancel_requested":
            job.status = "canceled"
            job.canceled_at = utcnow()
            job.updated_by = job.owner_id
            _append_job_event(db, job_id=job.id, status="canceled", message="Canceled before pipeline run.")
            db.add(job)
            db.commit()
            return

        result = run_pipeline(
            file_bytes=file_bytes,
            target_lang=job.target_lang,
            provider_name=job.provider,
            options=options,
            stage_config=stage_config,
        )

        out_key = build_output_json_key(job.owner_id, job.project_id, job.page_id, job.id)
        result_payload = result.model_dump()
        # Large preview data URLs are stored as a separate image artifact.
        result_payload["inpaint_preview_url"] = None
        upload_json(out_key, result_payload)
        preview_key: str | None = None
        inpainted_key: str | None = None
        if result.inpaint_preview_url:
            preview_bytes = _decode_png_data_url(result.inpaint_preview_url)
            if preview_bytes:
                preview_key = build_output_preview_key(job.owner_id, job.project_id, job.page_id, job.id)
                upload_bytes(preview_key, preview_bytes, "image/png")
                inpainted_key = build_output_inpainted_key(job.owner_id, job.project_id, job.page_id, job.id)
                upload_bytes(inpainted_key, preview_bytes, "image/png")

        mask_key: str | None = None
        try:
            mask_preview = preview_mask_service(file_bytes, job.detector_provider, options=options)
            mask_png = _render_mask_png(file_bytes, mask_preview.regions)
            mask_key = build_output_mask_key(job.owner_id, job.project_id, job.page_id, job.id)
            upload_bytes(mask_key, mask_png, "image/png")
        except Exception:
            logger.exception("Failed to render mask artifact for job %s", job.id)

        count = _upsert_regions(db, job.page_id, result.regions)
        db.refresh(job)
        if job.status == "cancel_requested":
            job.status = "canceled"
            job.canceled_at = utcnow()
            job.updated_by = job.owner_id
            _append_job_event(db, job_id=job.id, status="canceled", message="Canceled after pipeline execution.")
            db.add(job)
            db.commit()
            return

        session = db.get(UserSession, job.owner_id)
        if session is None:
            session = UserSession(user_id=job.owner_id)
        session.project_id = job.project_id
        session.page_id = job.page_id
        page = db.get(Page, job.page_id)
        session.file_name = page.file_name if page else session.file_name
        session.view_params_json = "{}"
        db.add(session)
        job.output_json_s3_key = out_key
        job.output_preview_s3_key = preview_key
        job.mask_s3_key = mask_key
        job.inpainted_s3_key = inpainted_key
        job.region_count = count
        job.error_message = None
        job.status = "done"
        job.finished_at = utcnow()
        job.updated_by = job.owner_id
        _append_job_event(db, job_id=job.id, status="done", message="Job completed.", payload={"region_count": count})
        db.add(job)
        db.commit()
        logger.info(
            "job_done job_id=%s project_id=%s request_id=%s provider=%s regions=%s",
            job.id,
            job.project_id,
            job.request_id,
            job.provider,
            count,
        )
    except Exception as exc:
        db.rollback()
        pipeline_errors_total.inc()
        logger.exception("Worker failed job %s", job_id)
        job = db.get(JobRun, job_id)
        if job:
            if job.attempts < settings.pipeline_max_attempts:
                job.status = "retrying"
                job.error_message = str(exc)
                job.started_at = None
                job.last_heartbeat_at = utcnow()
                job.updated_by = job.owner_id
                _append_job_event(
                    db,
                    job_id=job.id,
                    status="retrying",
                    message="Job will be retried.",
                    payload={"attempt": job.attempts},
                )
                db.add(job)
                db.commit()
                pipeline_retries_total.inc()
                job.status = "queued"
                db.add(job)
                db.commit()
                enqueue_job(job.id)
                logger.warning(
                    "job_retry job_id=%s project_id=%s request_id=%s provider=%s attempt=%s error=%s",
                    job.id,
                    job.project_id,
                    job.request_id,
                    job.provider,
                    job.attempts,
                    str(exc),
                )
            else:
                job.status = "failed"
                job.error_message = str(exc)
                job.finished_at = utcnow()
                job.updated_by = job.owner_id
                _append_job_event(db, job_id=job.id, status="failed", message=str(exc))
                db.add(job)
                db.commit()
                pipeline_dead_letter_total.inc()
                enqueue_dead_letter(
                    {
                        "job_id": job.id,
                        "owner_id": job.owner_id,
                        "project_id": job.project_id,
                        "page_id": job.page_id,
                        "attempts": job.attempts,
                        "error": str(exc),
                        "failed_at": utcnow().isoformat(),
                    }
                )
                logger.error(
                    "job_failed job_id=%s project_id=%s request_id=%s provider=%s attempts=%s error=%s",
                    job.id,
                    job.project_id,
                    job.request_id,
                    job.provider,
                    job.attempts,
                    str(exc),
                )
    finally:
        elapsed = time.perf_counter() - started
        pipeline_job_duration_seconds.observe(elapsed)
        pipeline_jobs_running.dec()
        db.close()


def recover_stale_jobs() -> None:
    db = SessionLocal()
    try:
        now = utcnow()
        stale_cutoff = now.timestamp() - settings.pipeline_stale_running_sec
        running_jobs = (
            db.execute(
                select(JobRun).where(JobRun.status.in_(["running", "retrying", "cancel_requested"]))
            )
            .scalars()
            .all()
        )
        for job in running_jobs:
            last_ts = (job.last_heartbeat_at or job.started_at or job.updated_at or now).timestamp()
            is_stale = last_ts <= stale_cutoff
            if job.status == "cancel_requested":
                job.status = "canceled"
                job.canceled_at = now
                job.updated_by = job.owner_id
                _append_job_event(db, job_id=job.id, status="canceled", message="Recovered canceled job on worker startup.")
                db.add(job)
                continue
            if job.status == "retrying":
                job.status = "queued"
                job.updated_by = job.owner_id
                _append_job_event(db, job_id=job.id, status="queued", message="Recovered retrying job on worker startup.")
                db.add(job)
                enqueue_job(job.id)
                continue
            if not is_stale:
                continue
            if job.attempts < settings.pipeline_max_attempts:
                job.status = "queued"
                job.started_at = None
                job.last_heartbeat_at = now
                job.error_message = "Recovered stale running job after worker restart."
                job.updated_by = job.owner_id
                _append_job_event(db, job_id=job.id, status="queued", message="Recovered stale running job.")
                db.add(job)
                enqueue_job(job.id)
            else:
                job.status = "failed"
                job.error_message = "Job marked failed during startup recovery (max attempts reached)."
                job.finished_at = now
                job.updated_by = job.owner_id
                _append_job_event(db, job_id=job.id, status="failed", message="Recovered stale job exceeded max attempts.")
                db.add(job)
        db.commit()
    finally:
        db.close()


def run() -> None:
    run_migrations(engine)
    try:
        Base.metadata.create_all(bind=engine)
    except IntegrityError:
        logger.warning("Concurrent metadata create_all detected in worker, retrying.")
        Base.metadata.create_all(bind=engine)
    recover_stale_jobs()
    pipeline_workers_active.set(1)
    logger.info("Pipeline worker started, queue=%s", settings.pipeline_queue_name)
    while True:
        pipeline_queue_length.set(queue_length())
        job_id = pop_job(timeout_sec=3)
        if not job_id:
            continue
        process_job(job_id)


if __name__ == "__main__":
    run()
