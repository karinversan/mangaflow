from __future__ import annotations

from datetime import datetime
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


class JobCreateResponse(BaseModel):
    job_id: str
    status: Literal["queued", "running", "done", "failed"]
    project_id: str
    page_id: str
    request_id: str


class JobStatusResponse(BaseModel):
    job_id: str
    project_id: str
    page_id: str
    status: Literal["queued", "running", "done", "failed"]
    request_id: str
    target_lang: str
    provider: str
    created_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None
    error_message: str | None = None
    input_s3_key: str
    output_json_s3_key: str | None = None
    output_preview_s3_key: str | None = None
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
    output_json_url: str | None = None
    output_preview_url: str | None = None


class PipelineRunRead(BaseModel):
    id: str
    file_name: str
    target_lang: str
    region_count: int
    created_at: datetime
