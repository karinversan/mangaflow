from __future__ import annotations

from datetime import datetime
from typing import Any
from typing import Literal

from pydantic import BaseModel, Field


class RegionPayload(BaseModel):
    id: str
    x: float = Field(ge=0, le=100)
    y: float = Field(ge=0, le=100)
    width: float = Field(ge=0, le=100)
    height: float = Field(ge=0, le=100)
    source_text: str
    translated_text: str
    confidence: float = Field(ge=0, le=1)


class PipelineResponse(BaseModel):
    image_width: int
    image_height: int
    regions: list[RegionPayload]
    inpaint_preview_url: str | None = None


class PointPayload(BaseModel):
    x: float = Field(ge=0, le=100)
    y: float = Field(ge=0, le=100)


class MaskRegionPayload(BaseModel):
    id: str
    label: Literal["bubble", "text"]
    x: float = Field(ge=0, le=100)
    y: float = Field(ge=0, le=100)
    width: float = Field(ge=0, le=100)
    height: float = Field(ge=0, le=100)
    confidence: float = Field(ge=0, le=1)
    polygon: list[PointPayload] | None = None


class MaskPreviewResponse(BaseModel):
    image_width: int
    image_height: int
    regions: list[MaskRegionPayload]


class TranslateRequest(BaseModel):
    provider: Literal["stub", "huggingface", "custom"] = "custom"
    target_lang: str = "ru"
    texts: list[str]


class TranslateResponse(BaseModel):
    translated_texts: list[str]


class JobCreateResponse(BaseModel):
    job_id: str
    status: Literal["queued", "running", "retrying", "done", "failed", "cancel_requested", "canceled"]
    project_id: str
    page_id: str
    request_id: str


class StageConfigPayload(BaseModel):
    provider: str
    model: str = "default"
    version: str = "v1"
    params: dict[str, Any] = Field(default_factory=dict)


class PipelineConfigPayload(BaseModel):
    detector: StageConfigPayload | None = None
    inpainter: StageConfigPayload | None = None
    ocr: StageConfigPayload | None = None
    translator: StageConfigPayload | None = None


class JobStatusResponse(BaseModel):
    job_id: str
    project_id: str
    page_id: str
    status: Literal["queued", "running", "retrying", "done", "failed", "cancel_requested", "canceled"]
    request_id: str
    target_lang: str
    provider: str
    detector_provider: str
    detector_model: str
    detector_version: str
    inpainter_provider: str
    inpainter_model: str
    inpainter_version: str
    ocr_provider: str
    ocr_model: str
    ocr_version: str
    translator_provider: str
    translator_model: str
    translator_version: str
    attempts: int = 0
    created_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None
    cancel_requested_at: datetime | None = None
    canceled_at: datetime | None = None
    error_message: str | None = None
    input_s3_key: str
    mask_s3_key: str | None = None
    inpainted_s3_key: str | None = None
    output_json_s3_key: str | None = None
    output_preview_s3_key: str | None = None
    mask_url: str | None = None
    inpainted_url: str | None = None
    output_json_url: str | None = None
    output_preview_url: str | None = None
    region_count: int = 0


class RegionRead(BaseModel):
    id: str
    external_region_id: str
    x: float
    y: float
    width: float
    height: float
    source_text: str
    translated_text: str
    confidence: float
    review_status: Literal["todo", "edited", "approved"]
    note: str
    updated_at: datetime


class RegionPatchRequest(BaseModel):
    translated_text: str | None = None
    review_status: Literal["todo", "edited", "approved"] | None = None
    note: str | None = None
    x: float | None = Field(default=None, ge=0, le=100)
    y: float | None = Field(default=None, ge=0, le=100)
    width: float | None = Field(default=None, ge=0, le=100)
    height: float | None = Field(default=None, ge=0, le=100)


class ArtifactLinks(BaseModel):
    input_url: str
    mask_url: str | None = None
    inpainted_url: str | None = None
    output_json_url: str | None = None
    output_preview_url: str | None = None


class PipelineRunRead(BaseModel):
    id: str
    file_name: str
    target_lang: str
    region_count: int
    created_at: datetime


class PresignUploadResponse(BaseModel):
    key: str
    url: str
    expires_in_sec: int


class PresignDownloadResponse(BaseModel):
    key: str
    url: str
    expires_in_sec: int


class LastSessionResponse(BaseModel):
    project_id: str | None = None
    page_id: str | None = None
    file_name: str | None = None
    view_params: dict[str, Any] = Field(default_factory=dict)


class LastSessionUpsertRequest(BaseModel):
    project_id: str | None = None
    page_id: str | None = None
    file_name: str | None = None
    view_params: dict[str, Any] = Field(default_factory=dict)


class LastSessionUpsertResponse(BaseModel):
    ok: bool = True


class ProjectProgressResponse(BaseModel):
    project_id: str
    total_pages: int
    queued: int
    running: int
    retrying: int
    done: int
    failed: int
    canceled: int
    processed_pages: int


class JobCancelResponse(BaseModel):
    job_id: str
    status: Literal["cancel_requested", "canceled", "done", "failed"]


class JobEventRead(BaseModel):
    id: str
    status: str
    message: str | None = None
    payload_json: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime


class ProviderHealthRead(BaseModel):
    provider: str
    ready: bool
    latency_ms: float
    error_rate: float
    checks: dict[str, Any]


class ProviderRead(BaseModel):
    name: str
    enabled: bool
    stages: list[str]
    model: str
    version: str
    capabilities: list[str]
    health: ProviderHealthRead
