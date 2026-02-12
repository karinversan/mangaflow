from __future__ import annotations

import logging
import time
from datetime import datetime, timezone

from sqlalchemy import select

from app.core.config import settings
from app.core.metrics import pipeline_errors_total, pipeline_job_duration_seconds, pipeline_jobs_running, pipeline_queue_length
from app.db.base import Base
from app.db.models import JobRun, Region
from app.db.session import SessionLocal, engine
from app.services.job_queue import pop_job, queue_length
from app.services.pipeline_service import run_pipeline
from app.services.storage import build_output_json_key, read_bytes, upload_json

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("pipeline-worker")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


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


def process_job(job_id: str) -> None:
    db = SessionLocal()
    started = time.perf_counter()
    pipeline_jobs_running.inc()
    try:
        job = db.get(JobRun, job_id)
        if not job:
            return
        job.status = "running"
        job.started_at = utcnow()
        job.attempts += 1
        db.add(job)
        db.commit()

        file_bytes = read_bytes(job.input_s3_key)
        result = run_pipeline(file_bytes=file_bytes, target_lang=job.target_lang, provider_name=job.provider)

        out_key = build_output_json_key(job.owner_id, job.project_id, job.page_id, job.id)
        upload_json(out_key, result.model_dump())

        count = _upsert_regions(db, job.page_id, result.regions)
        job.output_json_s3_key = out_key
        job.output_preview_s3_key = None
        job.region_count = count
        job.error_message = None
        job.status = "done"
        job.finished_at = utcnow()
        db.add(job)
        db.commit()
    except Exception as exc:
        db.rollback()
        pipeline_errors_total.inc()
        logger.exception("Worker failed job %s", job_id)
        job = db.get(JobRun, job_id)
        if job:
            job.status = "failed"
            job.error_message = str(exc)
            job.finished_at = utcnow()
            db.add(job)
            db.commit()
    finally:
        elapsed = time.perf_counter() - started
        pipeline_job_duration_seconds.observe(elapsed)
        pipeline_jobs_running.dec()
        db.close()


def run() -> None:
    Base.metadata.create_all(bind=engine)
    logger.info("Pipeline worker started, queue=%s", settings.pipeline_queue_name)
    while True:
        pipeline_queue_length.set(queue_length())
        job_id = pop_job(timeout_sec=3)
        if not job_id:
            continue
        process_job(job_id)


if __name__ == "__main__":
    run()
