from datetime import datetime

from pydantic import BaseModel, Field


class Region(BaseModel):
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
    regions: list[Region]
    inpaint_preview_url: str | None = None


class PipelineRunRead(BaseModel):
    id: str
    file_name: str
    target_lang: str
    region_count: int
    created_at: datetime
