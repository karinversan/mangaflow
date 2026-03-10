from __future__ import annotations

import io
import uuid

from PIL import Image
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.db.base import Base
from app.db.models import JobRun, Page, Project, User
from app.schemas.pipeline import MaskPreviewResponse, MaskRegionPayload, PipelineResponse, RegionPayload
from app.worker import process_job


def _png_bytes() -> bytes:
    image = Image.new("RGB", (32, 32), (255, 255, 255))
    out = io.BytesIO()
    image.save(out, format="PNG")
    return out.getvalue()


def test_process_job_persists_results(monkeypatch) -> None:
    engine = create_engine("sqlite+pysqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    TestingSession = sessionmaker(bind=engine, autoflush=False, autocommit=False)

    stored_json = {}
    stored_bytes = {}

    def fake_read_bytes(_key: str) -> bytes:
        return _png_bytes()

    def fake_upload_json(key: str, payload: dict) -> None:
        stored_json[key] = payload

    def fake_upload_bytes(key: str, payload: bytes, _content_type: str) -> None:
        stored_bytes[key] = payload

    def fake_run_pipeline(**_kwargs) -> PipelineResponse:
        return PipelineResponse(
            image_width=32,
            image_height=32,
            regions=[
                RegionPayload(
                    id="t-1",
                    x=10,
                    y=10,
                    width=40,
                    height=20,
                    source_text="a",
                    translated_text="b",
                    confidence=0.9,
                )
            ],
            inpaint_preview_url=None,
        )

    def fake_preview_mask(*_args, **_kwargs) -> MaskPreviewResponse:
        return MaskPreviewResponse(
            image_width=32,
            image_height=32,
            regions=[
                MaskRegionPayload(
                    id="m-1",
                    label="text",
                    x=10,
                    y=10,
                    width=40,
                    height=20,
                    confidence=0.9,
                    polygon=None,
                )
            ],
        )

    monkeypatch.setattr("app.worker.SessionLocal", TestingSession)
    monkeypatch.setattr("app.worker.read_bytes", fake_read_bytes)
    monkeypatch.setattr("app.worker.upload_json", fake_upload_json)
    monkeypatch.setattr("app.worker.upload_bytes", fake_upload_bytes)
    monkeypatch.setattr("app.worker.run_pipeline", fake_run_pipeline)
    monkeypatch.setattr("app.worker.preview_mask_service", fake_preview_mask)

    db = TestingSession()
    try:
        user = User(id="u1", email="u1@example.com")
        project = Project(id=str(uuid.uuid4()), owner_id=user.id, created_by=user.id, updated_by=user.id, name="p")
        page = Page(id=str(uuid.uuid4()), project_id=project.id, page_index=1, file_name="p.png", input_s3_key="input/u1/p/page/p.png")
        job = JobRun(
            id=str(uuid.uuid4()),
            owner_id=user.id,
            created_by=user.id,
            updated_by=user.id,
            project_id=project.id,
            page_id=page.id,
            request_id="req-1",
            provider="custom",
            target_lang="ru",
            status="queued",
            input_s3_key=page.input_s3_key,
            detector_provider="custom",
            detector_model="default",
            detector_version="v1",
            detector_params_json="{}",
            inpainter_provider="custom",
            inpainter_model="default",
            inpainter_version="v1",
            inpainter_params_json="{}",
            ocr_provider="custom",
            ocr_model="default",
            ocr_version="v1",
            ocr_params_json="{}",
            translator_provider="custom",
            translator_model="default",
            translator_version="v1",
            translator_params_json="{}",
        )
        db.add(user)
        db.add(project)
        db.add(page)
        db.add(job)
        db.commit()
        job_id = job.id
    finally:
        db.close()

    process_job(job_id)

    db = TestingSession()
    try:
        refreshed = db.get(JobRun, job_id)
        assert refreshed is not None
        assert refreshed.status == "done"
        assert refreshed.region_count == 1
        assert refreshed.output_json_s3_key is not None
        assert refreshed.mask_s3_key is not None
        assert stored_json
        assert stored_bytes
    finally:
        db.close()
